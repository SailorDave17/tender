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
 * How many characters of a message body the push preview carries (story #35).
 *
 * THIS IS THE ONE PAYLOAD FIELD A PERSON CONTROLS AT LENGTH. Everywhere else the variable text
 * is a boat name (80 characters, 0006) or a class name, which is why the 4 KB ceiling has so
 * far been unreachable in practice; a message body is 2,000 characters by 0020's own check, and
 * a 2,000-character body plus the title and URL would still fit — but only just, and only while
 * nothing else grows. Truncating here means the ceiling is never approached rather than
 * defended, and a preview is what a notification is for: the thread has the rest.
 */
export const PUSH_BODY_PREVIEW_CHARS = 120;

/**
 * What a party's phone shows when their counterparty says something (story #35 AC 3).
 *
 * The tag is `thread-<matchId>`, distinct from both post tags above and shared by every message
 * in one thread — so a burst collapses into ONE notification on the device whose content
 * updates, which is the whole reason push needs no suppression window while email does. The
 * author's name is in the title rather than the body so it survives a truncated preview.
 */
export function messagePush(post: RungPost, authorName: string, body: string, matchId: string): PushPayload {
  const trimmed = body.trim();
  const preview =
    trimmed.length > PUSH_BODY_PREVIEW_CHARS ? `${trimmed.slice(0, PUSH_BODY_PREVIEW_CHARS - 1)}…` : trimmed;
  return {
    title: `${authorName}: ${post.boatName}`,
    body: preview,
    url: `/post/${post.id}/thread`,
    // `matchId` is REQUIRED, and was optional with a `?? post.id` fallback until a review found
    // that the production caller passed three arguments while only the tests passed the fourth —
    // so the shipped tag was `thread-<postId>` while this docstring said `thread-<matchId>`, and
    // deleting the parameter reddened nothing. It was accidentally right only because
    // `match.post_id` is unique, which is the 1:1 that 0020's own header argues not to lean on.
    // Required rather than defaulted so the next such omission is a typecheck failure instead of
    // a behaviour that is wrong only in a future the schema currently forbids: an optional
    // parameter whose only callers that pass it are tests has a load-bearing, untested default.
    tag: `thread-${matchId}`,
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
