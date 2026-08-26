import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { supabaseRungStore } from "@/notify/store";
import type { RungStore } from "@/notify/rung";
import type { Suggested, TickPost, TickRepo } from "./tick";

/**
 * The TickRepo over the live database, as the service role — the second of AC 1's two adapters
 * (the first is `test/tick-repo.ts`, over pglite, which is what the behaviour fixtures run
 * through). Nothing here decides anything: every rule is in `runTick()`.
 *
 * Three of the five methods ARE the notify store's, forwarded rather than rewritten. `poolFor`,
 * `setRung` and `insertSuggestions` ask exactly the questions `pool`, `raiseRung` and
 * `addSuggestions` already answer for story #23, and a second copy of the pool query would be a
 * second answer to "who is available on this date" — the one thing the ladder and the tick must
 * never disagree about. The two new methods are the ones the notify path had no need for: which
 * posts a clock should look at, and what is already suggested on one.
 *
 * Why the service role: `suggestion` and `post.current_rung` are written by no client role
 * (0010), and the tick has no caller whose session it could borrow — it is a cron POST.
 */

function fail(what: string, error: { message: string } | null): never {
  throw new Error(`tick store: ${what}: ${error?.message ?? "unknown error"}`);
}

export function supabaseTickRepo(store: RungStore = supabaseRungStore()): TickRepo {
  const admin = supabaseAdmin();
  return {
    async openPosts(now): Promise<TickPost[]> {
      // `!inner` on the race_date embed is load-bearing: without it PostgREST applies
      // `race_date.starts_at` to the EMBEDDED rows and keeps the parent post with a null embed,
      // so every started race would come back with no date rather than being dropped. Measured
      // against a local Supabase stack rather than reasoned — the pglite adapter runs plain SQL
      // and is structurally blind to how PostgREST spells a join.
      const { data, error } = await admin
        .from("post")
        .select(
          "id, race_date_id, minimum, current_rung, closed_at, boat:boat_id!inner (name, class), race_date:race_date_id!inner (starts_at, title)",
        )
        .is("closed_at", null)
        .gt("race_date.starts_at", now.toISOString())
        .order("created_at");
      if (error) fail("read open posts", error);
      return (data ?? []).map((row) => {
        // PostgREST embeds a to-one relation as an object; the typing says object-or-array.
        const boat = (Array.isArray(row.boat) ? row.boat[0] : row.boat) as { name: string; class: string };
        const date = (Array.isArray(row.race_date) ? row.race_date[0] : row.race_date) as { starts_at: string; title: string };
        return {
          id: row.id,
          raceDateId: row.race_date_id,
          boatClass: boat.class,
          boatName: boat.name,
          minimum: row.minimum,
          startsAt: date.starts_at,
          dateTitle: date.title,
          currentRung: row.current_rung,
          closedAt: row.closed_at,
        };
      });
    },

    poolFor(raceDateId) {
      return store.pool(raceDateId);
    },

    async suggestionsFor(postId): Promise<Suggested[]> {
      const { data, error } = await admin.from("suggestion").select("person_id, rung").eq("post_id", postId);
      if (error) fail("read suggestions", error);
      return (data ?? []).map((s) => ({ personId: s.person_id, rung: s.rung }));
    },

    setRung(postId, rung) {
      return store.raiseRung(postId, rung);
    },

    insertSuggestions(rows) {
      return store.addSuggestions(rows);
    },
  };
}

/**
 * Stamp `tick_run.last_at` (0012). The one row is created on the first tick and updated on every
 * one after it, so /admin can tell a clock that ran and found nothing from a clock that is dead —
 * which are otherwise the same observation, since both send no email and change no row.
 *
 * Deliberately NOT swallowed: a tick that did its work and could not record it must not answer
 * 200, or the admin screen goes on reporting a healthy clock from the last stamp that landed.
 */
export async function recordTickRun(now: Date): Promise<void> {
  const admin = supabaseAdmin();
  const { error } = await admin.from("tick_run").upsert({ id: 1, last_at: now.toISOString() }, { onConflict: "id" });
  if (error) fail("record tick run", error);
}
