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
    // GoTrue reports an expired or already-used magic link as error=access_denied with
    // error_code=otp_expired — the precise key for that already exists, so it goes first.
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

/** The sentence /join shows for each reason key — one place, so the page and the tests agree. */
export function explainReason(reason: string): string {
  switch (reason) {
    case "link-invalid":
      return "That link has expired or was already used. Ask for a new one.";
    case "not-invited":
      return "That account has no invitation. Sign up with this season's invite code first.";
    case "missing-code":
      return "That link was incomplete. Ask for a new one.";
    case "cancelled":
      return "Google sign-in was cancelled. Nothing has changed — try again when you are ready.";
    case "provider-error":
      return "Google or the sign-in service returned an error. Try again in a minute, or use an email link.";
    default:
      return "Sign-in did not complete. Ask for a new link.";
  }
}
