import type { SupabaseClient } from "@supabase/supabase-js";
import { LINK_FLOW, LINK_PATH, type LinkStartInput } from "@/auth/link";
import type { AuthUser } from "@/auth/person";

/**
 * Exchange a Google ID token for a session through the cookie-bound client (#173). The browser
 * obtained the token from Google Identity Services on our own origin; `signInWithIdToken` sends
 * it to GoTrue, which verifies it against the provider's client id and — with *Skip nonce checks*
 * OFF — checks that the token's `nonce` claim is the SHA-256 of the raw `nonce` given here.
 * The session cookies land through `cookies()`, as a password sign-in's do.
 *
 * This replaced `startGoogle` — `signInWithOAuth` and a redirect through
 * `<ref>.supabase.co/auth/v1/authorize` — because Google's consent screen names the redirect
 * URI's host, and that host was Supabase's (#77). The link flow below still redirects.
 */
export async function exchangeGoogleIdToken(
  client: SupabaseClient,
  token: string,
  nonce: string,
): Promise<{ user: AuthUser } | { error: { code?: string; message: string } }> {
  const { data, error } = await client.auth.signInWithIdToken({ provider: "google", token, nonce });
  if (error) return { error: { code: error.code, message: error.message } };
  if (!data.user) return { error: { message: "no user on the exchanged session" } };
  return { user: data.user };
}

/**
 * Start a LINK for a member who is already signed in (#74) — a different Supabase call from the
 * one above, and the difference is the whole story: an ID-token sign-in authenticates a browser
 * and, when the Google address does not match, mints a SECOND auth user; `linkIdentity` attaches
 * the Google identity to the session's existing user, so one human keeps one `auth.uid()`.
 *
 * **This is the one Google flow still on the redirect, and so the one screen that still names
 * the Supabase host** (#173). GoTrue's `/user/identities/authorize` is redirect-only: there is no
 * ID-token form of `linkIdentity` in `@supabase/auth-js` (2.116.0 — `linkIdentity` takes the same
 * `SignInWithOAuthCredentials` shape as `signInWithOAuth` and nothing else), so a link cannot be
 * moved to our origin the way sign-in and sign-up were. The README's Google provider section
 * says so to the member-facing side of that.
 *
 * `linkIdentity` redirects the browser itself only when it is running in one — on the server it
 * returns the URL and the caller redirects (`@supabase/auth-js`, `linkIdentityOAuth`).
 * `redirectTo` carries `flow=link` so the callback knows which leg returned; GoTrue passes the
 * whole value through as `redirect_to` and appends its own `code` or `error` to it.
 *
 * The error is passed on with its `code` intact — `src/auth/link.ts` needs it to tell "the
 * project has manual linking switched off" from "that Google account is already taken".
 */
export async function startGoogleLink(
  client: SupabaseClient,
  origin: string,
): Promise<LinkStartInput> {
  const { data, error } = await client.auth.linkIdentity({
    provider: "google",
    options: {
      redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(LINK_PATH)}&flow=${LINK_FLOW}`,
    },
  });
  if (error) return { error: { code: error.code, message: error.message } };
  return { url: data?.url ?? null };
}
