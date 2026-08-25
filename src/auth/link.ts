/**
 * Linking a Google account to an existing member (#74).
 *
 * Supabase links a Google identity to an existing auth user **only when the verified email
 * matches** (automatic identity linking). A member who joined as `alice@club.org` and presses
 * *Continue with Google* as `alice@gmail.com` therefore gets a FRESH auth user, which
 * `/auth/callback` deletes (no attestation, no gate pass) — and the advice it used to give
 * ("sign up with this season's invite code") produced a SECOND person row for the same human.
 *
 * `linkIdentity()` is the platform's own answer: a signed-in member starts an OAuth round trip
 * whose result is a second identity on the SAME auth user, so `auth.uid()` — which every RLS
 * policy here keys on — keeps naming one person. An app-side merge of two person rows was
 * rejected at filing: boats, posts, answers and matches would all need re-pointing.
 *
 * Everything that DECIDES lives here, as pure functions over an injected error shape, so every
 * refusal branch is a unit test with no cookies, no network and no Supabase.
 */

/** The marker the start route puts on `redirectTo` so the callback knows which flow returned. */
export const LINK_FLOW = "link";

/** Where a link attempt returns to, in both directions. A constant, never a caller's value. */
export const LINK_PATH = "/profile";

/** Where a *successful* link lands: the profile, with a marker so the page can confirm it. */
export const LINK_DONE = `${LINK_PATH}?linked=google`;

export type LinkReason = "linking-disabled" | "not-signed-in" | "already-linked" | "provider-error";

/** The narrow shape of a GoTrue refusal — the same slice `src/auth/signin.ts` takes. */
export type LinkError = { code?: string; message?: string };

export type LinkStartInput = { url?: string | null; error?: LinkError | null };

export type LinkStartDecision =
  | { kind: "redirect"; url: string }
  | { kind: "back"; reason: LinkReason };

/**
 * Which refusal this is, from GoTrue's `error_code` alone.
 *
 * Deliberately ONE mechanism per branch: the code, never the code *or* a message pattern. Two
 * matchers behind one outcome are indistinguishable from one — deleting either leaves the
 * assertion green — which is the shape cairn records as `prove-a-guard-test-can-fail`'s
 * sixteenth outcome. `@supabase/auth-js` populates `AuthApiError.code` from the body's
 * `error_code`, and GoTrue sets that on every refusal on this route:
 *
 *   401 `no_authorization`        no bearer token           (measured against the live project)
 *   403 `bad_jwt`                 a token it cannot verify  (measured against the live project)
 *   404 `manual_linking_disabled` the project setting is off (supabase/auth `requireManualLinkingEnabled`)
 *
 * Both token codes are mapped because which one comes back depends on the key format, and this
 * project's publishable key produces the 401 — an assertion on either alone would be about the
 * key rather than about the session.
 *
 * `identity_already_exists` (422) is here as a defence, NOT as this story's already-linked branch.
 * GoTrue's `/user/identities/authorize` looks up no identity — it only builds a redirect — so for
 * the OAuth overload that code can only arrive later, as a query parameter on the callback, which
 * is where `decideCallback` handles it. Mutating the case below reddens a unit test and changes
 * nothing a member could see; it is kept because the id-token overload can raise it synchronously
 * and because a wrong sentence costs more than an unused branch.
 *
 * Anything else is a provider error and says so in plain words rather than guessing.
 */
export function linkReason(error: LinkError | null | undefined): LinkReason {
  switch (error?.code) {
    case "manual_linking_disabled":
      return "linking-disabled";
    case "no_authorization":
      return "not-signed-in";
    case "bad_jwt":
      return "not-signed-in";
    case "session_not_found":
      return "not-signed-in";
    case "identity_already_exists":
      return "already-linked";
    default:
      return "provider-error";
  }
}

/** What the start route does with `linkIdentity()`'s answer: send the browser on, or explain. */
export function decideLinkStart(input: LinkStartInput): LinkStartDecision {
  if (input.error) return { kind: "back", reason: linkReason(input.error) };
  if (!input.url) return { kind: "back", reason: "provider-error" };
  return { kind: "redirect", url: input.url };
}

