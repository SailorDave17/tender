#!/usr/bin/env node
/**
 * smoke — the core path, driven through a real browser against a local Supabase stack. Story #45.
 *
 *     npm run smoke -- --db-container supabase_db_<dir> --base-url http://localhost:3000
 *
 * with NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY set to the STACK's values — the same
 * names the app reads, so CI sets them once for the build, the server and this. Everything that
 * decides an outcome — the fixture, the reset, the contact verdict, the step sequencing — is in
 * `smoke-core.mjs`, where `test/smoke-core.test.ts` exercises it with no stack and no browser. What
 * is left here is Docker, GoTrue, Chrome and the pages, which are the things a test cannot supply.
 * Same split as `lighthouse-floor.mjs`.
 *
 * THIS RUNS AGAINST A LOCAL STACK, NEVER THE LIVE PROJECT, AND THAT IS ENFORCED. It deletes and
 * re-creates two auth users and a race day, so `refuseNonLocalStack()` refuses any Supabase URL
 * that is not loopback before anything is written. It also deliberately does not load `.env.local`
 * (the npm script has no `--env-file`), which holds the live project's URL: the variables come from
 * the environment the caller built, or the run refuses.
 *
 * THE BROWSER is the machine's own Chrome through `playwright-core` (`channel: "chrome"`) — owner
 * decision at pickup: no browser download, `npm ci` untouched, and `ubuntu-latest` ships Chrome.
 * The runner's Chrome is therefore not pinned; a red run that reproduces nowhere else should be read
 * with that in mind.
 *
 * AC 2's mutation — "the accept step deleted" — is the `skipper accepts` step below. Removing it
 * must turn the run red at the step after it, and ONLY there: every earlier step stays ok, which is
 * what shows the red came from the missing acceptance rather than from a stack that never started.
 *
 * SINCE #220 THE RUN ALSO SIGNS SOMEBODY UP. The last two steps take a third browser context
 * through the invite entrance the way a new member does: the Sign up tab, the seeded invite code,
 * an email and a password, then /welcome ("Finish your profile", #219) with a provisional name to
 * replace, then the board as themselves. It closes the gap the README's "what it cannot see" used
 * to name — no end-to-end test covered sign-up — and it runs after the core path so a red there
 * cannot be mistaken for one here.
 *
 * SINCE #226 A FOURTH CONTEXT ARRIVES BY THE INVITE LINK, which carries the code, and types none.
 * First with last season's code: the route's refusal is shown and no account exists. Then with
 * this season's: the account is made and they land on /welcome. The same address both times, so
 * the second landing is itself proof the first made nothing.
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createClient } from "@supabase/supabase-js";
import { chromium } from "playwright-core";

import {
  SMOKE_INVITE_CODE,
  SMOKE_PASSWORD,
  SMOKE_STALE_INVITE_CODE,
  SMOKE_WRONG_CODE_SENTENCE,
  accountCountSql,
  contactVerdict,
  expectedSeedLines,
  inviteLinkPath,
  openPageVerdict,
  refuseNonLocalStack,
  runSteps,
  smokePlan,
  smokeResetSql,
  smokeSeedSql,
} from "./smoke-core.mjs";

function parseArgs(argv) {
  const args = { baseUrl: "http://localhost:3000", dbContainer: null, out: "smoke-output", headed: false };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, inline] = argv[i].split(/=(.*)/s);
    const value = () => inline ?? argv[++i];
    if (flag === "--base-url") args.baseUrl = value();
    else if (flag === "--db-container") args.dbContainer = value();
    else if (flag === "--out") args.out = value();
    else if (flag === "--headed") args.headed = true;
    // Refused rather than ignored, as migrate-live.mjs and lighthouse-floor.mjs refuse one: a
    // silently dropped flag is a run doing something other than what was asked for.
    else throw new Error(`unknown argument ${argv[i]}`);
  }
  if (!args.dbContainer) throw new Error("--db-container supabase_db_<dir> is required (the stack's Postgres container)");
  return args;
}

/** SQL as `postgres` inside the stack's own container — grant-independent, and no psql on the host needed. */
function psql(container, sql) {
  const r = spawnSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-Atq", "-v", "ON_ERROR_STOP=1", "-f", "-"], {
    input: sql,
    encoding: "utf8",
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`psql failed (${r.status}):\n${r.stderr || r.stdout}`);
  return r.stdout;
}

