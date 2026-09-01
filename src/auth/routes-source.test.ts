import { readdir, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

/**
 * #99. Until now this file opened with the two magic-link senders and the option they carried:
 * `shouldCreateUser: false` was what stopped an unknown address minting an attestation-less auth
 * user and spending a Resend send. Both senders are gone, so those assertions were **deleted
 * rather than left passing over code nothing calls** — an assertion about a call that no longer
 * exists cannot fail, and a green test whose subject has been removed is the most reassuring kind
 * of nothing (cairn: prove-a-guard-test-can-fail).
 *
 * The reason they existed did not go with them. *Nothing may mint an auth user that carries no
 * attestation* is still the rule; what changed is which mechanisms carry it, and there are two:
 *
 *   1. **the callback's delete branch** — `ensurePerson` deletes an auth user that arrives with no
 *      attestation and no gate pass (`src/auth/person.test.ts`, "deletes the auth user");
 *   2. **the gate's attestation stamp** — the invite gate writes its own attestation onto an
 *      existing unattested user rather than acting on one without (`src/auth/join.test.ts`,
 *      "stamps this submission's attestation").
 *
 * Both are behavioural and both are proven able to fail by mutation. What is left for this file
 * is the half no unit test can reach: what the ROUTES do, and what the tree as a whole no longer
 * contains.
 */

/**
 * AC 6 as a test rather than a command somebody remembers to run. The story's own instrument is
 * `git grep -n "signInWithOtp" -- src` returning zero, and a criterion that only a person can
 * check is a criterion that stops being checked after the day it was written.
 */
async function sourceFiles(dir: URL): Promise<URL[]> {
  const out: URL[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) out.push(...(await sourceFiles(child)));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(child);
  }
  return out;
}

