import type { Message, Transport } from "@/email/send";
import { EMAIL_SKIP_AT, type LogEntry } from "./rung";

/**
 * reportError(): email the owner when a route throws in production (story #43).
 *
 * docs/charter.md's whole observability requirement is "errors emailed to the owner; nothing
 * else", and Vercel Hobby offers no email alerting — so this rides the existing sender. The
 * failure it exists to catch is the one nobody is watching for: an hour down on a Sunday
 * morning, when the club is sailing and nobody is at a laptop.
 *
 * WHY THIS ONE IS SHAPED UNLIKE THE OTHER SIX SENDERS. Every other sender here is told about a
 * thing that has already been written and stands — a post, an answer, a match, a message, a
 * confirmation, an invite — and can read the database to decide what to say. This one is
 * reached BECAUSE something failed, and the thing that failed may well be the database:
 *
 *   - **The dedupe is kept in two places, and they are blind to different failures.** A
 *     module-scope Map (`recent`, injected here so the rule is testable) bounds the volume
 *     inside one running instance and keeps working when Supabase does not; the database carries
 *     it across instances, which the Map cannot, because Vercel may run several and each starts
 *     empty. A store call that THROWS is not fatal: the Map is still enforcing one-per-hour, so
 *     the report goes out rather than being lost to the outage it is reporting. Owner decision at
 *     pickup, 2026-09-20.
 *   - **Both halves are taken BEFORE anything is awaited on them (#198).** The Map slot is set
 *     the moment a report passes it, and the database half ends in a CLAIM (0030) — a write
 *     Postgres arbitrates, just before the send — rather than only in the `notification_log`
 *     read, whose row lands after the provider answers. Until #198 both were check-then-act
 *     across awaits: one failed request that threw from two places emailed the owner twice, 4 ms
 *     apart, on one instance (measured in Supabase's edge log, 2026-09-22). The log read stays,
 *     as the cheap path for the ordinary repeat.
 *   - **Both windows measure ATTEMPTS, not successful sends** — the opposite of notifyAnswer(),
 *     whose window deliberately starts only on a send the provider accepted so a refusal is
 *     retried on the next answer. The reason the rule inverts here is what a repeat costs. An
 *     answer email refused means a skipper heard nothing about something that happened once; an
 *     error email refused means a symptom that is still happening, on every request, so
 *     retrying it per request spends the day's cap on mail the provider is not delivering
 *     anyway. One attempt an hour per signature is the bound, whatever the provider said.
 *   - **It is addressed to an env var, not to a person row.** `notification_log.person_id` and
 *     `post_id` are null for the same reason they are on an invite (#31): the recipient is the
 *     owner's inbox, not a member. OWNER_EMAIL rather than `club.admin_email` on purpose — the
 *     address must be readable when the database is not.
 *
 * Pure over its inputs, like every module here: the store, the transport, `now`, the owner's
 * address and the Map are injected, so the tests pin the clock and count sends exactly
 * (AC 2's fake clock).
 */

/** One error email attempted — accepted or refused by the provider; `error` says which (AC 1). */
export const KIND_ERROR = "error";
/** An error that found the day's cap already spent: no email, this row and a console.error (AC 3). */
export const KIND_ERROR_SKIPPED_CAP = "error_skipped_cap";

/**
 * How long one signature stays quiet after an attempt (AC 2). The issue names an hour and
 * nothing has re-derived it: long enough that a route failing on every request costs one email,
 * short enough that an outage still lands in the inbox while it is happening.
 */
export const ERROR_EMAIL_WINDOW_MS = 60 * 60 * 1000;

/** How many lines of the stack the email carries (AC 1). */
export const STACK_LINES = 20;

/**
 * What the hook hands over, already narrowed out of `unknown` (src/instrumentation.ts).
 *
 * `path` is the request path with ANY QUERY STRING REMOVED, and that is a requirement rather
 * than a tidy-up: `/auth/callback?code=…`, `/join?code=…` and a password-reset link all carry a
 * secret in the query, and this value is copied into an inbox and into `notification_log`, which
 * the admin screens read. `routePath` is the route file's template (`/post/[id]`), which is what
 * the signature keys on so a route failing for twenty different posts is one error and not
 * twenty.
 */