async function seed({ stack, serviceKey, dbContainer, plan }) {
  psql(dbContainer, smokeResetSql(plan));
  const admin = createClient(stack, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });
  for (const p of plan.people) {
    // Pre-confirmed, through the admin API — never signUp (#45's own terms). The id is passed so the
    // rows below and the selectors in the steps can name this person before the browser has seen them.
    const { data, error } = await admin.auth.admin.createUser({
      id: p.id,
      email: p.email,
      password: SMOKE_PASSWORD,
      email_confirm: true,
    });
    if (error) throw new Error(`createUser ${p.email}: ${error.message}`);
    if (data.user?.id !== p.id) throw new Error(`createUser ${p.email} returned id ${data.user?.id}, not ${p.id}`);
  }
  // `returning person_id` makes the phone UPDATE count itself: one line per row it touched. An UPDATE
  // matching nothing does not throw, and a crew with no phone would make the whole contact check
  // vacuous — contactVerdict would be looking for a string nobody stored. The club's support address
  // (#147) counts itself the same way, after the phones.
  const touched = psql(dbContainer, smokeSeedSql(plan)).split(/\r?\n/).filter(Boolean);
  const expected = expectedSeedLines(plan);
  if (touched.join(",") !== expected.join(",")) {
    throw new Error(`seed touched [${touched.join(", ")}], expected [${expected.join(", ")}]`);
  }
}

