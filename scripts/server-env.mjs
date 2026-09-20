/**
 * The server environment names the runbook asks for, and what each one's absence does
 * (story #65).
 *
 * WHY THE LIST IS HERE AND NOT IN src/. `npm run check:live` is plain Node and cannot import a
 * TypeScript module, so a list living in src/ would have to be copied into scripts/ to reach the
 * instrument — and a copied list is how the thing that checks and the thing that runs stop
 * agreeing. Same arrangement, and the same reason, as EXPECTED_TABLES in check-live-expected.mjs:
 * the literal lives where the script can read it and test/server-env.test.ts holds it equal to
 * what src/ actually does.
 *
 * `fails` is the distinction the story is about, and it is not "important" versus "unimportant":
 *
 *   "throws"    absence stops the thing that needed it, with this name in the message. Loud.
 *   "degrades"  absence makes the app quietly do less. There is no error to read, which is
 *               exactly why these are worth printing — README step 2c says so of OWNER_EMAIL in
 *               as many words: "quiet by construction — the one to check for deliberately".
 *
 * The story asked for an assertion over five names (its body amended three -> four -> five as
 * #70 and #23 landed). The runbook numbers NINE, and the four beyond the five degrade rather
 * than throw. Owner decision at pickup, 2026-09-20: THROW on the five, REPORT all nine. Turning
 * the other four into throws would be a behaviour change this story did not ask for — a missing
 * OWNER_EMAIL would take down the error-reporting hook instead of logging `OWNER_EMAIL unset`,
 * and an unset VAPID public key would break /profile rather than hiding the push toggle.
 *
 * Adding a name here is not bookkeeping: the test refuses a `throws` entry that no file reads
 * through env(), and refuses an env() call whose name is missing from this list.
 */

/** @typedef {{ name: string, fails: "throws" | "degrades", breaks: string }} ServerEnvName */

/** @type {ServerEnvName[]} */
export const SERVER_ENV = [
  // README runbook step 1 — Supabase.
  {
    name: "NEXT_PUBLIC_SUPABASE_URL",
    fails: "throws",
    breaks: "every client; src/proxy.ts throws before any route runs",
  },
  {
    name: "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    fails: "throws",
    breaks: "every signed-in read; src/proxy.ts throws before any route runs",
  },
  {
    name: "SUPABASE_SERVICE_ROLE_KEY",
    fails: "throws",
    breaks: "the invite gate — /api/join cannot read club.invite_code or mint a person",
  },
  // Step 2 — Resend.
  {
    name: "RESEND_API_KEY",
    fails: "throws",
    breaks: "every outbound email, at transport construction; the ...Live wrappers catch it, so a post still stands and nobody is emailed",
  },
  // Step 1's Google provider — the gate pass.
  {
    name: "GATE_PASS_SECRET",
    fails: "throws",
    breaks: "Google sign-up — /api/signup/google cannot sign the pass and /auth/callback cannot verify one",
  },
  // Step 2b — web push (#29).
  {
    name: "NEXT_PUBLIC_VAPID_PUBLIC_KEY",
    fails: "degrades",
    breaks: "/profile hides the push toggle; nobody can subscribe and nothing says why",
  },
  {
    name: "VAPID_PRIVATE_KEY",
    fails: "degrades",
    breaks: "no push is sent; existing subscriptions go silent",
  },
  // Step 2c — the ladder tick (#27).
  {
    name: "CRON_SECRET",
    fails: "degrades",
    breaks: "src/auth/bearer.ts refuses EVERY call to /api/ladder/tick — closed rather than open, and a uniform 401 rather than a partial success",
  },
  // Step 2d — error reports (#43).
  {
    name: "OWNER_EMAIL",
    fails: "degrades",
    breaks: "no error email at all; the report goes to the function log and expires there in an hour",
  },
];

/** The names whose absence throws with the name in the message — the story's assertion set. */
export const THROWING_NAMES = SERVER_ENV.filter((e) => e.fails === "throws").map((e) => e.name);

export const PRESENT = "present";
export const ABSENT = "ABSENT";

/**
 * What check:live prints about its OWN environment, before it touches the network.
 *
 * Values never appear — only the names and whether something is there — so the output is safe
 * to paste into a public issue. Empty counts as absent, matching env() in src/lib/env.ts: a
 * variable created and left blank is the likelier mistake, and .env.local here really does carry
 * SUPABASE_SERVICE_ROLE_KEY with an empty value.
 *
 * REPORT ONLY — nothing here decides an exit code, and that is deliberate rather than an
 * oversight. check:live is run against the owner's own machine, where several of these are
 * legitimately absent (the service-role key is blank in .env.local on purpose); failing the run
 * on that would make the instrument useless precisely where it is most wanted.
 *
 * `read` is annotated as a plain record rather than left to be inferred from process.env:
 * NodeJS.ProcessEnv demands NODE_ENV of every caller, which would make each fixture in
 * test/server-env.test.ts carry a field this function never looks at.
 *
 * @param {Readonly<Record<string, string | undefined>>} [read]
 * @param {ServerEnvName[]} [names]
 * @returns {string[]}
 */
export function envReport(read = process.env, names = SERVER_ENV) {
  const status = names.map((e) => ({ ...e, present: Boolean(read[e.name]) }));
  const missing = status.filter((e) => !e.present);
  const loud = missing.filter((e) => e.fails === "throws").map((e) => e.name);
  const quiet = missing.filter((e) => e.fails === "degrades").map((e) => e.name);

  const head =
    missing.length === 0
      ? `env: all ${names.length} server names present`
      : `env: ${names.length - missing.length}/${names.length} server names present — ` +
        [
          loud.length ? `${loud.length} that throw (${loud.join(", ")})` : null,
          quiet.length ? `${quiet.length} that degrade silently (${quiet.join(", ")})` : null,
        ]
          .filter(Boolean)
          .join(", ");

  return [
    head,
    ...status.map(
      (e) =>
        `${e.present ? "ok  " : e.fails === "throws" ? "MISS" : "miss"}  ${e.name}: ` +
        `${e.present ? PRESENT : ABSENT} (${e.fails} — ${e.breaks})`,
    ),
  ];
}
