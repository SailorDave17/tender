import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { UUID } from "@/post/post-form";
import { fixtureId, fixtureSql } from "../scripts/lighthouse-floor-core.mjs";
import {
  CREW_PHONE,
  SEED_CLUB_MARK,
  SMOKE_INVITE_CODE,
  SUPPORT_EMAIL,
  contactVerdict,
  expectedSeedLines,
  openPageVerdict,
  refuseNonLocalStack,
  runSteps,
  smokePlan,
  smokeResetSql,
  smokeSeedSql,
} from "../scripts/smoke-core.mjs";

/**
 * The half of `npm run smoke` that can be tested without Docker, Chrome or a network (story #45),
 * and the two lines of `.github/workflows/ci.yml` that AC 3 is about.
 *
 * The smoke itself runs only in CI's `smoke` job and by hand against a local stack, so what is
 * held here is everything whose failure would make a red or green run MEAN something other than
 * it says: a contact verdict that could not see a leak, a step runner that carried on into steps
 * whose inputs never existed, a fixture that seeded the very state the browser is meant to create,
 * a reset that left the one row which makes a local re-run lie. Each has a case feeding it the
 * state it must refuse, because a real run only ever produces healthy output and cannot tell a
 * working check from one that passes everything (cairn: a-session-instrument-is-not-a-repo-command).
 */

const NOW = new Date("2026-09-21T12:00:00Z");
const plan = smokePlan({ now: NOW });

describe("smokePlan", () => {
  it("seeds the people, the day and the boat, and NONE of the states the browser has to create", () => {
    // AC 1's steps are the availability, the post, the answer and the acceptance. A seeded one is a
    // step the smoke would pass without the page ever having done it.
    expect(plan.availability).toEqual([]);
    expect(plan.posts).toEqual([]);
    expect(plan.answers).toEqual([]);
    expect(plan.matches).toEqual([]);
    expect(plan.people.map((p) => p.id)).toEqual([plan.crew.id, plan.skipper.id]);
    expect(plan.dates).toEqual([plan.date]);
    expect(plan.boats).toEqual([plan.boat]);
  });

  it("gives the crew the phone the verdict looks for, and the skipper none", () => {
    expect(plan.crew.phone).toBe(CREW_PHONE);
    expect(plan.skipper.phone).toBeNull();
  });

  it("puts the boat with the skipper and clears the crew over its default minimum", () => {
    expect(plan.boat.ownerId).toBe(plan.skipper.id);
    // The minimum the post defaults to must not be what keeps the crew off the candidate list.
    expect(plan.crew.rating).toBeGreaterThanOrEqual(plan.boat.defaultMinimum);
  });

  it("dates the race a week after now, so it is upcoming whenever the smoke runs", () => {
    expect(Date.parse(plan.date.startsAt) - NOW.getTime()).toBe(7 * 24 * 3600 * 1000);
    const later = smokePlan({ now: new Date("2027-05-01T00:00:00Z") });
    expect(Date.parse(later.date.startsAt)).toBeGreaterThan(Date.parse("2027-05-01T00:00:00Z"));
  });

  it("keeps the newcomer OUT of the seeded people, so the form has to create them (#220 AC 5)", () => {
    // Seeding the newcomer would make the sign-up a step the smoke passes without the form running.
    expect(plan.newcomer.email).toMatch(/@fixture\.invalid$/);
    expect(plan.people.map((p) => p.email)).not.toContain(plan.newcomer.email);
    expect(plan.newcomer).not.toHaveProperty("id");
    // ...and the address is nobody's admin_email, so 0009's trigger does not make them the admin
    expect(plan.newcomer.email.toLowerCase()).not.toBe(SUPPORT_EMAIL.toLowerCase());
  });

  it("types the invite code the seed put on the club row, so the two cannot disagree (#220 AC 5)", () => {
    expect(SMOKE_INVITE_CODE.length).toBeGreaterThan(0);
    expect(fixtureSql(plan)).toContain(`'${SMOKE_INVITE_CODE}'`);
    expect(smokeSeedSql(plan)).toContain(`'${SMOKE_INVITE_CODE}'`);
  });

  it("uses ids /post/[id] would accept, distinct from each other and from perf:floor's", () => {
    const ids = [plan.crew.id, plan.skipper.id, plan.date.id, plan.boat.id];
    for (const id of ids) expect(id).toMatch(UUID);
    expect(new Set(ids).size).toBe(ids.length);
    // Both commands can seed one stack; only the club row is meant to be shared.
    expect(ids).not.toContain(fixtureId("person", 0));
    expect(ids).not.toContain(fixtureId("race_date", 0));
    expect(ids).not.toContain(fixtureId("boat", 0));
  });
});

