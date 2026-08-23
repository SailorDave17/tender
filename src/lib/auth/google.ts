import type { SupabaseClient } from "@supabase/supabase-js";

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
