import { describe, expect, it } from "vitest";
import {
  AFTER_SIGNUP,
  ALREADY_A_MEMBER,
  CREATED_NOT_SIGNED_IN,
  codesMatch,
  join,
  type JoinDeps,
  type JoinInput,
} from "./join";
import type { PersonStore } from "./person";

/** The auth user a fake `existingUser` reports when a test makes the address taken. */
const EXISTING_ID = "33333333-3333-4333-8333-333333333333";
/** The id a fresh `createUser` reports. */
const NEW_ID = "44444444-4444-4444-8444-444444444444";

/**
 * A fake for every effect, recording each call so the negative cases can assert zero.
 *
 * `taken` makes `createUser` report the address as already having an auth user — the only branch
 * on which #85's lookup runs at all. It is a flag rather than an override so that the call
 * counter survives it; overriding `createUser` to return `{ created: false }` silently stops it
 * counting, which reads as *the gate never tried to create a user*.
 *
 * **The deps are behind a Proxy, and that is what makes AC 1 provable.** #99's claim is that no
 * email is sent anywhere on this path, and the gate's honest form of that is having nothing that
 * could send one — but "the dep is absent" is not an assertion, it is the absence of one, and a
 * mutation that put `await deps.sendMagicLink?.(email)` back would read `undefined`, optional-chain
 * past it and leave every test green. So any property the gate reaches for that is NOT one of the
 * effects below comes back as a function that records itself by name, and `reachedFor` must be
 * empty. A reintroduced sender is then a red test naming the sender.
 */
type Overrides = Partial<Omit<JoinDeps, "person">> & { person?: Partial<PersonStore> };

function fakes(overrides: Overrides = {}, { taken = false, attested = false } = {}) {
  const calls = {
    inviteCode: 0,
    createUser: 0,
    existingUser: 0,
    attestExisting: 0,
    ensurePerson: 0,
    signIn: 0,
  };
  /** Every attestation write, so AC 2 and AC 3 can assert on the argument and not only the count. */
  const written: { id: string; meta: { display_name: string; adult_attested_at: string }; password: string }[] = [];
  /** Every person row minted, and every sign-in attempted, with their arguments. */
  const inserted: Parameters<PersonStore["insert"]>[0][] = [];
  const signedIn: { email: string; password: string }[] = [];
  const deleted: string[] = [];
  /** Anything the gate asked its deps for that is not an effect it is allowed to have. */
  const reachedFor: string[] = [];

  const person: PersonStore = {
    exists: async () => false,
    insert: async (row) => {
      calls.ensurePerson++;
      inserted.push(row);
      return {};
    },
    setMetadata: async () => ({}),
    deleteUser: async (id) => {
      deleted.push(id);
      return {};
    },
    ...(overrides.person ?? {}),
  };

  const { person: _storeOverride, ...rest } = overrides;
  const base: JoinDeps = {
    inviteCode: async () => "HSC-2027",
    createUser: async () => (taken ? { created: false } : { created: true, id: NEW_ID }),
    existingUser: async () => ({ found: true, id: EXISTING_ID, attested }),
    attestExisting: async (id, meta, password) => {
      written.push({ id, meta, password });
      return {};
    },
    person,
    signIn: async (email, password) => {
      signedIn.push({ email, password });
      return {};
    },
    now: () => new Date("2026-08-22T12:00:00Z"),
    // the store is merged field-by-field above, so a partial override keeps the recorders; it is
    // destructured out here so the spread cannot replace it wholesale
    ...rest,
  };

  const deps = new Proxy(base, {
    get(target, key) {
      if (typeof key !== "string") return Reflect.get(target, key);
      if (!(key in target)) {
        // Not an effect this gate is allowed to have. Hand back something callable that says so.
        return (...args: unknown[]) => {
          reachedFor.push(`${key}(${args.map(String).join(", ")})`);
          return Promise.resolve({});
        };
      }
      // Counting happens HERE, not inside each fake, so an override cannot silently stop it —
      // which is what makes `calls.createUser === 0` mean "never called" and not "was replaced"
      // (cairn: a-fake-cannot-disagree-with-its-author, the recording-fake half).
      if (key in calls) {
        const fn = target[key as keyof JoinDeps] as (...a: unknown[]) => unknown;
        return (...args: unknown[]) => {
          calls[key as keyof typeof calls]++;
          return fn(...args);
        };
      }
      return target[key as keyof JoinDeps];
    },
  });

  return { deps, calls, written, inserted, signedIn, deleted, reachedFor };
}