describe("smokeSeedSql", () => {
  const sql = smokeSeedSql(plan);

  it("sets the crew's phone after the contact row exists, and nobody else's", () => {
    const contact = sql.indexOf(`insert into public.person_contact (person_id, email) values ('${plan.crew.id}'`);
    const phone = sql.indexOf(`update public.person_contact set phone = '${CREW_PHONE}' where person_id = '${plan.crew.id}' returning person_id;`);
    expect(contact).toBeGreaterThan(-1);
    expect(phone).toBeGreaterThan(contact);
    expect(sql.match(/set phone =/g)).toHaveLength(1);
  });

  it("writes no availability, post, answer or match row", () => {
    expect(sql).not.toMatch(/insert into public\.(availability|post|answer|match) /);
  });

  it("gives the club row the support address /support must show, counted after the phones (#147)", () => {
    const club = `update public.club set admin_email = '${SUPPORT_EMAIL}' where id = '${fixtureId("club", 0)}' returning '${SEED_CLUB_MARK}';`;
    expect(sql).toContain(club);
    // after the insert that creates the row, so it lands on a fresh stack as well as a re-used one
    expect(sql.indexOf(club)).toBeGreaterThan(sql.indexOf("insert into public.club"));
    expect(sql.match(/set admin_email =/g)).toHaveLength(1);
    // the seed check in smoke.mjs reads exactly these lines back, in this order
    expect(expectedSeedLines(plan)).toEqual([plan.crew.id, SEED_CLUB_MARK]);
  });

  it("uses an address that is nobody's, so 0009's trigger makes neither smoke person the admin", () => {
    expect(plan.people.map((p) => p.email.toLowerCase())).not.toContain(SUPPORT_EMAIL.toLowerCase());
  });
});

describe("openPageVerdict (#147)", () => {
  const support = `<main data-page="support"><a href="mailto:${SUPPORT_EMAIL}">${SUPPORT_EMAIL}</a></main>`;
  const privacy = `<main data-page="privacy"><h1>Privacy</h1></main>`;

  it("passes both pages answering 200 with their content", () => {
    expect(openPageVerdict({ path: "/support", status: 200, location: null, body: support })).toEqual([]);
    expect(openPageVerdict({ path: "/privacy", status: 200, location: null, body: privacy })).toEqual([]);
  });

  it("refuses a redirect to the sign-in page, naming where it went", () => {
    const out = openPageVerdict({ path: "/privacy", status: 302, location: "/join", body: "" });
    expect(out).toContain("/privacy answered 302 (to /join), not 200");
  });

  it("refuses a 200 that did not render the page — a streamed error boundary answers 200 too", () => {
    const boundary = `<main data-error><h1>Something went wrong</h1></main>`;
    expect(openPageVerdict({ path: "/privacy", status: 200, location: null, body: boundary })).toEqual([
      '/privacy did not render its page (no data-page="privacy" in the response)',
    ]);
  });

  it("refuses a /support that rendered without the club row's address — a default or the fallback", () => {
    const fallback = `<main data-page="support"><p data-contact="none">Ask whoever…</p></main>`;
    expect(openPageVerdict({ path: "/support", status: 200, location: null, body: fallback })).toEqual([
      `/support does not link the club row's address ${SUPPORT_EMAIL}`,
    ]);
    const other = support.replaceAll(SUPPORT_EMAIL, "someone-else@fixture.invalid");
    expect(openPageVerdict({ path: "/support", status: 200, location: null, body: other })).toHaveLength(1);
  });
});

describe("smokeResetSql", () => {
  const sql = smokeResetSql(plan);

  it("removes the boat explicitly, since 0027 leaves a deleted owner's boat behind", () => {
    // Without this line a local re-run keeps an ownerless boat (fixtureSql's on-conflict-do-nothing
    // then skips the insert), and the skipper signs in to "You need a boat first".
    expect(sql).toContain(`delete from public.boat where id = '${plan.boat.id}';`);
    expect(sql.indexOf("delete from public.post")).toBeLessThan(sql.indexOf("delete from public.boat"));
  });

  it("removes both auth users, and leaves the club alone", () => {
    expect(sql).toContain(`delete from auth.users where id in ('${plan.crew.id}', '${plan.skipper.id}');`);
    expect(sql).not.toMatch(/public\.club/);
  });

  it("removes the newcomer by address, since the form gave them whatever id GoTrue chose (#220)", () => {
    // Without this a local re-run's sign-up is refused as "you already have an account here".
    expect(sql).toContain(`delete from auth.users where email = '${plan.newcomer.email}';`);
  });
});

