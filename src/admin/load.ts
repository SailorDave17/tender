import type { supabaseServer } from "@/lib/supabase/server";
import type {
  SeasonBoat,
  SeasonDate,
  SeasonMatchRow,
  SeasonPerson,
  SeasonPost,
} from "./season";

/**
 * The reads the admin's season screens share (story #38). Issues PostgREST reads and casts the
 * responses; every rule is in season.ts and metric.ts, which is why this file has no test of its
 * own beyond the type assertions beside it — the same split `src/board/load.ts` records.
 *
 * ## Read as the signed-in person, never as the service role
 *
 * Every call goes through the cookie-bound client, so the database decides what comes back —
 * which matters most for what it does NOT hand back: `person_contact` stays self-or-counterparty
 * even for the admin (0008), so this screen can name people and can never print their email.
 *
 * **It does not, however, hide the listing from a non-admin.** `post_read_published` (0006),
 * `match_read_with_post` (0008) and `person`'s read policy (0002) admit every signed-in member;
 * none of the three mentions `is_admin`. Story #38's AC 4 asserted "as a non-admin, zero rows",
 * and that is false against this schema — measured in both directions in
 * `test/admin-season.test.ts`. The page's `notFound()` is the only gate, and the screen is an
 * aggregate of what the board already shows the club, which is why one gate is enough for what
 * is on it today. Adding a column that is not already club-visible means adding the database's
 * refusal in the same change.
 *
 * Using `supabaseAdmin()` here instead would have been the wrong repair: it would make the page
 * the sole author of its own authorization, which is exactly the shape 0004's header argues
 * against. The cookie-bound client keeps the contact-row refusal real.
 *
 * ## Columns are named, never `*`
 *
 * Supabase grants by column here (0002's header), and a withheld column makes `select('*')` fail
 * loudly at the client. `match.reminded_at` is granted to `service_role` only (0021), and
 * `person.adult_attested_at` to nobody — so a `*` on either table is a 500 on a correct schema.
 *
 * ## Unpublished dates carry no readable posts, for anyone
 *
 * `post_read_published` (0006) admits a post only when its race date is published — and that
 * policy has no admin arm, so even this screen cannot see posts on a draft date. The date list
 * below is therefore filtered to published rows: a draft date would otherwise render with zero
 * posts and zero matches, which reads as "nobody posted" rather than "this date is not on the
 * board yet". `/admin/dates` is where a draft date is visible, and publishing it is what brings
 * its posts into view here.
 */

type Client = Awaited<ReturnType<typeof supabaseServer>>;

export type SeasonData = {
  dates: SeasonDate[];
  posts: SeasonPost[];
  matches: SeasonMatchRow[];
  boats: Map<string, SeasonBoat>;
  people: Map<string, SeasonPerson>;
};

export async function loadSeasonData(client: Client): Promise<SeasonData> {
  const [dates, posts, matches, boats, people] = await Promise.all([
    client
      .from("race_date")
      .select("id, starts_at, title, published")
      .eq("published", true)
      .order("starts_at"),
    client.from("post").select("id, boat_id, race_date_id, minimum, closed_at, current_rung"),
    client.from("match").select("id, post_id, skipper_id, crew_id, status"),
    client.from("boat").select("id, owner_id, name, class"),
    client.from("person").select("id, display_name"),
  ]);

  return {
    dates: (dates.data ?? []) as SeasonDate[],
    posts: (posts.data ?? []) as SeasonPost[],
    matches: (matches.data ?? []) as SeasonMatchRow[],
    boats: new Map(((boats.data ?? []) as SeasonBoat[]).map((b) => [b.id, b])),
    people: new Map(((people.data ?? []) as SeasonPerson[]).map((p) => [p.id, p])),
  };
}