const good: JoinInput = {
  email: "Alice@Example.org",
  displayName: "Alice",
  code: "HSC-2027",
  attested: true,
  password: "sail-away-2027",
};

describe("join — the happy path finishes in a session, with no email at all (#99 AC 1)", () => {
  it("creates the user, mints the person row, signs in and answers the redirect", async () => {
    let created: Parameters<JoinDeps["createUser"]>[0] | undefined;
    // A plain override, because the counting lives in the Proxy now: replacing an effect no
    // longer stops it being counted, which is the whole point of moving it there.
    const { deps, calls, inserted, signedIn, reachedFor } = fakes({
      createUser: async (u) => {
        created = u;
        return { created: true, id: NEW_ID };
      },
    });
    const r = await join(good, deps);
    expect(r).toEqual({ status: 200, body: { redirect: AFTER_SIGNUP } });
    expect(AFTER_SIGNUP).toBe("/board");
    // A fresh address is created outright, so nothing is looked up and nothing is stamped.
    expect(calls).toEqual({
      inviteCode: 1,
      createUser: 1,
      existingUser: 0,
      attestExisting: 0,
      ensurePerson: 1,
      signIn: 1,
    });
    expect(created).toEqual({
      email: "alice@example.org",
      password: "sail-away-2027",
      user_metadata: { display_name: "Alice", adult_attested_at: "2026-08-22T12:00:00.000Z" },
    });
    // The row is minted for the user that was just created, off the metadata that was just written.
    expect(inserted).toEqual([
      {
        id: NEW_ID,
        display_name: "Alice",
        adult_attested_at: "2026-08-22T12:00:00.000Z",
        email: "alice@example.org",
      },
    ]);
    // ...and the sign-in uses the password from this submission, not a re-typed one.
    expect(signedIn).toEqual([{ email: "alice@example.org", password: "sail-away-2027" }]);
    // The whole point of the story: nothing on this path can send mail, and this is the assertion
    // that could fail if something did. See `fakes` — the recorder catches any dep by any name.
    expect(reachedFor).toEqual([]);
  });

  it("the recorder really would catch a send — the control for the assertion above", async () => {
    // Without this, `reachedFor` being empty is consistent with a fake that cannot record at all.
    const { deps, reachedFor } = fakes();
    await (deps as unknown as { sendMagicLink: (e: string) => Promise<unknown> }).sendMagicLink(
      "alice@example.org",
    );
    expect(reachedFor).toEqual(["sendMagicLink(alice@example.org)"]);
  });
});

describe("join — the refusals reach neither the user store nor the person store (AC 3)", () => {
  const untouched = {
    inviteCode: 0,
    createUser: 0,
    existingUser: 0,
    attestExisting: 0,
    ensurePerson: 0,
    signIn: 0,
  };

  it("400 when the attestation is unticked — and the code is not even read", async () => {
    const { deps, calls } = fakes();
    const r = await join({ ...good, attested: false }, deps);
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/18 or over/);
    expect(calls).toEqual(untouched);
  });

  it("403 on a wrong invite code", async () => {
    const { deps, calls } = fakes();
    const r = await join({ ...good, code: "HSC-2026" }, deps);
    expect(r.status).toBe(403);
    expect(r.body.message).toMatch(/invite code/);
    expect(calls).toEqual({ ...untouched, inviteCode: 1 });
  });

  it("403 on a stale code that differs only in length", async () => {
    const { deps, calls } = fakes();
    const r = await join({ ...good, code: "HSC-2027-old" }, deps);
    expect(r.status).toBe(403);
    expect(calls.createUser + calls.ensurePerson + calls.signIn).toBe(0);
  });

  it("400 on a malformed email or an empty name, before the code is read", async () => {
    const { deps, calls } = fakes();
    expect((await join({ ...good, email: "not-an-address" }, deps)).status).toBe(400);
    expect((await join({ ...good, displayName: "   " }, deps)).status).toBe(400);
    expect(calls).toEqual(untouched);
  });

  it("400 on a too-short password, before the code is read and before any user is touched (#82)", async () => {
    const { deps, calls } = fakes();
    const r = await join({ ...good, password: "short" }, deps);
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/at least 8/);
    expect(calls).toEqual(untouched);
  });

  it("500 without minting or signing in when the user store fails", async () => {
    const a = fakes({ createUser: async () => ({ error: "boom" }) });
    expect((await join(good, a.deps)).status).toBe(500);
    expect(a.calls.ensurePerson + a.calls.signIn).toBe(0);
  });

  it("500 when the created user comes back with no id — nothing to mint a row for", async () => {
    const a = fakes({ createUser: async () => ({ error: "created user has no id" }) });
    expect((await join(good, a.deps)).status).toBe(500);
    expect(a.calls.ensurePerson).toBe(0);
  });
});

