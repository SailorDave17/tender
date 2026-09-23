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
  "auth_attempt",
  "availability",
  "boat",
  "boat_class",
  "club",
  "error_report_claim",
  "match",
  "message",
  "message_removal",
  "notification_log",
  "person",
  "person_contact",
  "post",
  "push_subscription",
  "race_date",
  "skill",
  "suggestion",
  "suspension",
  "tick_run",
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
  // 0032 (#206). Called by the service role alone; execute is revoked from public, anon and
  // authenticated, so the anon probe is refused (42501), which reads PRESENT. It writes, and a GET
  // is a read-only transaction besides, so the probe could not reserve an attempt even if it ran.
  {
    name: "begin_auth_attempt",
    args: {
      p_gate: "forgot",
      p_gates: "{forgot}",
      p_ip_hash: "0".repeat(64),
      p_email_hash: "0".repeat(64),
      p_at: "1970-01-01T00:00:00Z",
      p_since: "1970-01-01T00:00:00Z",
      p_ip_limit: 0,
      p_email_limit: 0,
    },
  },
  // 0030 (#198). Called by the service role alone; execute is revoked from public, anon and
  // authenticated, so the anon probe is refused (42501), which reads PRESENT. It writes, and a GET
  // is a read-only transaction besides, so the probe could not take a claim even if it ran.
  {
    name: "claim_error_report",
    args: { p_signature: "check:live probe", p_at: "1970-01-01T00:00:00Z", p_since: "1970-01-01T00:00:00Z" },
  },
  { name: "current_invite_code", args: {} },
  // 0027 (#42). Self-or-admin definer; the anon probe is refused (42501), which reads PRESENT —
  // and a GET is a read-only transaction besides, so nothing could be deleted by the probe.
  { name: "delete_person", args: { person_id: NIL_UUID } },
  // 0026 (#39). Admin-only definer; the anon probe is refused (42501), which reads PRESENT. The
  // kinds placeholder is an array literal like members_among's, and the two instants are only
  // ever compared against sent_at, so any valid timestamp settles the probe.
  {
    name: "email_usage",
    args: { p_kinds: "{nothing_is_this_kind}", p_day_start: "1970-01-01T00:00:00Z", p_month_start: "1970-01-01T00:00:00Z" },
  },
  // 0022 (#31). Takes a text[], so the placeholder is an array literal rather than a nil uuid.
  // The probe runs as anon and is refused (42501 — execute is revoked from anon by name), which
  // reads PRESENT: a present function and a closed grant at once, which is what this story wants.
  { name: "members_among", args: { p_emails: "{nobody@example.invalid}" } },
  { name: "push_install_status", args: {} },
  // 0023 (#36). Admin-only definer; the anon probe is refused (42501), which reads PRESENT.
  { name: "remove_message", args: { message_id: NIL_UUID } },
  { name: "rotate_invite_code", args: {} },
  // 0028 (#41). Admin-only definer; the anon probe is refused (42501), which reads PRESENT. The
  // placeholders are a passing pair, though the verdict never reaches the body: a GET is a
  // read-only transaction besides, so nothing could be written by the probe.
  { name: "set_club_theme", args: { disc: "#000000", mark: "#FFFFFF" } },
  // 0021 (#37). The GET probe runs as anon and is refused (42501), which reads PRESENT; the
  // status value is irrelevant to the verdict for the same reason the nil uuid is.
  { name: "set_match_status", args: { match_id: NIL_UUID, status: "confirmed" } },
  // 0032 (#206), begin_auth_attempt's other half, refused to anon the same way. A nil uuid names
  // no reservation, and the GET's read-only transaction would stop the delete regardless.
  { name: "settle_auth_attempt", args: { p_id: NIL_UUID } },
];
