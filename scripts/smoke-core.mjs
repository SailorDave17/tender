/**
 * smoke — the half that decides things, with no Docker, no browser and no network in it. Story #45.
 *
 * WHAT QUESTION THIS ANSWERS
 *
 * ADR 006 deferred "Playwright smoke once screens exist" and gave itself a kill condition: *a class
 * of defect reaching production that the suites were structurally unable to see*. pglite proves a
 * policy in an in-memory Postgres that grants nothing Supabase would; the component tests render
 * HTML with no request behind it. Neither can see a Server Component's query, a redirect, a cookie
 * GoTrue actually wrote, or the proxy refusing a session. So `smoke.mjs` drives the core path — sign
 * in, mark a day, post, answer, accept — through a real browser against a real GoTrue and a real
 * PostgREST, on every pull request, and this file holds everything about it that can be decided
 * without one.
 *
 * WHY THE SIGN-IN IS A PASSWORD AND NOT THE MAGIC LINK THE ISSUE NAMES
 *
 * #45 was filed on 2026-08-22 asking for "an admin-generated magic link". #99 then removed the magic
 * link from the app — sign-in is `signInWithPassword` through /join's Sign in tab, and
 * /auth/callback exchanges only a PKCE `?code=`, which an admin-generated link never carries. An
 * admin link could still mint a session, but only by injecting cookies around the sign-in screen,
 * which would prove a route no member takes. Owner decision at pickup, 2026-09-21: seed the people
 * pre-confirmed with `auth.admin.createUser` — still never `signUp`, which the issue forbids for the
 * reason cairn's `supabase-auth-for-automated-suites` records — and sign in through the form members
 * actually use.
 *
 * WHY THE FIXTURE REUSES perf:floor's WRITER
 *
 * `fixtureSql` in `lighthouse-floor-core.mjs` already knows every column the seed tables require
 * (the club's theme since 0028, the rating scale since 0011). A second writer would be a second place
 * to update when the schema moves, and the one that was forgotten would fail at seed time on a pull
 * request that had nothing to do with it. So the plan here has the same shape as perf:floor's, and
 * the club row is perf:floor's own (`fixtureId("club", 0)` in both), so the two can share a stack.
 */

import { fixtureId, fixtureSql, refuseNonLocalStack } from "./lighthouse-floor-core.mjs";

export { refuseNonLocalStack };

/** Both people sign in with it. A local-only stack, so a literal is fine; it never reaches the live project. */
export const SMOKE_PASSWORD = "smoke-core-path-45";

/**
 * The crew's phone: what acceptance reveals, and the one string the whole run turns on. Distinctive
 * enough that it cannot occur on a page by accident (no date, id or price renders as this), which is
 * what makes its ABSENCE from the pre-acceptance page a statement about contact rather than about
 * luck. 555-01xx is the range reserved for fiction.
 */
export const CREW_PHONE = "614-555-0145";

/**
 * The fixture as data: one club, one upcoming race day, a skipper with a boat, and a rated crew.
 *
 * What is seeded and what is left to the browser is the point. Everything AC 1 names as a STEP —
 * the availability, the post, the answer, the acceptance — is absent here and is done through the
 * pages; everything it does not — the boat, the rating, the phone — is seeded, because a profile
 * screen driven here would be a second smoke of a different path.
 *
 * The race is a week out, derived from `now` rather than pinned, for perf:floor's reason: a pinned
 * date sails, and a post against a sailed date is refused (0006's insert policy), so a literal would
 * turn this red on a calendar date with nothing in the repo having changed.
 */
export function smokePlan({ now = new Date() } = {}) {
  const WEEK = 7 * 24 * 3600 * 1000;
  const crew = {
    id: fixtureId("smoke-person", 0),
    email: "smoke-crew@fixture.invalid",
    displayName: "Smoke Crew",
    // The top of 0011's scale: the crew clears any minimum the boat defaults to, so the rung the post
    // opens at cannot be what keeps them off the candidate list.
    rating: 4,
    phone: CREW_PHONE,
  };
  const skipper = {
    id: fixtureId("smoke-person", 1),
    email: "smoke-skipper@fixture.invalid",
    displayName: "Smoke Skipper",
    rating: 2,
    phone: null,
  };
  const date = {
    id: fixtureId("smoke-race-date", 0),
    startsAt: new Date(now.getTime() + WEEK).toISOString(),
    title: "Smoke Series 1",
  };
  const boat = {
    id: fixtureId("smoke-boat", 0),
    ownerId: skipper.id,
    name: "Smoke Test",
    class: "Thistle",
    defaultMinimum: 2,
  };
  return {
    crew,
    skipper,
    date,
    boat,
    // fixtureSql's shape. Posts, matches, availability and answers are empty on purpose — see above.
    people: [crew, skipper],
    dates: [date],
    boats: [boat],
    posts: [],
    matches: [],
    availability: [],
    answers: [],
  };
}