/** `next start` answers before its first request is served; wait for any HTTP answer at all. */
async function waitForServer(baseUrl, ms = 60_000) {
  const until = Date.now() + ms;
  let last = null;
  while (Date.now() < until) {
    try {
      await fetch(new URL("/join", baseUrl), { redirect: "manual" });
      return;
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`nothing answered at ${baseUrl} within ${ms / 1000} s (${last?.cause?.code ?? last?.message})`);
}

/**
 * Sign in the way a member does: /join, the Sign in tab, email and password. Since #123 /join opens
 * on Sign up for a device it does not recognise, which a fresh context always is, so the tab is
 * clicked — and the click doubles as the hydration gate (a server-rendered form proves nothing about
 * whether its submit handler exists yet). Bounded retry, because on a cold server the first click
 * can land before the handler's chunk has arrived.
 */
async function signIn(page, baseUrl, person) {
  await page.goto(new URL("/join", baseUrl).href);
  let form = null;
  for (let attempt = 0; attempt < 5 && !form; attempt += 1) {
    await page.click('button[data-mode="signin"]');
    form = await page.waitForSelector('form[data-form="signin"]', { timeout: 2000 }).catch(() => null);
  }
  if (!form) throw new Error("the Sign in tab never showed its form");
  await page.fill('form[data-form="signin"] input[name="email"]', person.email);
  await page.fill('form[data-form="signin"] input[name="password"]', SMOKE_PASSWORD);
  await Promise.all([page.waitForURL((u) => u.pathname === "/board"), page.click('form[data-form="signin"] button[type="submit"]')]);
  // Whose board it is, not merely that a board rendered: two contexts, two people. Since #154 the
  // identity line is the shell's, in the header, not the board's <main> — read it where it lives.
  const who = await page.innerText("header [data-who]");
  if (!who.includes(`Signed in as ${person.displayName}`)) throw new Error(`the header does not say "Signed in as ${person.displayName}"`);
}

/**
 * Arrive the way an invitee does (#226): open the invite link, which lands on the Sign up tab with
 * the code in the panel, and fill in the account — everything but the code, which is never typed.
 *
 * The hydration gate is a round trip through the Sign in tab. The link's page is SERVER-rendered on
 * Sign up, so waiting for the sign-up form proves nothing about whether its submit handler exists
 * yet; the Sign in form appears only once the client is running. Coming back to Sign up re-mounts
 * the form from the same prop, so the code is read twice — as served, and once the client has it.
 */
async function arriveByInviteLink(page, baseUrl, code, email) {
  await page.goto(new URL(inviteLinkPath(code), baseUrl).href);
  const box = 'form[data-form="signup"] input[name="code"]';
  const served = await page.inputValue(box);
  if (served !== code) throw new Error(`the served page's code box holds ${JSON.stringify(served)}, not the link's ${JSON.stringify(code)}`);
  let signin = null;
  for (let attempt = 0; attempt < 5 && !signin; attempt += 1) {
    await page.click('button[data-mode="signin"]');
    signin = await page.waitForSelector('form[data-form="signin"]', { timeout: 2000 }).catch(() => null);
  }
  if (!signin) throw new Error("the Sign in tab never showed its form (the page did not hydrate)");
  await page.click('button[data-mode="signup"]');
  await page.waitForSelector('form[data-form="signup"]');
  const hydrated = await page.inputValue(box);
  if (hydrated !== code) throw new Error(`after hydration the code box holds ${JSON.stringify(hydrated)}, not the link's ${JSON.stringify(code)}`);
  await page.fill('form[data-form="signup"] input[name="email"]', email);
  await page.fill('form[data-form="signup"] input[name="password"]', SMOKE_PASSWORD);
  await page.fill('form[data-form="signup"] input[name="confirm"]', SMOKE_PASSWORD);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const stack = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!stack || !serviceKey) {
    throw new Error("set NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to the local stack's values (supabase status)");
  }
  const refusal = refuseNonLocalStack(stack);
  if (refusal) throw new Error(refusal);

  const plan = smokePlan();
  const { crew, skipper, newcomer, linkedNewcomer, date, boat } = plan;
  const t0 = Date.now();
  const log = (line) => process.stdout.write(`${line}\n`);

  await seed({ stack, serviceKey, dbContainer: args.dbContainer, plan });
  log(`seeded: ${crew.email}, ${skipper.email}, race day ${date.startsAt}, boat ${boat.name}; ${newcomer.email} and ${linkedNewcomer.email} cleared for the sign-up`);
  await waitForServer(args.baseUrl);

  const browser = await chromium.launch({ channel: "chrome", headless: !args.headed });
  const pages = {};
  for (const who of ["crew", "skipper", "newcomer", "linked"]) {
    // One context per person: separate cookie jars, so each session is its own.
    const page = await (await browser.newContext()).newPage();
    page.setDefaultTimeout(15_000);
    pages[who] = page;
  }
  const url = (path) => new URL(path, args.baseUrl).href;
  let postId = null;
  let before = null;

  const steps = [
    {
      // #147: the two pages madcowsailing.com links to, as a stranger reaches them. Node's fetch has
      // no cookie jar, so the request carries no session, and `redirect: "manual"` keeps a 302 to
      // /join a 302 rather than following it to a sign-in page that also answers 200.
      name: "support and privacy answer 200 signed out",
      run: async () => {
        const failures = [];
        for (const path of ["/support", "/privacy"]) {
          const res = await fetch(url(path), { redirect: "manual" });
          const body = await res.text();
          failures.push(...openPageVerdict({ path, status: res.status, location: res.headers.get("location"), body }));
        }
        if (failures.length) throw new Error(failures.join("; "));
      },
    },
    { name: "crew signs in", run: () => signIn(pages.crew, args.baseUrl, crew) },
    { name: "skipper signs in", run: () => signIn(pages.skipper, args.baseUrl, skipper) },
    {
      name: "crew marks the race day",
      run: async () => {
        const p = pages.crew;
        await p.goto(url("/board"));
        const day = `li[data-race-date="${date.id}"]`;
        await p.click(`${day} button[aria-pressed="false"]`);
        // The toggle posts back to /board from /board, so waitForURL would resolve at once; wait on
        // the re-render instead.
        await p.waitForSelector(`${day}[data-available="true"]`);
      },
    },
    {
      name: "skipper posts a crew need",
      run: async () => {
        const p = pages.skipper;
        await p.goto(url(`/post/new?boat=${boat.id}`));
        // /post/new branches four ways; say which one rendered rather than timing out on a select
        // that the page, correctly, did not draw.
        for (const branch of ["data-no-boats", "data-pick-boat", "data-no-dates"]) {
          if (await p.$(`[${branch}]`)) throw new Error(`/post/new rendered its ${branch} branch, not the form`);
        }
        await p.selectOption('select[name="race_date_id"]', date.id);
        if (!(await p.$('input[name="minimum"]:checked'))) throw new Error("no minimum is checked");
        await p.fill('textarea[name="note"]', "Smoke run: jib trimmer wanted.");
        await Promise.all([p.waitForURL((u) => u.pathname === "/board"), p.click('button:has-text("Post it")')]);
        // Since #154 the board has a loading route, so the navigation commits with "Loading…" in
        // <main> and the page streams in after — waitForURL resolves before the race days exist.
        // Wait for the day itself; a count taken before it is 0 on a correct board (measured on CI).
        await p.waitForSelector(`li[data-race-date="${date.id}"]`);
        const ids = await p.$$eval(`li[data-race-date="${date.id}"] li[data-post]`, (els) => els.map((e) => e.getAttribute("data-post")));
        if (ids.length !== 1) throw new Error(`expected one post under the race day on the board, found ${ids.length}`);
        postId = ids[0];
      },
    },
    {
      name: "crew answers",
      run: async () => {
        const p = pages.crew;
        await p.goto(url(`/post/${postId}`));
        await p.waitForSelector('section[data-answer-state="can"]');
        await p.click('section[data-answer-state="can"] button:has-text("I can")');
        await p.waitForSelector('section[data-answer-state="answered"]');
      },
    },
    {
      name: "skipper sees the answer, with no phone yet",
      run: async () => {
        const p = pages.skipper;
        await p.goto(url(`/post/${postId}`));
        await p.waitForSelector(`button[data-accept="${crew.id}"]`);
        if (!(await p.$(`p[data-post="${postId}"][data-matched="false"]`))) throw new Error("the post does not read unmatched");
        before = await p.content();
      },
    },
    {
      name: "skipper accepts",
      run: async () => {
        const p = pages.skipper;
        await p.click(`button[data-accept="${crew.id}"]`);
        await p.waitForSelector('section[data-status="matched"][data-role="skipper"]');
      },
    },
    {
      name: "the crew's phone is visible to the skipper only after acceptance",
      run: async () => {
        const p = pages.skipper;
        // A fresh load: after a Server Action's client transition the document still carries the
        // pre-action flight payload, so this is the page as the server now serves it.
        await p.goto(url(`/post/${postId}`));
        const after = await p.content();
        const panel = await p.$(`dl[data-contact="${crew.id}"]`);
        const afterContact = panel ? await panel.innerText() : null;
        const failures = contactVerdict({ phone: crew.phone, before, after, afterContact });
        if (failures.length) throw new Error(failures.join("; "));
      },
    },
    {
      // #220 AC 5: the invite entrance, end to end, in a context nobody has signed in on. The
      // Sign up tab is clicked for the same reason the Sign in tab is above — the click is the
      // hydration gate. What is asserted on the way: the invite code is the first input and the
      // form asks for no name and ticks no box (AC 1 as served), and the account lands on
      // /welcome rather than the board (AC 3).
      name: "a newcomer signs up with the invite code and lands on /welcome",
      run: async () => {
        const p = pages.newcomer;
        await p.goto(url("/join"));
        let form = null;
        for (let attempt = 0; attempt < 5 && !form; attempt += 1) {
          await p.click('button[data-mode="signup"]');
          form = await p.waitForSelector('form[data-form="signup"]', { timeout: 2000 }).catch(() => null);
        }
        if (!form) throw new Error("the Sign up tab never showed its form");
        const first = await p.$eval('form[data-form="signup"] input', (el) => el.name);
        if (first !== "code") throw new Error(`the sign-up form's first input is "${first}", not the invite code`);
        if (await p.$('form[data-form="signup"] input[name="displayName"], form[data-form="signup"] input[type="checkbox"]')) {
          throw new Error("the sign-up form still asks for a name or ticks a box");
        }
        await p.fill('form[data-form="signup"] input[name="code"]', SMOKE_INVITE_CODE);
        await p.fill('form[data-form="signup"] input[name="email"]', newcomer.email);
        await p.fill('form[data-form="signup"] input[name="password"]', SMOKE_PASSWORD);
        await p.fill('form[data-form="signup"] input[name="confirm"]', SMOKE_PASSWORD);
        await Promise.all([
          p.waitForURL((u) => u.pathname === "/welcome"),
          p.click('form[data-form="signup"] button:has-text("Create my account")'),
        ]);
        // The page, not only the URL: /welcome streams like every page since #154, and its own
        // hook is what says it rendered rather than an error boundary.
        await p.waitForSelector('main[data-page="welcome"]');
      },
    },
    {
      name: "the newcomer gives a name on /welcome and reaches the board as themselves",
      run: async () => {
        const p = pages.newcomer;
        // The provisional name is the address's local part (#220), pre-filled for them to replace.
        const prefilled = await p.inputValue('main[data-page="welcome"] input[name="displayName"]');
        const local = newcomer.email.split("@")[0];
        if (prefilled !== local) throw new Error(`/welcome pre-filled "${prefilled}", not the provisional name "${local}"`);
        await p.fill('main[data-page="welcome"] input[name="displayName"]', newcomer.displayName);
        await Promise.all([p.waitForURL((u) => u.pathname === "/board"), p.click("button[data-finish]")]);
        // Whose board: the name they just gave, in the shell's header (as signIn reads it).
        const who = await p.innerText("header [data-who]");
        if (!who.includes(`Signed in as ${newcomer.displayName}`)) {
          throw new Error(`the header does not say "Signed in as ${newcomer.displayName}" (read ${JSON.stringify(who)})`);
        }
      },
    },
    {
      // #226 AC 4: an invite link from before a rotation. The refusal is the route's own sentence,
      // the member is still on /join, and the address holds no account — read from auth.users as
      // postgres, because a sign-up that created the user and THEN refused would look the same on
      // screen.
      name: "a newcomer arriving by a link with last season's code is refused, and no account is made",
      run: async () => {
        const p = pages.linked;
        await arriveByInviteLink(p, args.baseUrl, SMOKE_STALE_INVITE_CODE, linkedNewcomer.email);
        await p.click('form[data-form="signup"] button:has-text("Create my account")');
        // `main`, so Next's route announcer (also role="alert", in a shadow root Playwright pierces)
        // is never the match; and wait for text, since the region can exist before it is filled.
        const alert = 'main p[role="alert"]';
        await p.waitForFunction((sel) => (document.querySelector(sel)?.textContent ?? "").length > 0, alert);
        const said = await p.innerText(alert);
        if (said !== SMOKE_WRONG_CODE_SENTENCE) throw new Error(`the refusal read ${JSON.stringify(said)}, not ${JSON.stringify(SMOKE_WRONG_CODE_SENTENCE)}`);
        if (new URL(p.url()).pathname !== "/join") throw new Error(`a refused sign-up left /join for ${p.url()}`);
        const count = psql(args.dbContainer, accountCountSql(linkedNewcomer.email)).trim();
        if (count !== "0") throw new Error(`the refused sign-up made an account: ${count} auth user(s) hold ${linkedNewcomer.email}`);
      },
    },
    {
      // #226 AC 3: the invite link as sent, with this season's code. Nothing is typed in the panel
      // — arriveByInviteLink reads the code out of it twice and never fills it — and the account
      // lands on /welcome. Same address as the refusal above, so this landing is also the proof
      // that the refusal created nothing: an existing account answers "you already have one".
      name: "a newcomer arriving by the invite link signs up with no code typed and lands on /welcome",
      run: async () => {
        const p = pages.linked;
        await arriveByInviteLink(p, args.baseUrl, SMOKE_INVITE_CODE, linkedNewcomer.email);
        await Promise.all([
          p.waitForURL((u) => u.pathname === "/welcome"),
          p.click('form[data-form="signup"] button:has-text("Create my account")'),
        ]);
        await p.waitForSelector('main[data-page="welcome"]');
      },
    },
  ];

  let outcome;
  try {
    outcome = await runSteps(steps, log);
    if (!outcome.ok) {
      // What each person's browser was showing when it stopped: the first thing to open on a red run.
      mkdirSync(args.out, { recursive: true });
      for (const [who, page] of Object.entries(pages)) {
        await page.screenshot({ path: join(args.out, `${who}.png`), fullPage: true }).catch(() => undefined);
        writeFileSync(join(args.out, `${who}.html`), await page.content().catch(() => ""));
        log(`saved ${join(args.out, `${who}.png`)} (${page.url()})`);
      }
    }
  } finally {
    await browser.close();
  }
  log(`${outcome.ok ? "PASS" : `FAIL at "${outcome.failed}"`} — ${outcome.results.filter((r) => r.status === "ok").length}/${steps.length} steps, ${Math.round((Date.now() - t0) / 1000)} s`);
  process.exitCode = outcome.ok ? 0 : 1;
}

main().catch((e) => {
  process.stderr.write(`smoke: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
