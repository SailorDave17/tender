import "server-only";
import { headers } from "next/headers";
import { resendTransport } from "@/email/send";
import { dispatchPending, notifyRung, type NotifyResult, type RungPost } from "./rung";
import { supabaseRungStore } from "./store";

/**
 * notifyRung() with the live dependencies, for the two Server Actions that call it (post
 * create, availability mark). The site URL in the email is this request's origin — the same
 * way /api/join builds the magic link's redirect — so a local stack emails localhost links and
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

export async function notifyRungLive(postId: string): Promise<NotifyResult | null> {
  try {
    return await notifyRung(postId, {
      store: supabaseRungStore(),
      transport: resendTransport(),
      now: new Date(),
      siteUrl: await siteUrl(),
    });
  } catch (e) {
    console.error(`notifyRung(${postId}) failed:`, e instanceof Error ? e.message : e);
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
      now: new Date(),
      siteUrl: await siteUrl(),
    });
  } catch (e) {
    console.error(`dispatchPending(${post.id}) failed:`, e instanceof Error ? e.message : e);
  }
}
