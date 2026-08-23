/**
 * What check:live expects the live project to hold. Two literals, each a copy of a fact the
 * migrations already hold — which is the class that drifts (cairn:
 * a-computable-claim-does-not-belong-in-prose-2026-08-07) — so `test/migrations-hygiene.test.ts`
 * asserts both against the pglite harness on every run. They live in their own module because
 * `check-live.mjs` probes and exits at import, so a test cannot read them from there.
 */

/** Every table the migrations create in `public`. */
export const EXPECTED_TABLES = [
  "answer",
  "availability",
  "boat",
  "boat_class",
  "club",
  "match",
  "notification_log",
  "person",
  "person_contact",
  "post",
  "race_date",
  "suggestion",
];

/** A placeholder that is a valid uuid and matches nobody's row. */
export const NIL_UUID = "00000000-0000-0000-0000-000000000000";

/**
 * Every function the client calls by RPC, with the ARGUMENT NAMES it sends. PostgREST resolves
 * an overload by the set of names — a function present under different names answers
 * PGRST202, the same as one that is missing — so the probe carries exactly the client's set,
 * and the hygiene test holds this list equal to the `.rpc("…", {…})` calls in src/ and to the
 * harness's `pg_proc.proargnames` (cairn: postgrest-probing-a-live-project-2026-08-16).
 *
 * Values are placeholders: a nil uuid for a uuid, a one-element array of it for a uuid[].
 * Which value is irrelevant to the verdict — a GET is served in a read-only transaction, so a
 * function that writes is stopped by Postgres (25006) whatever it was given.
 */
export const EXPECTED_FUNCTIONS = [
  { name: "accept_answer", args: { post_id: NIL_UUID, person_id: NIL_UUID } },
  { name: "answer_counts", args: { post_ids: `{${NIL_UUID}}` } },
  { name: "current_invite_code", args: {} },
  { name: "rotate_invite_code", args: {} },
];
