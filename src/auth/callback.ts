import type { ErrorReport } from "@/notify/error";

/**
 * What /auth/callback does with the query string before it touches a session (#70 AC 7).
 *
 * Supabase and Google both return failures as `error` / `error_code` / `error_description`
 * instead of `code`. Until #70 only `code` was read and everything else answered
 * `missing-code`, so a member who cancelled at Google was told their link was incomplete.
 * Pure: a query in, a reason key the /join page can explain out.
 */

export type CallbackQuery = {
  code?: string | null;
  error?: string | null;
  error_code?: string | null;
  error_description?: string | null;
};

export type CallbackDecision = { kind: "exchange"; code: string } | { kind: "back"; reason: string };

export function decideCallback(q: CallbackQuery): CallbackDecision {
  if (q.code) return { kind: "exchange", code: q.code };
  if (q.error || q.error_code || q.error_description) {
    const code = (q.error_code ?? q.error ?? "").toLowerCase();
    // #74: a link attempt whose Google account is already on an auth user fails at GoTrue's own
    // provider callback, so it arrives here as a query parameter rather than from linkIdentity.
    // Most specific first: without this it would fall through to a generic provider error and
    // the member would be told to try again, which cannot work.
    if (code === "identity_already_exists") {
      return { kind: "back", reason: "already-linked" };
    }
    // GoTrue reports an expired or already-used emailed link as error=access_denied with
    // error_code=otp_expired — the precise key for that already exists, so it goes first. Since
    // #99 the only link that reaches this is a password reset (plus any pre-#99 magic link still
    // sitting unopened in an inbox, which keeps working until GoTrue expires it).
    if (code === "otp_expired" || /expired|already been used/i.test(q.error_description ?? "")) {
      return { kind: "back", reason: "link-invalid" };
    }
    if (code === "access_denied" || /access.denied|cancel/i.test(q.error_description ?? "")) {
      return { kind: "back", reason: "cancelled" };
    }
    return { kind: "back", reason: "provider-error" };
  }
  return { kind: "back", reason: "missing-code" };
}

/**
 * The sentence a page shows for each reason key — one place, so the pages and the tests agree.
 *
 * /join reads it for a callback that came back with a reason; since #83 the landing page reads it
 * too, for the failures GoTrue sends to Site URL instead of to `/auth/callback` (src/auth/landing.ts
 * maps those). That is why the last two cases exist here rather than in a second vocabulary: they
 * are the same kind of sentence, said to the same person, about the same round trip.
 */
export function explainReason(reason: string): string {
  switch (reason) {
    case "link-invalid":
      return "That link has expired or was already used. Ask for a new one from Forgot your password.";
    // #83: `link-invalid` above says "expired or was already used" because an emailed link gives
    // no way to tell them apart. An OAuth state does — GoTrue answers with a different error code for
    // each — so these two say which, and neither puts it on the member: the five-minute window
    // starts when they press the control, and pressing back is not a mistake.
    case "state-expired":
      return "That sign-in took too long to finish, so it expired. Nothing is wrong with your account — start again and you will be signed in.";
    case "state-used":
      return "That sign-in link had already been used. Nothing is wrong with your account — start again to get a fresh one.";
    // #74: this sentence used to say only "sign up with this season's invite code first", which
    // was wrong advice for the commonest way to reach it — a member whose Google address differs
    // from the one they joined with. Supabase links a Google identity to an existing user only
    // when the verified email matches, so they arrive here as a stranger, and following that
    // advice gave the same human a SECOND person row. Sign in first, then link, is the route
    // that keeps one person one account.
    // #82: "sign in with the email you joined with" now means email + password. The population
    // that reaches this sentence — a member whose Google address differs from the one they joined
    // with — is exactly the one likely to have NO password (a Google-created or pre-#82 account),
    // so the advice points them at Forgot my password, which sets a first one. #99 removed that
    // screen's other arm, so the reset IS the route now rather than one of two; the sentence did
    // not have to change, because it never named the arm. Flagged on the issue by #74 when it
    // wrote this sentence.
    case "not-invited":
      return "That account is not linked to a member here. If you are already a member, sign in with the email you joined with — use Forgot my password if you have never set one — then link Google from your profile. If you are new, sign up with this season's invite code.";
    case "missing-code":
      return "That link was incomplete. Ask for a new one.";
    case "cancelled":
      return "Google sign-in was cancelled. Nothing has changed — try again when you are ready.";
    case "already-linked":
      return "That Google account is already attached to an account here. Sign in with the email you joined with — use Forgot my password if you have never set one — or use a different Google account.";
    case "provider-error":
      return "Google or the sign-in service returned an error. Try again in a minute, or sign in with your email and password.";
    // #204: the code was exchanged, so the link is spent, and "try again" alone would send them
    // back to a link that no longer works.
    case UNCONFIRMED:
      return "Tender could not finish opening that link just now, and a link only works once. Ask for a new one from Forgot your password.";
    default:
      return "Sign-in did not complete. Try again.";
  }
}

/**
 * The reason a callback goes back with when it exchanged its code and then could not confirm the
 * person behind the session (story #204).
 *
 * Every other failure here is decided before the exchange, or by `ensurePerson`'s own refusal.
 * This one is the service role's READ being refused — `person` checked by id, 1 in 477 on
 * 2026-09-22 (`JWT issued at future`, #198) — and until #204 it threw past this handler's promise
 * that any failure goes back to a reason the page can show, so an emailed reset link landed on a
 * bare 500 with its one-time code already spent.
 *
 * What the handler then does depends on the leg, and the reason is the same key on both, because
 * /join and /profile each hold their own sentence for it (this file's `explainReason` and
 * `explainLinkReason` in `./link.ts`):
 *   - a reset link: signed OUT, because nothing has yet confirmed this user is a member, and a
 *     session with no person row is what `ensurePerson`'s refusal signs out too. The member asks
 *     for a new link.
 *   - a Google link from /profile: the session is KEPT. The member was signed in through the gate
 *     before they pressed the link, GoTrue has already linked the identity by the time a code
 *     arrives here, and signing them out would drop the sentence, since the proxy sends a
 *     signed-out /profile to /join.
 */
export const UNCONFIRMED = "unconfirmed";

/** The error name the refusal is reported under, and so half of its dedupe signature. */
export const CALLBACK_UNCONFIRMED_ERROR = "CallbackPersonUnconfirmed";

/**
 * The report for that refusal, in the shape the error hook's reporter takes. `path` carries no
 * query: this route's query is a PKCE code, and a report is copied into an inbox and into
 * `notification_log` (`ErrorReport`'s own rule).
 */
export function callbackUnconfirmedReport(message: string, linkFlow: boolean): ErrorReport {
  return {
    name: CALLBACK_UNCONFIRMED_ERROR,
    message:
      `the person behind a callback session could not be checked: ${message}. ` +
      (linkFlow
        ? "It was a Google link from /profile, so the member stayed signed in and was sent back there with a sentence."
        : "The session was signed out and the member was sent to /join to ask for a new link, instead of a bare error."),
    stack: null,
    method: "GET",
    path: "/auth/callback",
    routePath: "/auth/callback",
    routeType: "degraded",
    digest: null,
  };
}