/**
 * #99 AC 3. The two failures after the account exists are not the same failure, and the
 * difference is what a member is told: one has no account and may start again, the other has one
 * and must not be sent back to a form that will now refuse them.
 */
describe("join — when it fails after the account exists", () => {
  it("signs nobody in and answers 500 when the person insert fails", async () => {
    const { deps, calls } = fakes({
      person: { insert: async () => ({ error: "42501" }) },
    });
    const r = await join(good, deps);
    expect(r.status).toBe(500);
    expect(calls.signIn, "a session over a membership that does not exist").toBe(0);
    expect(r.body.redirect).toBeUndefined();
  });

  it("names the account as created and routes to sign-in when the sign-in itself fails", async () => {
    const { deps, calls, inserted } = fakes({ signIn: async () => ({ error: "gotrue down" }) });
    const r = await join(good, deps);
    expect(r.status).toBe(500);
    expect(r.body.message).toBe(CREATED_NOT_SIGNED_IN);
    expect(r.body.then).toBe("signin");
    // the distinction is only worth anything if the row really was written first
    expect(inserted).toHaveLength(1);
    expect(calls.signIn).toBe(1);
    // and it must not read as "start again": the account exists and a retry would be refused
    expect(r.body.message).not.toMatch(/try again|start again/i);
  });
});

/**
 * #85, and the answer #99 changes. `createUser` answering `email_exists` used to end the story:
 * the metadata this gate had just assembled was dropped, the link went out, and the callback
 * deleted an invited member for having no attestation. Signups are ON, so any browser can leave a
 * stray auth user on somebody else's address — four of the live project's five auth users were
 * exactly that on 2026-08-25, one of them belonging to a person about to be invited.
 */
describe("join — a stray auth user on the address (#85, AC 5)", () => {
  it("stamps this submission's attestation onto an unattested existing user, then mints and signs in", async () => {
    const { deps, calls, written, inserted, signedIn, reachedFor } = fakes({}, { taken: true });
    const r = await join(good, deps);
    expect(r).toEqual({ status: 200, body: { redirect: AFTER_SIGNUP } });
    expect(calls).toEqual({
      inviteCode: 1,
      createUser: 1,
      existingUser: 1,
      attestExisting: 1,
      ensurePerson: 1,
      signIn: 1,
    });
    // The same name, clock and password the createUser attempt carried — what they typed and when
    // the gate ran, not anything reconstructed later. The password is set on the stray too (#82),
    // so the member who was squatted on can sign in with it a line later.
    expect(written).toEqual([
      {
        id: EXISTING_ID,
        meta: { display_name: "Alice", adult_attested_at: "2026-08-22T12:00:00.000Z" },
        password: "sail-away-2027",
      },
    ]);
    // the row is minted for the EXISTING user, not for a new id that was never created
    expect(inserted.map((r) => r.id)).toEqual([EXISTING_ID]);
    expect(signedIn).toEqual([{ email: "alice@example.org", password: "sail-away-2027" }]);
    expect(reachedFor).toEqual([]);
  });

  it("looks up the lowercased address, not the one that was typed", async () => {
    const seen: string[] = [];
    const { deps } = fakes(
      {
        existingUser: async (email) => {
          seen.push(email);
          return { found: true, id: EXISTING_ID, attested: false };
        },
      },
      { taken: true },
    );
    await join(good, deps);
    expect(seen).toEqual(["alice@example.org"]);
  });

  it("mints nothing on this path that could delete the stray — the metadata carries the attestation", async () => {
    // AC 2: ensurePerson's delete-a-strayer branch is unreachable from the gate by construction.
    // It fires for a user with no attestation and no pass; the gate wrote one a line earlier.
    const { deps, deleted } = fakes({}, { taken: true });
    await join(good, deps);
    expect(deleted).toEqual([]);
  });

  it("does NOT mint or sign in when the attestation write fails", async () => {
    const { deps, calls } = fakes({ attestExisting: async () => ({ error: "gotrue down" }) }, { taken: true });
    const r = await join(good, deps);
    expect(r.status).toBe(500);
    expect(calls.ensurePerson + calls.signIn).toBe(0);
  });

  it("does NOT mint or sign in when the lookup errors", async () => {
    const { deps, calls } = fakes({ existingUser: async () => ({ error: "page 2 failed" }) }, { taken: true });
    const r = await join(good, deps);
    expect(r.status).toBe(500);
    expect(calls.attestExisting + calls.ensurePerson + calls.signIn).toBe(0);
  });

  it("does NOT act when the lookup finds nobody, which contradicts the refusal that got us here", async () => {
    const { deps, calls } = fakes({ existingUser: async () => ({ found: false }) }, { taken: true });
    const r = await join(good, deps);
    expect(r.status).toBe(500);
    expect(calls.attestExisting + calls.ensurePerson + calls.signIn).toBe(0);
  });

  it("a wrong code or an unticked box reaches neither the lookup nor the write (AC 3)", async () => {
    // The fixture is otherwise maximally permissive — the address IS taken and the existing user
    // IS unattested, so this is the exact input that would be stamped a line later. Only the gate
    // stands between a stranger guessing addresses and an attestation on somebody's account.
    const wrong = fakes({}, { taken: true });
    expect((await join({ ...good, code: "HSC-2026" }, wrong.deps)).status).toBe(403);
    expect(wrong.calls.existingUser + wrong.calls.attestExisting).toBe(0);

    const unticked = fakes({}, { taken: true });
    expect((await join({ ...good, attested: false }, unticked.deps)).status).toBe(400);
    expect(unticked.calls.existingUser + unticked.calls.attestExisting).toBe(0);

    const badEmail = fakes({}, { taken: true });
    expect((await join({ ...good, email: "not-an-address" }, badEmail.deps)).status).toBe(400);
    expect(badEmail.calls.existingUser + badEmail.calls.attestExisting).toBe(0);
  });
});