/**
 * Is this callback the return leg of a link attempt?
 *
 * The value rides on the query string, so treat it as attacker-supplied — which costs nothing,
 * because the only thing it can change is WHICH of two constant in-origin paths the browser is
 * sent to. It can never become a redirect target (`src/auth/next.ts` owns that job).
 */
export function isLinkFlow(flow: string | null | undefined): boolean {
  return flow === LINK_FLOW;
}

/**
 * Where a callback FAILURE returns to. A member who was signed in and linking must not be
 * dropped on the sign-in page being told to sign in — they already are.
 */
export function backPathFor(flow: string | null | undefined): string {
  return isLinkFlow(flow) ? LINK_PATH : "/join";
}

/**
 * The sentence for a link refusal, or `null` when this reason is not one of ours — which is what
 * lets `/profile` show link refusals and profile-save refusals through one expression without
 * either module holding a list of the other's keys.
 */
export function explainLinkReason(reason: string): string | null {
  switch (reason) {
    case "linking-disabled":
      return "Linking a Google account is not switched on for this club yet. Tell the club and use your email link in the meantime.";
    case "not-signed-in":
      return "Your session had expired, so nothing was linked. Sign in again and try from your profile.";
    case "already-linked":
      return "That Google account is already linked to an account here. If it is not yours, use a different Google account.";
    case "provider-error":
      return "Google or the sign-in service returned an error, so nothing was linked. Try again in a minute.";
    case "cancelled":
      return "Linking was cancelled. Nothing has changed — try again when you are ready.";
    case "link-invalid":
      return "That link attempt expired before it finished. Try again from your profile.";
    default:
      return null;
  }
}

/**
 * The cookies a PKCE flow start writes — and why a REFUSED link start has to put them back.
 *
 * `linkIdentity` writes a fresh code verifier BEFORE it asks GoTrue whether the link may proceed,
 * and — unlike `signInWithOtp`, which does clean up — its failure path removes nothing
 * (`@supabase/auth-js` 2.112.3, `linkIdentityOAuth`). The verifier goes to a per-flow slot AND is
 * mirrored into a fixed `<storageKey>-code-verifier` key, which is the one a server-side
 * `exchangeCodeForSession(code)` reads. So a link the project refuses silently overwrites the
 * verifier belonging to a magic link already sitting in the member's inbox, and that link then
 * fails — permanently, because the failed exchange deletes the fixed key on its way out.
 *
 * *Measured 2026-08-24* against the live project with a stand-in cookie jar: a start refused with
 * 401 `no_authorization` replaced the seeded verifier and added two more keys. It is the DEFAULT
 * path rather than an edge case — with *Allow manual linking* off, every press refuses.
 *
 * All three shapes `@supabase/ssr` recognises end in `-code-verifier`, so one suffix covers them.
 */
export function verifierCookies<T extends { name: string }>(all: readonly T[]): T[] {
  return all.filter((c) => c.name.endsWith("-code-verifier"));
}

/** What to write to put those cookies back exactly as they were. A `null` value means delete. */
export function restoreVerifiers(
  before: ReadonlyArray<{ name: string; value: string }>,
  after: ReadonlyArray<{ name: string; value: string }>,
): Array<{ name: string; value: string | null }> {
  const was = new Map(before.map((c) => [c.name, c.value]));
  const now = new Map(after.map((c) => [c.name, c.value]));
  const plan: Array<{ name: string; value: string | null }> = [];
  for (const [name, value] of was) if (now.get(name) !== value) plan.push({ name, value });
  for (const name of now.keys()) if (!was.has(name)) plan.push({ name, value: null });
  return plan;
}

/** Does this auth user already carry a Google identity? Decides which control /profile shows. */
export function hasGoogleIdentity(
  identities: ReadonlyArray<{ provider?: string | null }> | null | undefined,
): boolean {
  return (identities ?? []).some((i) => i.provider === "google");
}
