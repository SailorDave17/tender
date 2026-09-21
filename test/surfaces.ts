/**
 * Fixtures and a fake client for rendering the six member-facing surfaces with no database
 * (story #155). The pages are real Server Components; what is faked is the cookie-bound client
 * they read through, in the shape of #123's awaitable stand-in: every PostgREST chain a page
 * builds ends at the table's fixture rows, and `single`/`maybeSingle` hand back the first one.
 *
 * The world here is one Sunday series: three race days (one sailed), Ada the skipper with a
 * Thistle, Cy and Ann as crew, one open post with an answer, one crewed post, one post on the
 * later day. Enough for every branch a surface paints: a rung badge, an answered badge, an Accept
 * form, a matched panel with contact, a disabled toggle on the sailed day, a pressed one on the
 * day Ada marked.
 */

const DAY = 24 * 60 * 60 * 1000;
export const NOW = new Date("2027-06-06T12:00:00.000Z");
const at = (days: number, hourUtc = 17) => new Date(NOW.getTime() + days * DAY - 12 * 60 * 60 * 1000 + hourUtc * 60 * 60 * 1000).toISOString();

export const ME = "p-ada";
/** The post and boat pages refuse a non-UUID id before reading anything (`UUID.test`). */
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
export const IDS = { boatMoon: uuid(1), boatAnn: uuid(2), postOpen: uuid(11), postCrewed: uuid(12), postLater: uuid(13) };
export const PEOPLE = [
  { id: ME, display_name: "Ada Lovelace", rating: 4, skills: ["helm"], any_hull: true, hulls: [] as string[] },
  { id: "p-cy", display_name: "Cy Twombly", rating: 2, skills: ["trim"], any_hull: false, hulls: ["Thistle"] },
  { id: "p-ann", display_name: "Ann Richards", rating: 1, skills: [] as string[], any_hull: true, hulls: [] as string[] },
];
export const RACE_DATES = [
  { id: "d-past", starts_at: at(-7), title: "Sunday series 1", published: true },
  { id: "d-next", starts_at: at(5), title: "Sunday series 2", published: true },
  { id: "d-later", starts_at: at(12), title: "Sunday series 3", published: true },
];
export const BOATS = [
  { id: IDS.boatMoon, owner_id: ME, name: "Blue Moon", class: "Thistle", default_minimum: 2 as const },
  { id: IDS.boatAnn, owner_id: "p-ann", name: "Wanderer", class: "Flying Scot", default_minimum: 1 as const },
];
export const POSTS = [
  { id: IDS.postOpen, boat_id: IDS.boatMoon, race_date_id: "d-next", minimum: 2 as const, note: "Jib trimmer wanted; we launch at noon", closed_at: null, current_rung: 1 as const },
  { id: IDS.postCrewed, boat_id: IDS.boatAnn, race_date_id: "d-next", minimum: 1 as const, note: "", closed_at: at(-1), current_rung: 2 as const },
  { id: IDS.postLater, boat_id: IDS.boatMoon, race_date_id: "d-later", minimum: 2 as const, note: "", closed_at: null, current_rung: 2 as const },
];
export const AVAILABILITY = [
  { person_id: "p-cy", race_date_id: "d-next" },
  { person_id: "p-ann", race_date_id: "d-next" },
  { person_id: ME, race_date_id: "d-next" },
  { person_id: "p-cy", race_date_id: "d-later" },
];
export const ANSWERS = [{ post_id: IDS.postOpen, person_id: "p-cy" }];
export const MATCHES = [{ id: uuid(21), post_id: IDS.postCrewed, skipper_id: "p-ann", crew_id: "p-cy", accepted_at: at(-1), status: "confirmed" }];
export const SKILLS = [
  { code: "trim", label: "Can hike and trim", level: 2, sort: 1 },
  { code: "spin", label: "Can fly a spinnaker", level: 3, sort: 2 },
  { code: "helm", label: "Can helm", level: 4, sort: 3 },
];
export const BOAT_CLASSES = [{ name: "Flying Scot" }, { name: "Thistle" }];

export type Tables = Record<string, unknown[]>;

export const TABLES: Tables = {
  race_date: RACE_DATES,
  boat: BOATS,
  post: POSTS,
  person: PEOPLE,
  availability: AVAILABILITY,
  answer: ANSWERS,
  match: MATCHES,
  skill: SKILLS,
  boat_class: BOAT_CLASSES,
  person_contact: [{ person_id: "p-cy", email: "cy@example.test", phone: "614-555-0100" }],
  push_subscription: [],
  suspension: [],
};

/** #123's stand-in: every chain ends at the rows; `single`/`maybeSingle` take the first. */
function answers(rows: unknown[]) {
  const value = { data: rows, error: null, count: rows.length };
  const one = async () => ({ data: rows[0] ?? null, error: null });
  const node: Record<string, unknown> = {
    select: () => node,
    eq: () => node,
    is: () => node,
    in: () => node,
    order: () => node,
    limit: () => node,
    single: one,
    maybeSingle: one,
    then: (ok: (v: unknown) => unknown, bad?: (e: unknown) => unknown) => Promise.resolve(value).then(ok, bad),
  };
  return node;
}

/**
 * A client signed in as `userId`. `person_contact` is narrowed to the counterparty's row the way
 * 0008 would narrow it, so the matched panel shows a phone and the profile shows the owner's.
 */
export function fakeClient(userId: string, tables: Tables = TABLES) {
  return {
    auth: {
      getUser: async () => ({ data: { user: { id: userId, email: `${userId}@example.test`, identities: [] } }, error: null }),
    },
    // `answer_counts` (0007): un-withdrawn answers per post, for the posts asked about.
    rpc: async (fn: string, args: { post_ids?: string[] }) => {
      if (fn !== "answer_counts") throw new Error(`fake client: no rpc ${fn}`);
      const answers = (tables.answer ?? []) as { post_id: string }[];
      const data = (args.post_ids ?? []).map((post_id) => ({ post_id, answered: answers.filter((a) => a.post_id === post_id).length }));
      return { data, error: null };
    },
    from: (table: string) => {
      if (table === "person" && tables.person) {
        // The board's `me` read is `.eq("id", user.id).maybeSingle()`: put the caller first so
        // `maybeSingle` hands back their own row, and keep the list whole for `loadBoardData`.
        const rows = tables.person as { id: string }[];
        return answers([...rows.filter((p) => p.id === userId), ...rows.filter((p) => p.id !== userId)]);
      }
      if (table === "person_contact") {
        const rows = (tables.person_contact ?? []) as { person_id: string }[];
        const own = rows.find((r) => r.person_id === userId);
        return answers(own ? [own] : rows.filter((r) => r.person_id !== userId));
      }
      return answers(tables[table] ?? []);
    },
  };
}
