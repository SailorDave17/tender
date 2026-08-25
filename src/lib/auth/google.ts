import type { SupabaseClient } from "@supabase/supabase-js";
import { LINK_FLOW, LINK_PATH, type LinkStartInput } from "@/auth/link";

/**
 * Start the Google OAuth redirect through the cookie-bound client, so the PKCE verifier lands in
 * the caller's cookies for /auth/callback to exchange. Shared by sign-in (no gate) and sign-up
 * (gate pass already set). Returns the URL the browser must be sent to.
 */
export async function startGoogle(
  client: SupabaseClient,
  origin: string,
  next = "/board",
): Promise<{ url: string } | { error: string }> {
  const { data, error } = await client.auth.signInWithOAuth({
    provider: "google",
    options: { redirectTo: `${origin}/auth/callback?next=${encodeURIComponent(next)}` },
  });
  if (error || !data.url) return { error: error?.message ?? "no redirect URL from Supabase" };
  return { url: data.url };
}

/**
 * Start a LINK for a member who is already signed in (#74) — a different Supabase call from the
 * one above, and the difference is the whole story: `signInWithOAuth` authenticates a browser
 * and, when the Google address does not match, mints a SECOND auth user; `linkIdentity`
 * attaches the Google identity to the session's existing user, so one human keeps one
 * `auth.uid()`.
 *
 * `linkIdentity` redirects the browser itself only when it is running in one — on the server it
 * returns the URL and the caller redirects (`@supabase/auth-js` 2.112.3, `linkIdentityOAuth`).
 * `redirectTo` carries `flow=link` so the callback knows which leg returned; GoTrue passes the
 * whole value through as `redirect_to` and appends its own `code` or `error` to it, which is the
 * same mechanism `next=` above already rides on.
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