export type ErrorReport = {
  /** The error's constructor name, e.g. `TypeError`. `Error` when it was not an Error at all. */
  name: string;
  message: string;
  /** The stack as thrown, or null. Trimmed to STACK_LINES lines by the message builder. */
  stack: string | null;
  /** `GET`, `POST`, … */
  method: string;
  /** The request path, query string removed. */
  path: string;
  /** The route file's template — the stable half of the signature. */
  routePath: string;
  /** Where it threw: a render, a route handler, a Server Action, the proxy. */
  routeType: string;
  /** React's digest, when it processed the error. Used to recognise Next's own control flow. */
  digest: string | null;
};

/**
 * Narrow what the hook is handed into an ErrorReport. Lives here, in the pure module, rather
 * than in `src/instrumentation.ts`: that file imports `error-live.ts`, which imports
 * `server-only`, which THROWS when a plain node test imports it — so anything in it is
 * untestable by construction (the same reason `kinds.test.ts` reads `store.ts` as text). The
 * hook itself is left as an adapter with no logic in it at all.
 *
 * Typed structurally rather than against `Instrumentation.onRequestError` so the pure module
 * needs no `next` import; `src/instrumentation.ts` carries the real signature and would stop
 * compiling if these drifted apart.
 *
 * `error` is `unknown` because Next says so, and because React may hand over something that is
 * not the original throw at all — hence `digest`, which is the only handle on what it was.
 */
export function toReport(
  error: unknown,
  request: { path: string; method: string },
  context: { routePath: string; routeType: string },
): ErrorReport {
  const err = error instanceof Error ? error : null;
  const digest = typeof error === "object" && error !== null && "digest" in error ? String((error as { digest: unknown }).digest) : null;
  return {
    name: err?.name || "Error",
    message: err?.message ?? String(error),
    stack: err?.stack ?? null,
    method: request.method || "GET",
    path: stripQuery(request.path),
    routePath: context.routePath || stripQuery(request.path),
    routeType: context.routeType || "unknown",
    digest,
  };
}

/**
 * Everything from the first `?` or `#` on, gone. A reset link, an invite code and the PKCE code
 * on `/auth/callback` all live in a query string, and this value reaches the owner's inbox and
 * `notification_log`. Owner decision at pickup, 2026-09-20: the concrete path is worth carrying,
 * its query string is not.
 */
