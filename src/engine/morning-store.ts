import "server-only";
import { supabaseAdmin } from "@/lib/supabase/admin";
import type { MorningMatch, MorningOfRepo } from "./morningOf";

/**
 * The MorningOfRepo over the live database, as the service role — the second of two adapters,
 * the first being `test/morning-repo.ts` over pglite, which is what the behaviour fixtures run
 * through. Nothing here decides anything: the rule is `reminderDue()` in morningOf.ts.
 *
 * ONE READ, NO FILTER ON AN EMBED. The candidates are every match still `accepted` with no
 * `reminded_at`, and both of those are columns of `match` itself. The race date's start is
 * reached through the post and the post's date, and it is NOT filtered on here — a PostgREST
 * filter naming an embedded resource is applied to the embed and leaves the parent with a null
 * (cairn: postgrest-filtering-on-an-embedded-resource), which is the one join spelling the
 * pglite adapter is structurally blind to. The engine decides against `now`; this reads.
 *
 * Why the service role: `match.reminded_at` is written by no client role (0021), and the tick
 * has no caller whose session it could borrow — it is a cron POST. The reads are 0018's
 * (`match`) and 0010's (`post`, `boat`, `race_date`).
 */

function fail(what: string, error: { message: string } | null): never {
  throw new Error(`morning store: ${what}: ${error?.message ?? "unknown error"}`);
}

export function supabaseMorningOfRepo(): MorningOfRepo {
  const admin = supabaseAdmin();
  return {
    async candidates(): Promise<MorningMatch[]> {
      const { data, error } = await admin
        .from("match")
        .select(
          "id, skipper_id, crew_id, post:post_id (id, race_date_id, minimum, current_rung, closed_at, boat:boat_id (name, class), race_date:race_date_id (starts_at, title))",
        )
        .eq("status", "accepted")
        .is("reminded_at", null);
      if (error) fail("read candidates", error);
      return (data ?? []).flatMap((row) => {
        // PostgREST embeds a to-one relation as an object; the typing says object-or-array.
        const post = (Array.isArray(row.post) ? row.post[0] : row.post) as {
          id: string;
          race_date_id: string;
          minimum: 1 | 2 | 3 | 4;
          current_rung: 1 | 2 | 3;
          closed_at: string | null;
          boat: { name: string; class: string } | { name: string; class: string }[];
          race_date: { starts_at: string; title: string } | { starts_at: string; title: string }[];
        } | null;
        // A match whose post is gone cannot be reminded about anything; 0008 cascades the match
        // with the post, so this is the deleted-mid-read window and nothing else.
        if (!post) return [];
        const boat = (Array.isArray(post.boat) ? post.boat[0] : post.boat) as { name: string; class: string };
        const date = (Array.isArray(post.race_date) ? post.race_date[0] : post.race_date) as { starts_at: string; title: string };
        return [
          {
            id: row.id,
            skipperId: row.skipper_id,
            crewId: row.crew_id,
            post: {
              id: post.id,
              raceDateId: post.race_date_id,
              boatClass: boat.class,
              boatName: boat.name,
              minimum: post.minimum,
              startsAt: date.starts_at,
              dateTitle: date.title,
              currentRung: post.current_rung,
              closedAt: post.closed_at,
            },
          },
        ];
      });
    },
  };
}