describe("contactVerdict", () => {
  const ok = {
    phone: CREW_PHONE,
    before: "<html>…Accept…</html>",
    after: `<html>…Matched…${CREW_PHONE}…</html>`,
    afterContact: `Email\nsmoke-crew@fixture.invalid\nPhone\n${CREW_PHONE}`,
  };

  it("passes the healthy run", () => {
    expect(contactVerdict(ok)).toEqual([]);
  });

  it("refuses a phone that reached the skipper before acceptance", () => {
    const failures = contactVerdict({ ...ok, before: `<script>…"phone":"${CREW_PHONE}"…</script>` });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/BEFORE acceptance/);
  });

  it("refuses a pre-acceptance absence whose instrument never saw the phone at all", () => {
    // The positive control: the same read, after, must find it — else "absent before" is vacuous.
    const failures = contactVerdict({ ...ok, after: "<html>…Matched…</html>" });
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatch(/proves nothing/);
  });

  it("refuses a contact panel that does not show the phone, or was never found", () => {
    expect(contactVerdict({ ...ok, afterContact: "Phone\nnot given" })).toHaveLength(1);
    expect(contactVerdict({ ...ok, afterContact: null })).toHaveLength(1);
  });

  it("refuses a run in which a page was never read", () => {
    expect(contactVerdict({ ...ok, before: null })[0]).toMatch(/no pre-acceptance page/);
    expect(contactVerdict({ ...ok, after: "" })[0]).toMatch(/no post-acceptance page/);
  });

  it("refuses to judge when there is no phone to look for", () => {
    // An empty phone is contained in every string, so every check below would pass — and the count
    // alone cannot tell this refusal from the BEFORE-acceptance one that "" also trips. The reason can.
    expect(contactVerdict({ ...ok, phone: "" })).toEqual([expect.stringMatching(/no phone to look for/)]);
    expect(contactVerdict({ ...ok, phone: null })).toEqual([expect.stringMatching(/no phone to look for/)]);
  });
});

describe("runSteps", () => {
  it("stops at the first failure, and never runs what comes after it", async () => {
    const ran: string[] = [];
    const step = (name: string, fail = false) => ({
      name,
      run: async () => {
        ran.push(name);
        if (fail) throw new Error(`${name} broke`);
      },
    });
    const out = await runSteps([step("a"), step("b", true), step("c")]);
    expect(ran).toEqual(["a", "b"]);
    expect(out.ok).toBe(false);
    expect(out.failed).toBe("b");
    expect(out.results.map((r) => r.status)).toEqual(["ok", "FAILED", "not reached"]);
    expect(out.results[1].message).toBe("b broke");
  });

  it("reports ok only when every step ran", async () => {
    const out = await runSteps([{ name: "a", run: async () => {} }]);
    expect(out).toMatchObject({ ok: true, failed: null });
  });
});

describe("refuseNonLocalStack, as the smoke uses it", () => {
  it("refuses the hosted project and admits the local stack", () => {
    expect(refuseNonLocalStack("https://abcdefghijkl.supabase.co")).toMatch(/refusing/);
    expect(refuseNonLocalStack("http://127.0.0.1:54321")).toBeNull();
  });
});

describe("ci.yml's smoke job (AC 3)", () => {
  /** The `smoke:` job's own lines, up to the next job or the end of the file. */
  async function smokeJob() {
    const yml = await readFile(join(process.cwd(), ".github", "workflows", "ci.yml"), "utf8");
    const lines = yml.split(/\r?\n/);
    const start = lines.findIndex((l) => l === "  smoke:");
    expect(start, "ci.yml has no top-level `smoke:` job").toBeGreaterThan(-1);
    const end = lines.findIndex((l, i) => i > start && /^ {2}\S/.test(l));
    return { yml, job: lines.slice(start, end === -1 ? undefined : end).join("\n") };
  }

  it("runs on pull requests only — and the workflow does run on pushes, so the condition is what holds it", async () => {
    const { yml, job } = await smokeJob();
    expect(yml).toMatch(/^ {2}push:/m);
    expect(job).toMatch(/^ {4}if: github\.event_name == 'pull_request'$/m);
  });

  it("is cancelled at eight minutes rather than allowed to run past AC 3's budget", async () => {
    const { job } = await smokeJob();
    expect(job).toMatch(/^ {4}timeout-minutes: 8$/m);
  });

  it("runs the smoke against the container its own stack step names", async () => {
    const { job } = await smokeJob();
    expect(job).toContain('mkdir -p "$RUNNER_TEMP/smoke"');
    expect(job).toContain("npm run smoke -- --db-container supabase_db_smoke ");
  });

  it("authenticates GHCR pulls before starting Supabase, and only cats next.log if it exists", async () => {
    const { yml, job } = await smokeJob();
    expect(yml).toMatch(/^ {2}packages: read$/m);
    expect(job).toContain('docker login ghcr.io -u "${{ github.actor }}" --password-stdin');
    expect(job).toContain('test ! -f "$RUNNER_TEMP/next.log" || cat "$RUNNER_TEMP/next.log"');
  });
});