export function stripQuery(path: string): string {
  return path.split(/[?#]/)[0] || path;
}

/**
 * Digests Next uses for control flow rather than for failure. `notFound()` and `redirect()`
 * throw, and a 404 is not an incident — emailing the owner about one would be a mail a week from
 * `/admin/dates/[id]` alone.
 *
 * Next already filters these before it calls the hook: `getDigestForWellKnownError` in
 * `node_modules/next/dist/server/app-render/create-error-handler.js` returns early for a router
 * error, a bail-out-to-CSR, a dynamic-server error and a prerender interruption, and the hook is
 * only reached past that point (read 2026-09-20, Next 16.3.5). This is a second lock on the same
 * door: the check is four lines, it costs nothing, and it is OUR check rather than a behaviour of
 * a dependency that a minor release may move.
 */
const CONTROL_FLOW_DIGESTS = ["NEXT_NOT_FOUND", "NEXT_REDIRECT", "NEXT_HTTP_ERROR_FALLBACK", "DYNAMIC_SERVER_USAGE", "BAILOUT_TO_CLIENT_SIDE_RENDERING"];

export function isControlFlow(report: ErrorReport): boolean {
  const marks = [report.digest ?? "", report.message];
  return CONTROL_FLOW_DIGESTS.some((d) => marks.some((m) => m.startsWith(d)));
}

/**
 * What one error is, for the purpose of "have I already said this?" (AC 2). The error's NAME and
 * the ROUTE, per the issue — not the message, which carries the id or the value that differed and
 * would make every occurrence distinct, which is the same as having no dedupe at all.
 */
export function signatureOf(report: ErrorReport): string {
  return `${report.name} ${report.routePath}`;
}

/** The store's `log`, plus the signature the dedupe reads back (0025). */
export type ErrorLogEntry = LogEntry & { signature: string | null };

/** What a claim on a signature's window answered (0030's `claim_error_report`). */
export type WindowClaim = {
  /** True when THIS call took the window — it is the one that may send. */
  won: boolean;
  /** When the window's holder claimed it: this call's own `at` when won, the winner's otherwise. */
  heldSince: Date;
};

export interface ErrorStore {
  /** When an error email for this signature was last ATTEMPTED, or null if never. */
  lastErrorEmailAt(signature: string): Promise<Date | null>;
  /**
   * Take the signature's window for this attempt, atomically across instances (#198): won unless
   * another claim on the same signature falls after `since`. The last gate before the send.
   */
  claimWindow(signature: string, at: Date, since: Date): Promise<WindowClaim>;
  /** Email sends attempted so far in the day `now` falls in, all kinds — the cap's count. */
  emailsSentToday(now: Date): Promise<number>;
  log(entry: ErrorLogEntry): Promise<void>;
}

export type ErrorReportDeps = {
  store: ErrorStore;
  transport: Transport;
  now: Date;
  /** Where the mail goes — OWNER_EMAIL. Null when the deployment has not set it. */
  ownerEmail: string | null;
  /**
   * The in-process half of the dedupe: signature → the ms of the last attempt. Module-scope in
   * error-live.ts so it survives between requests on a warm instance; injected here so a test
   * owns it. Expired entries are pruned on every call, so it cannot grow without bound.
   */
  recent: Map<string, number>;
};

export type ErrorReportResult = {
  signature: string;
  /** What happened. Exactly one of these, and the reporter's whole observable behaviour. */
  state:
    | "sent"
    | "refused" // the provider said no; logged with the error, and the window still starts
    | "suppressed" // inside the hour for this signature
    | "skipped_cap" // the day's email budget is spent (AC 3)
    | "ignored" // Next's own control flow: notFound(), redirect()
    | "unconfigured"; // no OWNER_EMAIL on this deployment
  /** Which dedupe caught it, when state is "suppressed" — useful to a test, and to the log. */
  suppressedBy?: "memory" | "log" | "claim";
};

/** What the owner reads. Exported so the copy is tested, not so anything else sends it. */
export function errorEmail(report: ErrorReport, to: string, now: Date): Message {
  const stack = (report.stack ?? "").split("\n").slice(0, STACK_LINES).join("\n").trimEnd();
  return {
    to,
    subject: `Tender error: ${report.name} at ${report.routePath}`,
    text: [
      `${report.method} ${report.path}`,
      `route  ${report.routePath} (${report.routeType})`,
      `when   ${now.toISOString()}`,
      ``,
      `${report.name}: ${report.message}`,
      ``,
      stack || `(no stack)`,
      ``,
      `Further reports of this error are suppressed for one hour.`,
      `Tender — the crew board.`,
    ].join("\n"),
  };
}

/** Drop entries older than the window, so a long-lived instance holds only live signatures. */
function prune(recent: Map<string, number>, now: number): void {
  for (const [sig, at] of recent) if (now - at >= ERROR_EMAIL_WINDOW_MS) recent.delete(sig);
}

/**
 * Report one error. The order of the four refusals is the order of the ACs, with the two cheapest
 * and most outage-proof first:
 *
 *   1. Next's own control flow — not an error at all, and decided from the report alone.
 *   2. No OWNER_EMAIL — nothing to send to. A console.error, and no log row: nothing was
 *      attempted, and a row per request on a misconfigured deployment is its own storm.
 *   3. The in-process window (AC 2). No store read, no log row — during a Supabase outage this
 *      is the branch that runs, and it must not write to the thing that is down. Passing it takes
 *      it, synchronously (#198).
 *   4. The logged window (AC 2, across instances) and then the day's cap (AC 3). Both reads are
 *      best-effort: a throw means the database cannot answer, which is itself consistent with
 *      why we are here, so the report proceeds on the in-process window alone.
 *   5. The claim (#198): the cross-instance window, taken atomically just before the send. Lost,
 *      it suppresses; thrown, it is best-effort like the reads.
 */
export async function reportError(report: ErrorReport, deps: ErrorReportDeps): Promise<ErrorReportResult> {
  const { store, transport, now, ownerEmail, recent } = deps;
  const signature = signatureOf(report);

  if (isControlFlow(report)) return { signature, state: "ignored" };

  if (!ownerEmail) {
    // Say it where the function log can still show it for an hour, which is all Hobby keeps.
    console.error(`tender error (OWNER_EMAIL unset, not emailed): ${signature}: ${report.message}`);
    return { signature, state: "unconfigured" };
  }

  const at = now.getTime();
  prune(recent, at);
  const seen = recent.get(signature);
  if (seen !== undefined && at - seen < ERROR_EMAIL_WINDOW_MS) {
    return { signature, state: "suppressed", suppressedBy: "memory" };
  }
  // Take the in-process window NOW, before the first await (#198). Every line below awaits the
  // store, and a second report of the same signature arriving during those awaits — one failed
  // request throwing from two places, measured on 2026-09-22 — must find it taken. Written after
  // the reads, as it was until #198, both reports passed this check and the owner got two emails.
  // The branches below may move it to an earlier instant (a logged or claimed attempt elsewhere);
  // none of them clears it.
  recent.set(signature, at);

  // Across instances. A read that throws leaves `last` null and the send goes ahead — the
  // in-process window above is still bounding it, and silence during a database outage is the
  // one outcome this story cannot accept.
  let last: Date | null = null;
  try {
    last = await store.lastErrorEmailAt(signature);
  } catch (e) {
    console.error(`tender error reporter: could not read the log:`, e instanceof Error ? e.message : e);
  }
  if (last !== null && at - last.getTime() < ERROR_EMAIL_WINDOW_MS) {
    // Remember it in process too, so the next occurrence on this instance costs no read at all.
    recent.set(signature, last.getTime());
    return { signature, state: "suppressed", suppressedBy: "log" };
  }

  // AC 3 — the day's cap. Same best-effort reasoning: a count that cannot be read is not a
  // reason to stay quiet. EMAIL_SKIP_AT rather than EMAIL_DAY_CAP: the five-slot headroom is
  // reserved for the identity mail Resend sends outside this log, and an error report is not
  // entitled to spend it (src/notify/rung.ts).
  let sentToday = 0;
  try {
    sentToday = await store.emailsSentToday(now);
  } catch (e) {
    console.error(`tender error reporter: could not count today's email:`, e instanceof Error ? e.message : e);
  }
  if (sentToday >= EMAIL_SKIP_AT) {
    console.error(`tender error (cap reached, not emailed): ${signature}: ${report.message}`);
    await logQuietly(store, {
      kind: KIND_ERROR_SKIPPED_CAP,
      channel: "email",
      personId: null,
      toEmail: ownerEmail,
      postId: null,
      providerId: null,
      error: null,
      signature,
    });
    return { signature, state: "skipped_cap" };
  }

  // Across instances, EXACTLY (#198, owner decision at pickup). The log read above cannot see an
  // attempt still in flight elsewhere — its row is written after the provider answers, ~3 s
  // measured — so two instances failing inside one send's latency would both get here. The claim
  // is a write the database arbitrates: of two concurrent claims on one signature, one wins.
  // Best-effort like the reads: a claim that throws means the database cannot answer, and the send
  // goes ahead on the in-process window alone rather than falling silent during an outage.
  try {
    const claim = await store.claimWindow(signature, now, new Date(at - ERROR_EMAIL_WINDOW_MS));
    if (!claim.won) {
      // The holder's instant, so this instance's window ends when the real one does.
      recent.set(signature, claim.heldSince.getTime());
      return { signature, state: "suppressed", suppressedBy: "claim" };
    }
  } catch (e) {
    console.error(`tender error reporter: could not claim the window:`, e instanceof Error ? e.message : e);
  }

  // The window started on the ATTEMPT — in process at the top, across instances at the claim —
  // before the provider is called: a transport that hangs and then rejects must not let the next
  // request through as though nothing had been tried.
  try {
    const { id } = await transport.send(errorEmail(report, ownerEmail, now));
    await logQuietly(store, { kind: KIND_ERROR, channel: "email", personId: null, toEmail: ownerEmail, postId: null, providerId: id, error: null, signature });
    return { signature, state: "sent" };
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    console.error(`tender error (email refused: ${error}): ${signature}: ${report.message}`);
    await logQuietly(store, { kind: KIND_ERROR, channel: "email", personId: null, toEmail: ownerEmail, postId: null, providerId: null, error, signature });
    return { signature, state: "refused" };
  }
}

/**
 * Write the log row, and swallow a failure. Every other sender lets the store throw, because
 * there the caller is a Server Action that can report it. Here the caller is the error hook: a
 * throw would replace the symptom we are reporting with a symptom of the reporter, and the
 * email has already gone either way.
 */
async function logQuietly(store: ErrorStore, entry: ErrorLogEntry): Promise<void> {
  try {
    await store.log(entry);
  } catch (e) {
    console.error(`tender error reporter: could not log ${entry.kind}:`, e instanceof Error ? e.message : e);
  }
}
