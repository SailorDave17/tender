import "server-only";
import { createClient } from "@supabase/supabase-js";
import { env } from "./server";

/**
 * The service-role client. Bypasses RLS, so it exists for exactly two jobs: reading the invite
 * code (withheld from every client role since 0002) and creating the auth user plus the person
 * rows no client may insert. Never imported by anything that ships to a browser — the
 * `server-only` import makes that a build error rather than a review item.
 */
export function supabaseAdmin() {
  return createClient(env("NEXT_PUBLIC_SUPABASE_URL"), env("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}