describe("the magic link is gone from the tree, not just from the screens (#99 AC 6)", () => {
  it("no file under src/ calls signInWithOtp", async () => {
    const files = await sourceFiles(new URL("../", import.meta.url));
    // A positive control on the corpus itself: a scan that walked nothing would pass this test
    // silently, and "no hits" and "nothing was read" are the same observation (cairn:
    // an-absent-result-reads-as-a-clean-one).
    expect(files.length, "the scan really walked src/").toBeGreaterThan(40);
    // The needle is BUILT rather than written, because a file that spells it is a file this scan
    // finds — and this file is under src/. Its first run reported itself, which is the whole of
    // cairn's a-guard-that-reads-source-must-survive-its-own-docs in one line. Splitting at the
    // parenthesis keeps every fragment outside the shape being matched.
    const SENDER = "signInWithOtp" + "(";
    const hits: string[] = [];
    for (const f of files) {
      if ((await readFile(f, "utf8")).includes(SENDER)) hits.push(f.pathname);
    }
    expect(hits).toEqual([]);
    // ...and the scan can find one when there is one: the needle really does match the shape.
    expect(`client.auth.${SENDER}{ email })`).toContain(SENDER);
  });

  it("...and the one file that still names it only explains why the defence around it stays", async () => {
    // src/auth/link.ts contrasts linkIdentity's missing cleanup with signInWithOtp's. That is
    // prose about a library, not a call — the assertion above is anchored on the call, so this
    // one records that the distinction is deliberate rather than an oversight.
    const src = await readFile(new URL("./link.ts", import.meta.url), "utf8");
    expect(src).toMatch(/signInWithOtp/);
    expect(src).not.toMatch(/signInWithOtp\(/);
  });
});

/**
 * #99 AC 1, the half a unit test structurally cannot reach. join()'s deps carry nothing that
 * could send mail — `join.test.ts` proves that with a recorder that would catch any dep by any
 * name — but the PLATFORM has a mailer of its own: GoTrue sends a confirmation email on every
 * `createUser` unless `email_confirm: true` says the address is already confirmed. Dropping that
 * one flag puts an email back on the path with nothing in this app sending it, and no unit test
 * reads a route.
 */
describe("the invite gate sends nothing, and nothing sends on its behalf (#99 AC 1)", () => {
  const JOIN = "../app/api/join/route.ts";

  it("createUser confirms the address, so the platform sends no confirmation mail", async () => {
    const src = await readFile(new URL(JOIN, import.meta.url), "utf8");
    const call = src.slice(src.indexOf("admin.auth.admin.createUser("));
    expect(call.slice(0, call.indexOf(");"))).toMatch(/email_confirm:\s*true/);
  });

  it("the route has no mailer of any kind", async () => {
    const src = await readFile(new URL(JOIN, import.meta.url), "utf8");
    expect(src).not.toMatch(/signInWithOtp|resetPasswordForEmail|generateLink|sendEmail|resendTransport/);
  });

  it("it signs the member in itself, and mints the row through ensurePerson rather than inserting", async () => {
    const src = await readFile(new URL(JOIN, import.meta.url), "utf8");
    // #99 AC 2: the store is supplied here, the decision is join()'s, and `ensurePerson` stays
    // the only writer — a bare insert here would be a second one.
    expect(src).toMatch(/signInWithPassword/);
    expect(src).toMatch(/person: \{/);
    const deps = src.slice(src.indexOf("inviteCode: async"), src.lastIndexOf("},\n  );"));
    expect(deps).not.toMatch(/ensurePerson\(/);
  });
});

describe("the Forgot screen keeps one arm, and it is the reset (#99 AC 6)", () => {
  const FORGOT = "../app/api/forgot/route.ts";

  it("sends a password reset and nothing else, with no action selector left behind", async () => {
    const src = await readFile(new URL(FORGOT, import.meta.url), "utf8");
    expect(src).toMatch(/resetPasswordForEmail/);
    expect(src).not.toMatch(/signInWithOtp|body\.action|requestReset[\s\S]*signIn\(/);
    expect(src.match(/requestReset/g), "one arm, called once").toHaveLength(2); // import + call
  });
});

/**
 * #82. The Sign in screen is now email + password, and `signInWithPassword` returns a session
 * WITHOUT touching /auth/callback — so the terminal guard that deletes/refuses a rowless user
 * has to be re-applied on this path or a confirmed stray gets in (AC 7). `passwordSignIn` decides
 * that; this proves the route WIRES it (cairn: prove-a-guard-test-can-fail, twelfth outcome — a
 * unit test builds the call, the route is the call). No unit test reads a route.
 */
describe("/api/signin is a password sign-in that guards the callback bypass (#82 AC 3 / AC 7)", () => {
  const SIGNIN = "../app/api/signin/route.ts";

  it("authenticates with a password and never sends mail, reads an invite code, or creates a user", async () => {
    const src = await readFile(new URL(SIGNIN, import.meta.url), "utf8");
    expect(src).toMatch(/signInWithPassword/);
    expect(src).not.toMatch(/signInWithOtp|supabaseAdmin|createUser|invite_code|from\("club"\)/);
  });

  it("wires the person-row guard, scoped to the returned id, and signs out when it is absent", async () => {
    const src = await readFile(new URL(SIGNIN, import.meta.url), "utf8");
    // the guard reads person filtered to the signed-in user's own id — not any wider read that
    // would pass for a stray because SOMEONE has a row
    expect(src).toMatch(/from\("person"\)[\s\S]*\.eq\("id",\s*userId\)/);
    // and the session written by a refused sign-in is undone
    expect(src).toMatch(/signOut/);
  });
});

/**
 * #85. `find-user.test.ts` proves the paging decision, and proves that a `listUsers({ page,
 * perPage })` really asks GoTrue for that page — but it builds its own pager to do it, so a
 * route whose pager dropped the `page` argument would leave both green (cairn:
 * prove-a-guard-test-can-fail, twelfth outcome — the test builds the call rather than calling
 * what production calls). The route itself cannot be exercised here: the service-role key is
 * name-only in .env.local and Docker is down, so there is no GoTrue to answer it. The source is
 * what is left, and it is the same subject the two tests above already take.
 */
describe("the invite gate's lookup really pages, and writes in exactly one place (#85)", () => {
  const JOIN = "../app/api/join/route.ts";

  it("the pager forwards page and perPage to listUsers", async () => {
    const src = await readFile(new URL(JOIN, import.meta.url), "utf8");
    // A pager that ignored `page` would re-read page 1 until findAuthUser gave up, so every
    // address past the first page would answer "error" and no link would ever be sent.
    expect(src).toMatch(/findAuthUser\(\s*email\s*,\s*async \(page, perPage\) =>/);
    expect(src).toMatch(/listUsers\(\{\s*page\s*,\s*perPage\s*\}\)/);
  });

  it("the attestation stamp has exactly one home, and it is attestExisting", async () => {
    const src = await readFile(new URL(JOIN, import.meta.url), "utf8");
    const start = src.indexOf("attestExisting:");
    expect(start, "the route wires attestExisting").toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf("person: {", start));
    // the stamp writes the metadata AND the chosen password; that pairing is what makes it a
    // stamp rather than a metadata edit, and it is what #85 and #82 together asked for
    expect(block).toMatch(/updateUserById\([\s\S]*user_metadata: meta, password/);
    // #99 gave the route a second updateUserById — ensurePerson's setMetadata, which the callback
    // wires identically and which the gate never reaches (it always arrives with an attestation).
    // So the count is 2, and what matters is that the SECOND one writes no password.
    expect(src.match(/updateUserById/g)).toHaveLength(2);
    const store = src.slice(src.indexOf("person: {"));
    expect(store).toMatch(/setMetadata:[\s\S]*updateUserById\(id, \{ user_metadata: meta \}\)/);
  });

  it("the route decides nothing about whether to stamp — join() does (AC 4)", async () => {
    const src = await readFile(new URL(JOIN, import.meta.url), "utf8");
    // Scoped to the DEPS, not the whole file: the input literal above them reads the form's
    // `attested` checkbox, which is parsing and not deciding, and a scan wide enough to include
    // it refuses a correct route (cairn: a-guard-that-reads-source-must-survive-its-own-docs —
    // match the scan to the subject). The subject here is the wiring.
    const deps = src.slice(src.indexOf("inviteCode: async"), src.lastIndexOf("},\n  );"));
    expect(deps, "the deps block was located").toMatch(/attestExisting/);
    // The moment an attestation TEST appears among the effects, the decision has two homes and
    // the pure function is no longer the one that answers. A test is a predicate or a branch —
    // `attestationOf`, the `attested` boolean, a comparison. Since #99 the block also copies
    // `adult_attested_at` into the person insert, which is data moving, not a decision being
    // taken, and a scan wide enough to catch it refuses a correct route (cairn:
    // a-guard-that-reads-source-must-survive-its-own-docs — match the scan to the subject).
    expect(deps).not.toMatch(/attestationOf|\battested\b/);
    expect(deps).not.toMatch(/adult_attested_at\s*(===|!==|==|\?|&&|\|\|)/);
    expect(deps).not.toMatch(/if\s*\([^)]*attest/i);
  });
});

/**
 * #74. The link route and the sign-in route both end in "redirect the browser to Google", so a
 * wrong wiring produces a working-looking flow that mints a second auth user for the same human
 * — the exact defect the story exists to remove. No unit test reads a route, and the two starters
 * differ by one identifier, so the source is the only subject there is.
 */
describe("the link route links and the sign-in route signs in (#74 AC 1)", () => {
  it("/auth/link/google starts a LINK — startGoogleLink is the only starter it names", async () => {
    const src = await readFile(new URL("../app/auth/link/google/route.ts", import.meta.url), "utf8");
    expect([...new Set(src.match(/startGoogle\w*/g))]).toEqual(["startGoogleLink"]);
    expect(src).not.toMatch(/signInWithOAuth/);
  });

  it("/auth/link/google snapshots the PKCE verifiers BEFORE the start, and restores on refusal", async () => {
    const src = await readFile(new URL("../app/auth/link/google/route.ts", import.meta.url), "utf8");
    expect(src).toMatch(/restoreVerifiers\(before, verifierCookies\(store\.getAll\(\)\)\)/);
    // Ordering is the whole mechanism: a snapshot taken after the start captures the damage
    // rather than what preceded it, and reads exactly as correct.
    const snap = src.indexOf("const before = verifierCookies");
    const start = src.indexOf("const decision = decideLinkStart");
    expect(snap, "the snapshot must exist").toBeGreaterThan(-1);
    expect(snap).toBeLessThan(start);
  });

  it("/auth/google still starts a SIGN-IN — startGoogle, not the linker (negative control)", async () => {
    const src = await readFile(new URL("../app/auth/google/route.ts", import.meta.url), "utf8");
    expect([...new Set(src.match(/startGoogle\w*/g))]).toEqual(["startGoogle"]);
    expect(src).not.toMatch(/linkIdentity/);
  });

  it("the callback chooses its exit by the flow marker, not by a caller's `next`", async () => {
    const src = await readFile(new URL("../app/auth/callback/route.ts", import.meta.url), "utf8");
    // back() must resolve its path through backPathFor — a hard-coded "/join" there is the bug
    // this criterion is about: a signed-in member told to sign in.
    const back = src.slice(src.indexOf("const back ="), src.indexOf("const decision ="));
    expect(back).toMatch(/backPathFor\(flow\)/);
    expect(back).not.toMatch(/pathname = "\/join"/);
  });

  // The SUCCESS leg has the same problem and no unit test either: a link that worked must land on
  // the profile with its marker, not on whatever `next` the redirect carried. Added before the
  // mutation pass, which predicted zero red for this branch without it.
  it("a successful link lands on the profile with its marker, not on the caller's `next`", async () => {
    const src = await readFile(new URL("../app/auth/callback/route.ts", import.meta.url), "utf8");
    const tail = src.slice(src.indexOf("const target ="));
    expect(tail).toMatch(/isLinkFlow\(flow\)\s*\?\s*LINK_DONE\s*:\s*next/);
  });

  /**
   * Everything above proves the flow works once it is STARTED. Nothing proved a member could
   * start it: /profile is a Server Component doing async reads, so no test in this repo renders
   * it, and deleting the control would leave the whole suite green. The page is the only subject
   * there is — same reasoning as the two route tests above.
   */
  it("/profile carries the control, and can explain what comes back to it (#74 AC 1)", async () => {
    const src = await readFile(new URL("../app/profile/page.tsx", import.meta.url), "utf8");
    expect(src).toMatch(/href="\/auth\/link\/google"/);
    // read off the getUser() the page already made, so knowing costs no extra round trip
    expect(src).toMatch(/hasGoogleIdentity\(user\.identities\)/);
    // a link refusal returns HERE, so this page must be able to say what happened; the ?? is
    // what lets link.ts answer first without either module listing the other's keys
    expect(src).toMatch(/explainLinkReason\(error\)\s*\?\?\s*explainProfileRefusal\(error\)/);
  });
});