/**
 * #99 AC 4. Until now every outcome answered the same generic sentence, which was honest while a
 * link really was on its way to somebody. With no link on any path it would be a lie told to a
 * member who is now stuck, so this one says what happened. It reveals that the address is
 * registered — deliberately, and only to a caller who has already proved this season's code.
 */
describe("join — an address that already carries an attested member (AC 4)", () => {
  function attestedFakes(overrides: Partial<JoinDeps> = {}) {
    return fakes(overrides, { taken: true, attested: true });
  }

  it("overwrites nothing and names the way in", async () => {
    const { deps, calls, written, inserted, signedIn } = attestedFakes();
    const r = await join(good, deps);
    expect(r).toEqual({ status: 409, body: { message: ALREADY_A_MEMBER, then: "signin" } });
    expect(ALREADY_A_MEMBER).toMatch(/sign in with your password/);
    // not the password, not the metadata, not the person row, and no session
    expect(written).toEqual([]);
    expect(inserted).toEqual([]);
    expect(signedIn).toEqual([]);
    expect(calls).toEqual({
      inviteCode: 1,
      createUser: 1,
      existingUser: 1,
      attestExisting: 0,
      ensurePerson: 0,
      signIn: 0,
    });
  });

  it("is not the generic sentence the reset arm still uses — this one says what happened", async () => {
    const { deps } = attestedFakes();
    const r = await join(good, deps);
    const { GENERIC_OK } = await import("./signin");
    expect(r.body.message).not.toBe(GENERIC_OK);
    expect(r.body.message).not.toMatch(/on its way|inbox|link/i);
  });
});

describe("codesMatch", () => {
  it("is exact after trimming and unicode normalisation", () => {
    expect(codesMatch(" HSC-2027 ", "HSC-2027")).toBe(true);
    expect(codesMatch("hsc-2027", "HSC-2027")).toBe(false);
    expect(codesMatch("", "HSC-2027")).toBe(false);
    // NFKC: a fullwidth digit folds to its ASCII form, so a pasted code still matches.
    expect(codesMatch("HSC-２０２７", "HSC-2027")).toBe(true);
  });
});

/**
 * #99 AC 2. `ensurePerson` stays the only writer of `person`, and the gate is its second caller.
 * A gate that inserted the same row itself would pass every behavioural test above — the fake
 * store records an insert either way — so the two forms are indistinguishable from outside and
 * the source is the only subject there is (cairn:
 * a-guard-that-reads-source-must-survive-its-own-docs, the 2026-08-16 extension).
 *
 * What that buys is not tidiness: one writer means one predicate. `attestationOf` decides what an
 * attestation is, the delete-a-strayer branch decides what happens without one, and a second
 * inserter would answer both questions again, in a second place, where nothing compares them.
 */
