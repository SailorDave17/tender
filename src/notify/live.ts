import "server-only";
import { headers } from "next/headers";
import { resendTransport } from "@/email/send";
import { notifyRung, type NotifyResult } from "./rung";
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
export async function notifyRungLive(postId: string): Promise<NotifyResult | null> {
  try {
    const h = await headers();
    const origin = h.get("origin") ?? `${h.get("x-forwarded-proto") ?? "https"}://${h.get("host") ?? "tender.madcowsailing.com"}`;
    return await notifyRung(postId, {
      store: supabaseRungStore(),
      transport: resendTransport(),
      now: new Date(),
      siteUrl: origin,
    });
  } catch (e) {
    console.error(`notifyRung(${postId}) failed:`, e instanceof Error ? e.message : e);
    return null;
  }
}
