import "server-only";
import { headers } from "next/headers";
import { resendTransport } from "@/email/send";
import { webPushTransport, type PushTransport } from "@/push/send";
import { runMorningOf, type MorningMatch } from "@/engine/morningOf";
import { supabaseMorningOfRepo } from "@/engine/morning-store";
import { notifyAnswer, type AnswerNotifyResult } from "./answer";
import { notifyConfirmed, remindCrew, type ConfirmNotifyResult } from "./confirm";
import { sendInvites, type InviteResult } from "./invite";
import { notifyMatch, type MatchNotifyResult } from "./match";
import { notifyMessage, type MessageNotifyResult } from "./message";
import { dispatchPending, notifyRung, type NotifyResult, type RungPost } from "./rung";
import { supabaseAnswerStore, supabaseConfirmStore, supabaseInviteStore, supabaseMatchStore, supabaseMessageStore, supabaseRungStore } from "./store";

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
 * notifyMatch() with the live dependencies, for the accept Server Action (story #33). Same
 * swallow as the two above and for the same reason: accept_answer() has already written the
 * match and closed the post, and an email that could not be attempted must not undo that or
 * show the skipper an error about an inbox — the match page shows both parties the contact
 * regardless (AC 2). No push transport: the match email is email-only on purpose (match.ts).
 */
export async function notifyMatchLive(postId: string): Promise<MatchNotifyResult | null> {
  try {
    return await notifyMatch(postId, {
      store: supabaseMatchStore(),
      transport: resendTransport(),
      now: new Date(),
      siteUrl: await siteUrl(),
    });
  } catch (e) {
    console.error(`notifyMatch(${postId}) failed:`, e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * notifyMessage() with the live dependencies, for the thread's send action (story #35). Same
 * swallow as the three above and for the same reason: the message row is already written and is
 * visible in the thread to both parties, and a notification that could not be attempted must not
 * undo it or show the author an error about the other person's inbox.
 *
 * WITH the push transport, unlike notifyMatchLive: a message is perishable in the way a match is
 * not — "which dock, what time" is worth a phone buzzing, and AC 3 asks for push where it is
 * installed and email otherwise.
 */
export async function notifyMessageLive(messageId: string): Promise<MessageNotifyResult | null> {
  try {
    return await notifyMessage(messageId, {
      store: supabaseMessageStore(),
      transport: resendTransport(),
      push: livePushTransport(),
      now: new Date(),
      siteUrl: await siteUrl(),
    });
  } catch (e) {
    console.error(`notifyMessage(${messageId}) failed:`, e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * notifyConfirmed() with the live dependencies, for the set-status Server Action (story #37
 * AC 3). Same swallow as the four above and for the same reason: set_match_status() has already
 * written 'confirmed', the page shows it to both parties, and a notification that could not be
 * attempted must not undo that or show the crew an error about the skipper's inbox. With push,
 * like a message: "they're coming" is worth a phone buzzing at breakfast.
 */
export async function notifyConfirmedLive(matchId: string): Promise<ConfirmNotifyResult | null> {
  try {
    return await notifyConfirmed(matchId, {
      store: supabaseConfirmStore(),
      transport: resendTransport(),
      push: livePushTransport(),
      now: new Date(),
      siteUrl: await siteUrl(),
    });
  } catch (e) {
    console.error(`notifyConfirmed(${matchId}) failed:`, e instanceof Error ? e.message : e);
    return null;
  }
}

/**
 * One crew's reminder with the live dependencies, for the morning-of pass (story #37 AC 2).
 * Swallowed per MATCH, the way `dispatchPendingLive` swallows per post: a crew whose reminder
 * throws must not stop the next crew being asked, and the pass has nothing to undo. What a
 * throw here means is that `reminded_at` was NOT set (remindCrew marks last), so the next tick
 * asks again — which is the right outcome for a store that could not be reached, and the
 * wrong one for a provider that refused, which is exactly why the provider's refusal is caught
 * inside remindCrew and logged rather than thrown.
 */
export async function remindCrewLive(match: MorningMatch): Promise<void> {
  try {
    await remindCrew(match, {
      store: supabaseConfirmStore(),
      transport: resendTransport(),
      push: livePushTransport(),
      now: new Date(),
      siteUrl: await siteUrl(),
    });
  } catch (e) {
    console.error(`remindCrew(${match.id}) failed:`, e instanceof Error ? e.message : e);
  }
}

/**
 * The whole morning-of pass with the live adapters, for the tick route (story #37 AC 2).
 * `runMorningOf()` reads the candidates and decides which are due; each due crew goes through
 * `remindCrewLive` above. Swallowed, like the dispatch: the ladder half has already done its
 * work, and a reminder pass that cannot read must not stop `tick_run` recording that the clock
 * is alive. The cost is that a broken candidate read is a console error and nothing louder —
 * the same standing the dispatch has today. NOT #43's to surface: that story is `onRequestError`
 * on a route that throws, and an error swallowed here never reaches it; Vercel Hobby keeps the
 * console line for one hour. What survives is the match itself — `accepted` with `reminded_at`
 * null on a race that has started says the pass never reached it, though not why. The
 * deploy-ordering case (0021 not yet applied) is what README 2d exists to prevent.
 */
export async function morningOfLive(now: Date): Promise<void> {
  try {
    await runMorningOf(supabaseMorningOfRepo(), remindCrewLive, now);
  } catch (e) {
    console.error(`morningOf(${now.toISOString()}) failed:`, e instanceof Error ? e.message : e);
  }
}

/**
 * sendInvites() with the live dependencies, for the admin's invite action (story #31).
 *
 * The ONE sender here that does not swallow its failure, and the reason is the direction the
 * report faces. The other five notify somebody about a thing that has already been written and
 * stands — a post, an answer, a match, a message, a confirmation — so an unreachable provider must
 * not undo it or show the actor an error about somebody else's inbox. An invite send has no such
 * row behind it: the whole point of the action is the email, the admin is standing there waiting
 * to be told what happened to each address, and a swallowed throw would report "nothing sent" as
 * indistinguishable from "everybody was already a member". So the store's own failures propagate
 * and the action turns them into a refusal the admin can read. A PROVIDER refusal is still caught
 * per address inside sendInvites() and logged, exactly as elsewhere.
 *
 * No push transport: an invitee has no device subscribed to this app — that is what they are being
 * invited to install.
 */
export async function sendInvitesLive(text: string): Promise<InviteResult> {
  return await sendInvites(text, {
    store: supabaseInviteStore(),
    transport: resendTransport(),
    now: new Date(),
    siteUrl: await siteUrl(),
  });
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
