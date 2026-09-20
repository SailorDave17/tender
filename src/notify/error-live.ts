import "server-only";
import { resendTransport } from "@/email/send";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { KIND_ERROR, reportError, type ErrorLogEntry, type ErrorReport, type ErrorReportResult, type ErrorStore } from "./error";
import { EMAIL_ATTEMPT_KINDS } from "./kinds";
import { emailDayStart } from "./rung";

/**
 * The live half of story #43's error reporter: the store over `notification_log` as the service
 * role, and the wrapper `src/instrumentation.ts` calls.
 *
 * WHY THIS IS NOT IN store.ts AND live.ts WITH THE OTHER SIX. Those two modules are the import
 * graph of the whole notification system — `next/headers`, the board's pool view, the calendar,
 * the morning-of engine, six stores. Everything imported by `instrumentation.ts` is loaded before
 * the server handles a request, and this is the one caller that is reached BECAUSE something
 * broke: a reporter whose module graph can itself fail to load, or which needs a request scope
 * that no longer exists, is a reporter that goes quiet exactly when it is needed. So its graph is
 * four modules deep and holds nothing that reads a request.
 *
 * `siteUrl()` is the concrete case rather than a worry: `live.ts` builds every other email's link
 * from `headers()`, which throws outside a request scope. The error email carries no link, which
 * is why it can be sent from the hook at all.
 */

/** Where the report goes. Absent on a deployment that has not set it, which reportError() states. */
function ownerEmail(): string | null {
  const value = process.env.OWNER_EMAIL?.trim();
  return value ? value : null;
}

/**
 * The in-process half of the dedupe (AC 2), at module scope so it survives between requests on a
 * warm instance. Deliberately NOT the whole dedupe — a cold start empties it and Vercel may run
 * several instances, which is what the `notification_log` read in the store below is for.
 */
const recent = new Map<string, number>();

export function supabaseErrorStore(): ErrorStore {
  const admin = supabaseAdmin();
  return {
    async lastErrorEmailAt(signature) {
      // Attempts, not successes — `error` is NOT filtered here, unlike the answer store's
      // window. src/notify/error.ts's header says why the rule inverts for this sender.
      const { data, error } = await admin
        .from("notification_log")
        .select("sent_at")
        .eq("kind", KIND_ERROR)
        .eq("channel", "email")
        .eq("signature", signature)
        .order("sent_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw new Error(`error store: read last error email: ${error.message}`);
      return data ? new Date(data.sent_at) : null;
    },

    async emailsSentToday(now) {
      // Every attempt kind, from the one list (src/notify/kinds.ts), as the match, message,
      // confirm and invite stores read it: the cap is Resend's and counts every send.
      const { count, error } = await admin
        .from("notification_log")
        .select("id", { count: "exact", head: true })
        .eq("channel", "email")
        .in("kind", EMAIL_ATTEMPT_KINDS)
        .gte("sent_at", emailDayStart(now).toISOString());
      if (error) throw new Error(`error store: count today's email: ${error.message}`);
      return count ?? 0;
    },

    async log(entry: ErrorLogEntry) {
      const { error } = await admin.from("notification_log").insert({
        kind: entry.kind,
        channel: entry.channel,
        person_id: entry.personId,
        to_email: entry.toEmail,
        post_id: entry.postId,
        provider_id: entry.providerId,
        error: entry.error,
        signature: entry.signature,
      });
      if (error) throw new Error(`error store: log: ${error.message}`);
    },
  };
}

/**
 * reportError() with the live dependencies, for the error hook (story #43).
 *
 * Swallows everything, and more completely than the five `…Live` wrappers in live.ts. Those
 * swallow so a notification failure cannot undo a row that already stands; this one swallows
 * because it is the LAST handler — a throw here is an error raised while reporting an error, and
 * the only place it could go is the hook Next already wraps in a try/catch of its own
 * (`instrumentationOnRequestError`, base-server.js). Every failure inside reportError() is
 * already caught and logged at the point it happens; this is the belt for the module-level ones,
 * a missing service-role key or Resend key above all — both throw at construction, before a line
 * of reportError() runs. (Neither is named literally here on purpose: `notify-call-sites.test.ts`
 * asserts that the provider key is read in exactly one file, by grepping for its name, and a
 * comment mentioning it would read as a second reader.)
 */
export async function reportErrorLive(report: ErrorReport): Promise<ErrorReportResult | null> {
  try {
    return await reportError(report, {
      store: supabaseErrorStore(),
      transport: resendTransport(),
      now: new Date(),
      ownerEmail: ownerEmail(),
      recent,
    });
  } catch (e) {
    console.error(`reportError(${report.name} at ${report.routePath}) failed:`, e instanceof Error ? e.message : e);
    return null;
  }
}
