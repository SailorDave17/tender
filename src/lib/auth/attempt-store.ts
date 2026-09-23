import type { SupabaseClient } from "@supabase/supabase-js";
import type { AttemptStore } from "@/auth/attempt-limit";
import { supabaseAdmin } from "@/lib/supabase/admin";

/**
 * The attempt limit's store as the service role calls it: 0032's two functions, and nothing else
 * (story #206). `adminAttemptStore` takes the admin client, like `adminPersonStore`, so a route
 * that already holds one (/api/join, /api/signup/google) does not build a second.
 *
 * `serviceAttemptStore` is for the two routes that hold NO service-role client, and must not:
 * `routes-source.test.ts` refuses `supabaseAdmin` in /api/signin's text so that it can never read
 * the invite code or create a user. Those routes reach the service role through this and only
 * this, and what they get is the two calls below — not a client.
 *
 * Both calls throw on an error. `withAttemptLimit` decides what a failed store means — an
 * unlimited attempt for `begin`, a still-counted one for `settle` — and says why there.
 */
export function adminAttemptStore(admin: SupabaseClient): AttemptStore {
  return {
    async begin(a) {
      const { data, error } = await admin.rpc("begin_auth_attempt", {
        p_gate: a.gate,
        p_gates: a.gates,
        p_ip_hash: a.ipHash,
        p_email_hash: a.emailHash,
        p_at: a.at.toISOString(),
        p_since: a.since.toISOString(),
        p_ip_limit: a.ipLimit,
        p_email_limit: a.emailLimit,
      });
      if (error) throw new Error(`attempt store: begin: ${error.message}`);
      return (data as string | null) ?? null;
    },
    async settle(id) {
      const { error } = await admin.rpc("settle_auth_attempt", { p_id: id });
      if (error) throw new Error(`attempt store: settle: ${error.message}`);
    },
  };
}

export function serviceAttemptStore(): AttemptStore {
  return adminAttemptStore(supabaseAdmin());
}
