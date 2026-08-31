import { RUNG_COLOUR } from "@/board/post-view";
import { whenLabel } from "@/dates/race-date";
import type { Rung } from "@/engine/ladder";
import type { RungPost } from "@/notify/rung";

/**
 * What a crew's phone shows when a post reaches their rung (story #29 AC 5).
 *
 * Pure, and separate from the transport, for the same reason `rungMessage()` is separate from
 * Resend: the copy is the part worth testing and it must not need a push service to read.
 *
 * THE 4 KB LIMIT IS REAL AND IT IS THE PROTOCOL'S, not a house style. RFC 8291 caps an encrypted
 * push payload at 4096 bytes, and browsers enforce it — a longer one is rejected by the push
 * service rather than truncated, so the notification simply never arrives. The one field here
 * that a person controls is the boat's name (80 characters, 0006) and the class name, so this
 * cannot realistically overflow; `encodePush` asserts it anyway, because the failure mode is a
 * notification that silently does not happen and this is the only place that could catch it.
 *
 * The rung shown is the CREW's own rung, not the post's open one. They differ: a post open to
 * rung 3 still has rung-1 crew on it, and "rung 1 · green" is the true and useful thing to tell
 * that person — it is how the board already labels them, so the two surfaces agree.
 */

/** RFC 8291's ceiling on an encrypted payload. */
export const PUSH_PAYLOAD_MAX_BYTES = 4096;

export type PushPayload = {
  title: string;
  body: string;
  /** Where a tap goes. Relative, so the service worker resolves it against its own origin. */
  url: string;
  /**
   * Collapses repeats for the same post on one device. A crew whose rung is reached, and who is
   * then pushed again by a later story, sees one notification updated rather than a stack.
   */
  tag: string;
};

export function rungPush(post: RungPost, rung: Rung): PushPayload {
  const colour = RUNG_COLOUR[rung].name;
  return {
    title: `Crew needed: ${post.boatName} (${post.boatClass})`,
    body: `${whenLabel(post.startsAt)} · Rung ${rung} · ${colour}`,
    url: `/post/${post.id}`,
    tag: `post-${post.id}`,
  };
}

/**
 * What a skipper's phone shows when crew answer their post (story #24).
 *
 * The tag is `post-<id>-answer`, DISTINCT from rungPush's `post-<id>`: the two are different
 * messages to different people about one post, and must not collapse into each other — while
 * repeated answers on one post SHOULD collapse, into a single notification whose count
 * updates. That collapse is why push needs no suppression window: the device shows one entry
 * either way, and the latest count is the one worth showing (the story's premise is "accept
 * before they change their mind", so the freshest number wins).
 */
export function answerPush(post: RungPost, count: number): PushPayload {
  return {
    title: `${count} crew answered: ${post.boatName} (${post.boatClass})`,
    body: `${whenLabel(post.startsAt)} · tap to accept`,
    url: `/post/${post.id}`,
    tag: `post-${post.id}-answer`,
  };
}

/**
 * The wire form. Throws rather than sending something the push service will reject — a caller
 * that let this through would log a success for a notification nobody received.
 */
export function encodePush(payload: PushPayload): string {
  const json = JSON.stringify(payload);
  const bytes = new TextEncoder().encode(json).length;
  if (bytes > PUSH_PAYLOAD_MAX_BYTES) {
    throw new Error(`push payload is ${bytes} bytes, over RFC 8291's ${PUSH_PAYLOAD_MAX_BYTES}`);
  }
  return json;
}
