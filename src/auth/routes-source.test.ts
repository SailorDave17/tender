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

  it("/api/signin/google still signs IN — the exchange, not the linker (negative control, moved by #173)", async () => {
    const src = await readFile(new URL("../app/api/signin/google/route.ts", import.meta.url), "utf8");
    expect(src).toMatch(/exchangeGoogleIdToken/);
    expect(src).not.toMatch(/linkIdentity|startGoogleLink/);
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

/**
 * #173 AC 5. Sign-in and sign-up moved to the ID-token flow so that no Google screen names the
 * Supabase host; the link flow (#74) is redirect-only in GoTrue and deliberately stays. Which
 * call each route makes is the whole difference between "the member sees tender.madcowsailing.com"
 * and "the member sees <ref>.supabase.co", and no unit test reads a route — so the routes are the
 * subject, and the tree as a whole is the subject for what must be gone.
 */
describe("Google sign-in and sign-up are the ID-token flow; only the link still redirects (#173 AC 5)", () => {
  const SIGNIN = "../app/api/signin/google/route.ts";
  const SIGNUP = "../app/api/signup/google/route.ts";
  const LINK = "../app/auth/link/google/route.ts";
  const LIB = "../lib/auth/google.ts";

  it("the sign-in route's only Supabase sign-in call is signInWithIdToken, through the exchange", async () => {
    // The route names the exchange; the exchange names the call. Read both ends so a route that
    // grew a second entry point, or a wrapper that swapped the call, reddens here.
    const route = await readFile(new URL(SIGNIN, import.meta.url), "utf8");
    const lib = await readFile(new URL(LIB, import.meta.url), "utf8");
    expect(route).toMatch(/exchangeGoogleIdToken\(client, token, nonce\)/);
    expect(route).not.toMatch(/signInWithOAuth|signInWithPassword|exchangeCodeForSession|linkIdentity|createUser|redirect\(/);
    const exchange = lib.slice(lib.indexOf("export async function exchangeGoogleIdToken"), lib.indexOf("export async function startGoogleLink"));
    expect(exchange).toMatch(/client\.auth\.signInWithIdToken\(\{ provider: "google", token, nonce \}\)/);
    expect(exchange.match(/client\.auth\.\w+/g)).toEqual(["client.auth.signInWithIdToken"]);
  });

  it("neither route starts an OAuth redirect any more, and the sign-up route posts no cookie of its own", async () => {
    for (const f of [SIGNIN, SIGNUP]) {
      const src = await readFile(new URL(f, import.meta.url), "utf8");
      expect(src, f).not.toMatch(/signInWithOAuth|startGoogle\b|NextResponse\.redirect|\/auth\/callback/);
      expect(src, f).toMatch(/exchangeGoogleIdToken/);
    }
    const signup = await readFile(new URL(SIGNUP, import.meta.url), "utf8");
    // built, not written: the gate-pass scan below walks this file too
    expect(signup).not.toMatch(new RegExp(["cookies\\.set", "sign" + "Pass", "PASS" + "_COOKIE"].join("|")));
  });

  it("GET /auth/google is gone from the tree, not merely unlinked", async () => {
    const files = (await sourceFiles(new URL("../", import.meta.url))).map((u) => u.pathname);
    expect(files.some((p) => p.endsWith("/app/auth/google/route.ts"))).toBe(false);
    // ...and the scan can see a route when there is one
    expect(files.some((p) => p.endsWith("/app/auth/link/google/route.ts"))).toBe(true);
  });

  it("/auth/link/google is untouched: still the linker, still a redirect", async () => {
    const src = await readFile(new URL(LINK, import.meta.url), "utf8");
    expect([...new Set(src.match(/startGoogle\w*/g))]).toEqual(["startGoogleLink"]);
    expect(src).toMatch(/NextResponse\.redirect\(decision\.url\)/);
    expect(src).not.toMatch(/signInWithIdToken|exchangeGoogleIdToken/);
  });
});

/**
 * #173 AC 3's second half: the gate pass was retired WITH its secret and every copy of its name.
 * A cookie nothing sets, a secret nothing reads and a README line still asking for it are three
 * ways the next runbook run wastes an hour, so the tree is scanned rather than trusted.
 */
describe("the gate pass is gone — cookie, secret and every spelling of the name (#173 AC 3)", () => {
  // Built, never written: this file is under src/ and would otherwise report itself.
  const NEEDLES = ["GATE_PASS" + "_SECRET", "tender" + "_gate", "sign" + "Pass(", "verify" + "Pass(", "PASS" + "_COOKIE"];

  it("no file under src/ names the secret, the cookie, or the pass functions", async () => {
    const files = await sourceFiles(new URL("../", import.meta.url));
    expect(files.length, "the scan really walked src/").toBeGreaterThan(40);
    const hits: string[] = [];
    for (const f of files) {
      const text = await readFile(f, "utf8");
      for (const n of NEEDLES) if (text.includes(n)) hits.push(`${f.pathname}: ${n}`);
    }
    expect(hits).toEqual([]);
    // the needles really match the shapes they are built from — the fixtures are built the same
    // way, because the first run of this test found its own control assertion (the #39(d) trap)
    expect(`env("${"GATE_PASS" + "_SECRET"}")`).toContain(NEEDLES[0]);
    expect(`store.set("${"tender" + "_gate"}", "")`).toContain(NEEDLES[1]);
  });

  it("the env registry no longer declares it, and the README no longer asks for it", async () => {
    const registry = await readFile(new URL("../../scripts/server-env.mjs", import.meta.url), "utf8");
    const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
    // Both may MENTION the retirement in prose; neither may still ask for the value. In the
    // registry that is a `name:` entry; in the README it is the bold-code form every runbook
    // variable is introduced with.
    expect(registry).not.toMatch(new RegExp(`name:\\s*"${NEEDLES[0]}"`));
    expect(readme).not.toMatch(new RegExp(`\\*\\*\`${NEEDLES[0]}\``));
    // ...and the scan would see the runbook form if it were there
    expect("   **`GATE_PASS" + "_SECRET`**, any long random string").toMatch(new RegExp(`\\*\\*\`${NEEDLES[0]}\``));
  });
});

/**
 * #206. `attempt-limit.test.ts` and `test/auth-attempt.test.ts` prove the limit; neither reads a
 * route, so a route that dropped the wrapper, named the wrong gate, or refused with a sentence of
 * its own would leave both green. Each route is read for the four things that make the limit this
 * story's: it wraps its decision, it names its own gate, its refusal is the SAME value its wrong
 * answer is (the limit is not an oracle only while those cannot differ), and its email key is
 * present exactly where the owner chose one.
 */
describe("every guessing surface runs inside the attempt limit (#206)", () => {
  const read = (path: string) => readFile(new URL(path, import.meta.url), "utf8");
  const call = (src: string) => src.slice(src.indexOf("withAttemptLimit<"), src.indexOf("});", src.indexOf("withAttemptLimit<")));

  it("/api/join: gate join, WRONG_CODE as the refusal and the failure, keyed by email as well", async () => {
    const c = call(await read("../app/api/join/route.ts"));
    expect(c).toMatch(/gate: "join"/);
    expect(c).toMatch(/refusal: WRONG_CODE,/);
    expect(c).toMatch(/isFailure: \(r\) => r\.status === WRONG_CODE\.status/);
    expect(c).toMatch(/email: String\(body\.email/);
    expect(c).toMatch(/ip: clientAddress\(request\.headers\)/);
  });

  it("/api/signup/google: gate signup-google, WRONG_CODE, and NO email key — there is none before the exchange", async () => {
    const c = call(await read("../app/api/signup/google/route.ts"));
    expect(c).toMatch(/gate: "signup-google"/);
    expect(c).toMatch(/refusal: WRONG_CODE,/);
    expect(c).toMatch(/isFailure: \(r\) => r\.status === WRONG_CODE\.status/);
    expect(c).not.toMatch(/email:/);
  });

  it("/api/signin: gate signin, refused with WRONG_CREDENTIALS' own 401, keyed by email as well", async () => {
    const src = await read("../app/api/signin/route.ts");
    expect(src).toMatch(/const WRONG = \{ status: 401, body: \{ message: WRONG_CREDENTIALS \} \}/);
    const c = call(src);
    expect(c).toMatch(/gate: "signin"/);
    expect(c).toMatch(/refusal: WRONG,/);
    expect(c).toMatch(/isFailure: \(r\) => r\.status === WRONG\.status/);
    expect(c).toMatch(/email: String\(body\.email/);
  });

  it("/api/forgot: gate forgot, every request counts, and the refusal is the same generic sentence", async () => {
    const c = call(await read("../app/api/forgot/route.ts"));
    expect(c).toMatch(/gate: "forgot"/);
    expect(c).toMatch(/refusal: \{ status: 200, body: \{ message: GENERIC_OK \} \}/);
    expect(c).toMatch(/isFailure: \(\) => true/);
  });

  it("/api/signin and /api/forgot reach the service role only through the attempt store, never as a client", async () => {
    // The #82 test above refuses `supabaseAdmin` in /api/signin's text so it can never read the
    // invite code or create a user. #206 needs the service role there for 0032's two calls, and
    // takes it through serviceAttemptStore, which hands back those two calls and not a client.
    for (const path of ["../app/api/signin/route.ts", "../app/api/forgot/route.ts"]) {
      const src = await read(path);
      expect(src, path).toMatch(/store: serviceAttemptStore\(\)/);
      expect(src, path).not.toMatch(/supabaseAdmin/);
    }
    const store = await read("../lib/auth/attempt-store.ts");
    expect(store.match(/\.rpc\("([a-z_]+)"/g)).toEqual(['.rpc("begin_auth_attempt"', '.rpc("settle_auth_attempt"']);
    expect(store).not.toMatch(/\.from\(|\.auth\./);
  });

  it("/api/signin/google is deliberately NOT limited: a Google token cannot be guessed (owner decision, #206)", async () => {
    // A negative control with a reason: limiting it would add a way to lock members out and bound
    // nothing a guesser can use. If that changes, this is the line that should be argued with.
    const src = await read("../app/api/signin/google/route.ts");
    expect(src).not.toMatch(/withAttemptLimit/);
  });
});

/**
 * #234. The proxy gate's own redirect is proven in proxy.test.ts; the pages and server actions each
 * carry a second wall, `if (!user) redirect(…)`, and 27 of them sent a signed-out member to plain
 * `/join`, which opens on Sign up for a new device. No unit test renders them, so the tree is read.
 */
describe("every signed-out redirect in a page or action opens the Sign in tab (#234)", () => {
  it("no bare redirect to /join is left under src/, and the constant is what replaced them", async () => {
    const files = await sourceFiles(new URL("../", import.meta.url));
    expect(files.length, "the scan really walked src/").toBeGreaterThan(40);
    // BUILT, not written: this file is under src/ and a literal would be the scan's first hit.
    const BARE = "redirect(" + '"/join")';
    const bare: string[] = [];
    let viaConstant = 0;
    for (const f of files) {
      const src = await readFile(f, "utf8");
      if (src.includes(BARE)) bare.push(f.pathname);
      // Built for the same reason as BARE: the literal would count this file (measured, 28 not 27).
      viaConstant += src.split("redirect(" + "SIGN_IN_URL)").length - 1;
    }
    expect(bare).toEqual([]);
    // A positive control on the replacement: all 27 went to the constant, not somewhere else.
    expect(viaConstant).toBe(27);
    // ...and the needle matches the shape it hunts for.
    // (The sample is built too: written out, it was this scan's one hit on its first run.)
    expect("if (!user) " + BARE + ";").toContain(BARE);
  });

  it("sign-out keeps plain /join on purpose: that device has signed in, so it opens on Sign in", async () => {
    const src = await readFile(new URL("../app/auth/signout/route.ts", import.meta.url), "utf8");
    expect(src).toMatch(/url\.pathname = "\/join";/);
    expect(src).toMatch(/Deliberately plain `\/join`, not `SIGN_IN_URL` \(#234\)/);
  });
});