const q = (s) => `'${String(s).replaceAll("'", "''")}'`;

/**
 * Remove whatever an earlier run of this plan left behind, so a local re-run starts from the state
 * CI does. Deleting the auth users cascades to `person` and from there to `availability`, `answer`
 * and `person_contact`; but since 0027 a deleted owner leaves the BOAT behind ownerless, and
 * fixtureSql's `on conflict (id) do nothing` would then keep that ownerless boat — the skipper
 * would sign in to "You need a boat first". So the post and the boat go explicitly, first.
 * The club stays: it may be perf:floor's, and both plans want it.
 */
export function smokeResetSql(plan) {
  const people = plan.people.map((p) => q(p.id)).join(", ");
  return [
    "begin;",
    `delete from public.post where boat_id = ${q(plan.boat.id)} or race_date_id = ${q(plan.date.id)};`,
    `delete from public.boat where id = ${q(plan.boat.id)};`,
    `delete from public.race_date where id = ${q(plan.date.id)};`,
    `delete from auth.users where id in (${people});`,
    "commit;",
  ].join("\n");
}

/**
 * The rows, as SQL run by `postgres` after the auth users exist (person.id references auth.users).
 * fixtureSql does not write a phone — perf:floor never needed one — so it is set here, after the
 * contact row exists, and the statement must touch exactly the one row: `smoke.mjs` reads the
 * count back rather than trusting an UPDATE that matched nothing, which does not throw.
 */
export function smokeSeedSql(plan) {
  const phones = plan.people
    .filter((p) => p.phone)
    .map((p) => `update public.person_contact set phone = ${q(p.phone)} where person_id = ${q(p.id)} returning person_id;`);
  return [fixtureSql(plan, { clubName: "Smoke Sailing Club" }), ...phones].join("\n");
}

/**
 * The verdict on AC 1's last clause: *the crew's phone is visible to the skipper only after
 * acceptance*. Returns the failures, empty when it holds.
 *
 * Three readings, and the third is what makes the first worth anything. `before` is the skipper's
 * /post/<id> as raw HTML — the RSC payload included, which is the right subject for an ABSENCE,
 * since a phone in the flight data is a phone sent to the browser whether or not it was painted.
 * `after` is the same page, read the same way, once the match exists: the phone must now be in it.
 * If it is not, the absence before proves nothing — the instrument could not see a phone at all
 * (cairn: satisfying-a-negative-claim-destroys-its-instrument). `afterContact` is the rendered text
 * of the contact list, the place a skipper would actually read it — `innerText`, never
 * `textContent`, which on a `next` page folds in the inline script payload.
 */
export function contactVerdict({ phone, before, after, afterContact }) {
  const failures = [];
  if (!phone) return ["no phone to look for — the fixture seeded none, so nothing below could mean anything"];
  if (typeof before !== "string" || !before.length) failures.push("no pre-acceptance page was read");
  else if (before.includes(phone)) failures.push(`the crew's phone ${phone} reached the skipper BEFORE acceptance`);
  if (typeof after !== "string" || !after.length) failures.push("no post-acceptance page was read");
  else if (!after.includes(phone))
    failures.push(`the crew's phone ${phone} is not in the page after acceptance, so its absence before proves nothing`);
  if (typeof afterContact !== "string" || !afterContact.includes(phone))
    failures.push(`the skipper's contact panel does not show the crew's phone after acceptance (read: ${JSON.stringify(afterContact ?? null)})`);
  return failures;
}

/**
 * The run as a list of named steps, stopped at the first failure. A later step's input comes from
 * an earlier one — the post id the board shows, the answer the post page records — so carrying on
 * past a failure produces confident-looking failures about the wrong thing (cairn:
 * supabase-auth-for-automated-suites, *the cascade*). `runSteps` records what ran, what failed and
 * what was never reached, so a red run names the step that broke and says the rest did not run
 * rather than letting them read as failed or passed.
 *
 * @param {{ name: string, run: () => Promise<void> }[]} steps
 * @param {(line: string) => void} [log]
 */
export async function runSteps(steps, log = () => {}) {
  const results = [];
  let failed = null;
  for (const step of steps) {
    if (failed) {
      results.push({ name: step.name, status: "not reached" });
      continue;
    }
    const t0 = Date.now();
    try {
      await step.run();
      results.push({ name: step.name, status: "ok", ms: Date.now() - t0 });
      log(`ok    ${step.name} (${Date.now() - t0} ms)`);
    } catch (e) {
      failed = step.name;
      const message = e instanceof Error ? e.message : String(e);
      results.push({ name: step.name, status: "FAILED", ms: Date.now() - t0, message });
      log(`FAIL  ${step.name}: ${message}`);
    }
  }
  for (const r of results.filter((r) => r.status === "not reached")) log(`--    ${r.name}: not reached`);
  return { ok: failed === null, failed, results };
}