describe("the gate mints through ensurePerson rather than inserting (AC 2)", () => {
  it("join.ts calls ensurePerson and never touches the store itself", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("./join.ts", import.meta.url), "utf8");
    expect(src).toMatch(/import \{ ensurePerson, type PersonStore \} from "\.\/person"/);
    expect(src).toMatch(/await ensurePerson\(\{ id, email, user_metadata: meta \}, deps\.person\)/);
    // the store is handed on, never used — an insert, a delete or a metadata write here is a
    // second writer whatever it looks like
    expect(src).not.toMatch(/deps\.person\.(insert|deleteUser|setMetadata|exists)/);
  });

  it("...and it passes the attestation it just wrote, which is why the delete branch is unreachable", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("./join.ts", import.meta.url), "utf8");
    // `meta` is built from this submission and always carries adult_attested_at, so
    // ensurePerson's `if (!attested)` — the arm that deletes — cannot be entered from here.
    const meta = src.slice(src.indexOf("const meta = {"), src.indexOf("const created ="));
    expect(meta).toMatch(/adult_attested_at:/);
    expect(src).toMatch(/user_metadata: meta\s*\}, deps\.person\)/);
  });
});

describe("the comparison is constant-time — a property only the source can show", () => {
  // timingSafeEqual and Buffer#equals return the same booleans on every input, so no behavioural
  // test can tell them apart (cairn: a-guard-that-reads-source-must-survive-its-own-docs, the
  // 2026-08-16 extension). The source is the only subject there is.
  it("codesMatch calls timingSafeEqual from node:crypto", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(new URL("./join.ts", import.meta.url), "utf8");
    expect(src).toMatch(/import \{ timingSafeEqual \} from "node:crypto"/);
    const body = src.slice(src.indexOf("export function codesMatch"), src.indexOf("const EMAIL"));
    expect(body).toMatch(/return timingSafeEqual\(a, b\)/);
    expect(body).not.toMatch(/\.equals\(|===\s*b\b/);
  });
});

// ---------------------------------------------------------------------------------------------

import { googleSignup, type GoogleSignupDeps } from "./join";

function googleFakes(overrides: Partial<GoogleSignupDeps> = {}) {
  const calls = { inviteCode: 0, setPass: 0, startOAuth: 0 };
  const passes: Parameters<GoogleSignupDeps["setPass"]>[0][] = [];
  const deps: GoogleSignupDeps = {
    inviteCode: async () => {
      calls.inviteCode++;
      return "HSC-2027";
    },
    setPass: async (p) => {
      calls.setPass++;
      passes.push(p);
    },
    startOAuth: async () => {
      calls.startOAuth++;
      return { url: "https://accounts.google.invalid/o/oauth2/auth?state=x" };
    },
    now: () => new Date("2026-08-23T10:00:00Z"),
    ...overrides,
  };
  return { deps, calls, passes };
}

const googleGood = { displayName: " Bob ", code: "HSC-2027", attested: true };

describe("googleSignup — the gate, then a pass and a redirect (#70 AC 4)", () => {
  it("checks the code, sets the pass from the clock, starts OAuth, answers the URL", async () => {
    const { deps, calls, passes } = googleFakes();
    const r = await googleSignup(googleGood, deps);
    expect(r).toEqual({ status: 200, body: { url: "https://accounts.google.invalid/o/oauth2/auth?state=x" } });
    expect(calls).toEqual({ inviteCode: 1, setPass: 1, startOAuth: 1 });
    expect(passes).toEqual([
      { display_name: "Bob", adult_attested_at: "2026-08-23T10:00:00.000Z", issued_at: "2026-08-23T10:00:00.000Z" },
    ]);
  });

  it("wrong code: 403, no pass set, no redirect started", async () => {
    const { deps, calls } = googleFakes();
    const r = await googleSignup({ ...googleGood, code: "HSC-2026" }, deps);
    expect(r.status).toBe(403);
    expect(calls).toEqual({ inviteCode: 1, setPass: 0, startOAuth: 0 });
  });

  it("attestation unticked: 400, and the code is not even read", async () => {
    const { deps, calls } = googleFakes();
    const r = await googleSignup({ ...googleGood, attested: false }, deps);
    expect(r.status).toBe(400);
    expect(calls).toEqual({ inviteCode: 0, setPass: 0, startOAuth: 0 });
  });

  it("empty name: 400 before the code is read", async () => {
    const { deps, calls } = googleFakes();
    expect((await googleSignup({ ...googleGood, displayName: "  " }, deps)).status).toBe(400);
    expect(calls).toEqual({ inviteCode: 0, setPass: 0, startOAuth: 0 });
  });

  it("500 when OAuth cannot start", async () => {
    const { deps } = googleFakes({ startOAuth: async () => ({ error: "provider not enabled" }) });
    expect((await googleSignup(googleGood, deps)).status).toBe(500);
  });
});
