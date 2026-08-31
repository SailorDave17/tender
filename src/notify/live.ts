import "server-only";
import { headers } from "next/headers";
import { resendTransport } from "@/email/send";
import { webPushTransport, type PushTransport } from "@/push/send";
import { notifyAnswer, type AnswerNotifyResult } from "./answer";
import { dispatchPending, notifyRung, type NotifyResult, type RungPost } from "./rung";
import { supabaseAnswerStore, supabaseRungStore } from "./store";

/**
 * notifyRung() with the live dependencies, for the two Server Actions that call it (post
 * create, availability mark). The site URL in the email is this request's origin — the same
 * way /api/forgot builds the reset link's redirect — so a local stack emails localhost links and
 * production emails its own.
 *
 * A failure here is logged and swallowed on purpose: the post or the availability row is
 * already written and stands, and a notification that could not be attempted must not undo it
 * or show the skipper an error about something they did not do. The record is
 * notification_log where the store reached it and the function log where it did not;
 * surfacing the latter to the owner is #43's story.
 */
async function siteUrl(): Promise<string> {
  const h = await headers();
  return h.get("origin") ?? `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host") ?? "tender.madcowsailing.com"}`;
}

/**
 * The push transport, or nothing when this deployment has no VAPID keys (story #29).
 *
 * `webPushTransport()` throws on a missing key, and that throw must not reach the caller: both
 * call sites below swallow to a console warning, so a project with no push keys would lose its
 * EMAIL too — the channel that works — over the absence of the one that does not. So the absence
 * is caught here and turned into "no push", which is exactly ADR 007's stated fallback.
 *
 * The warning is deliberate and one line. Silence here is the `documented-is-not-installed`
 * shape: push would simply never happen, on a deployment where every artefact says it should,
 * with no error anywhere. Turning a missing name into a startup failure is #65's job.
 */
function livePushTransport(): PushTransport | undefined {
  try {
    return webPushTransport();
  } catch (e) {
    console.warn("web push is not configured, sending email only:", e instanceof Error ? e.message : e);
    return undefined;
  }
}

export async function notifyRungLive(postId: string): Promise<NotifyResult | null> {
  try {
    return await notifyRung(postId, {
      store: supabaseRungStore(),
      transport: resendTransport(),
      push: livePushTransport(),
      now: new Date(),
      siteUrl: await siteUrl(),
    });
  } catch (e) {
    console.error(`notifyRung(${postId}) failed:`, e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * notifyAnswer() with the live dependencies, for the answer Server Action (story #24). Same
 * swallow as notifyRungLive and for the same reason: the answer row is already written and
 * stands, and a notification that could not be attempted must not undo it or show the CREW an
 * error about the skipper's inbox.
 */
export async function notifyAnswerLive(postId: string): Promise<AnswerNotifyResult | null> {
  try {
    return await notifyAnswer(postId, {
      store: supabaseAnswerStore(),
      transport: resendTransport(),
      push: livePushTransport(),
      now: new Date(),
      siteUrl: await siteUrl(),
    });
  } catch (e) {
    console.error(`notifyAnswer(${postId}) failed:`, e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * Dispatch alone, for the ladder tick (story #25): `runTick()` has already widened the post and
 * written the suggestion rows, so all that is left is to email whoever is pending. Same store,
 * same transport, same origin rule, same swallow — a post whose send throws must not abort the
 * pass over the other posts, and the tick has already done the work that matters.
 */
export async function dispatchPendingLive(post: RungPost): Promise<void> {
  try {
    await dispatchPending(post, {
      store: supabaseRungStore(),
      transport: resendTransport(),
      push: livePushTransport(),
      now: new Date(),
      siteUrl: await siteUrl(),
    });
  } catch (e) {
    console.error(`dispatchPending(${post.id}) failed:`, e instanceof Error ? e.message : e);
  }
}
