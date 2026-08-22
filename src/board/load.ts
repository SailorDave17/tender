import type { PersonRow } from "@/engine/toCrew";
import type { supabaseServer } from "@/lib/supabase/server";

/**
 * The reads the board and a post's page share, all through the cookie-bound client so RLS
 * decides what comes back. Four small tables joined in code rather than one embedded select:
 * ~80 people × ~45 dates is the charter's whole volume, and the joins are the tested pure
 * functions in post-view.ts rather than a PostgREST resource embedding no test can see.
 */

export type RaceDateRow = { id: string; starts_at: string; title: string };
export type BoatRow = { id: string; owner_id: string; name: string; class: string; default_minimum: 1 | 2 | 3 };
export type PostRow = {
  id: string;
  boat_id: string;
  race_date_id: string;
  minimum: 1 | 2 | 3;
  note: string;
  closed_at: string | null;
};
export type PersonView = PersonRow & { display_name: string };
export type AvailabilityRow = { person_id: string; race_date_id: string };

export type BoardData = {
  dates: RaceDateRow[];
  boats: Map<string, BoatRow>;
  posts: PostRow[];
  people: Map<string, PersonView>;
  availability: AvailabilityRow[];
};

type Client = Awaited<ReturnType<typeof supabaseServer>>;

export async function loadBoardData(client: Client): Promise<BoardData> {
  const [dates, boats, posts, people, availability] = await Promise.all([
    client.from("race_date").select("id, starts_at, title").eq("published", true).order("starts_at"),
    client.from("boat").select("id, owner_id, name, class, default_minimum"),
    client.from("post").select("id, boat_id, race_date_id, minimum, note, closed_at").order("created_at"),
    client.from("person").select("id, display_name, rating, any_hull, hulls"),
    client.from("availability").select("person_id, race_date_id"),
  ]);
  return {
    dates: (dates.data ?? []) as RaceDateRow[],
    boats: new Map(((boats.data ?? []) as BoatRow[]).map((b) => [b.id, b])),
    posts: (posts.data ?? []) as PostRow[],
    people: new Map(((people.data ?? []) as PersonView[]).map((p) => [p.id, p])),
    availability: (availability.data ?? []) as AvailabilityRow[],
  };
}
