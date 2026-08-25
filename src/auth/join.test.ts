import { describe, expect, it } from "vitest";
import { GENERIC_OK, codesMatch, join, type JoinDeps, type JoinInput } from "./join";

/** The auth user a fake `existingUser` reports when a test makes the address taken. */
const EXISTING_ID = "33333333-3333-4333-8333-333333333333";

/**
 * A fake for every effect, recording each call so the negative cases can assert zero.
 *
 * `taken` makes `createUser` report the address as already having an auth user — the only branch
 * on which #85's lookup runs at all. It is a flag rather than an override so that the call
 * counter survives it; overriding `createUser` to return `{ created: false }` silently stops it
 * counting, which reads as *the gate never tried to create a user*.
 */
function fakes(overrides: Partial<JoinDeps> = {}, { taken = false } = {}) {
  const calls = { inviteCode: 0, createUser: 0, existingUser: 0, attestExisting: 0, sendMagicLink: 0 };
  /** Every attestation write, so AC 2 and AC 3 can assert on the argument and not only the count. */
  const written: { id: string; meta: { display_name: string; adult_attested_at: string } }[] = [];
  const deps: JoinDeps = {
    inviteCode: async () => {
      calls.inviteCode++;
      return "HSC-2027";
    },
    createUser: async () => {
      calls.createUser++;
      return { created: !taken };
    },
    existingUser: async () => {
      calls.existingUser++;
      return { found: true, id: EXISTING_ID, attested: false };
    },
    attestExisting: async (id, meta) => {
      calls.attestExisting++;
      written.push({ id, meta });
      return {};
    },
    sendMagicLink: async () => {
      calls.sendMagicLink++;
      return {};
    },
    now: () => new Date("2026-08-22T12:00:00Z"),
    ...overrides,
  };
  return { deps, calls, written };
}

const good: JoinInput = {
  email: "Alice@Example.org",
  displayName: "Alice",
  code: "HSC-2027",
  attested: true,
};

describe("join — the happy path", () => {
  it("creates the user with the attestation in metadata, sends the link, answers generically", async () => {
    const { deps, calls } = fakes();
    let created: Parameters<JoinDeps["createUser"]>[0] | undefined;
    const counting = deps.createUser;
    deps.createUser = async (u) => {
      created = u;
      return counting(u);
    };
    const r = await join(good, deps);
    expect(r).toEqual({ status: 200, body: { message: GENERIC_OK } });
    // A fresh address is created outright, so nothing is looked up and nothing is stamped.
    expect(calls).toEqual({
      inviteCode: 1,
      createUser: 1,
      existingUser: 0,
      attestExisting: 0,
      sendMagicLink: 1,
    });
    expect(created).toEqual({
      email: "alice@example.org",
      user_metadata: { display_name: "Alice", adult_attested_at: "2026-08-22T12:00:00.000Z" },
    });
  });

  it("answers the same sentence for a returning member, so the address is not revealed", async () => {
    const { deps, calls } = fakes(
      { existingUser: async () => ({ found: true, id: EXISTING_ID, attested: true }) },
      { taken: true },
    );
    const r = await join(good, deps);
    expect(r).toEqual({ status: 200, body: { message: GENERIC_OK } });
    expect(calls.sendMagicLink).toBe(1);
  });
});

describe("join — the refusals reach neither the user store nor the mailer (AC 3)", () => {
  it("400 when the attestation is unticked — and the code is not even read", async () => {
    const { deps, calls } = fakes();
    const r = await join({ ...good, attested: false }, deps);
    expect(r.status).toBe(400);
    expect(r.body.message).toMatch(/18 or over/);
    expect(calls).toEqual({
      inviteCode: 0,
      createUser: 0,
      existingUser: 0,
      attestExisting: 0,
      sendMagicLink: 0,
    });
  });

  it("403 on a wrong invite code", async () => {
    const { deps, calls } = fakes();
    const r = await join({ ...good, code: "HSC-2026" }, deps);
    expect(r.status).toBe(403);
    expect(r.body.message).toMatch(/invite code/);
    expect(calls).toEqual({
      inviteCode: 1,
      createUser: 0,
      existingUser: 0,
      attestExisting: 0,
      sendMagicLink: 0,
    });
  });

  it("403 on a stale code that differs only in length", async () => {
    const { deps, calls } = fakes();
    const r = await join({ ...good, code: "HSC-2027-old" }, deps);
    expect(r.status).toBe(403);
    expect(calls.createUser + calls.sendMagicLink).toBe(0);
  });

  it("400 on a malformed email or an empty name, before the code is read", async () => {
    const { deps, calls } = fakes();
    expect((await join({ ...good, email: "not-an-address" }, deps)).status).toBe(400);
    expect((await join({ ...good, displayName: "   " }, deps)).status).toBe(400);
    expect(calls).toEqual({
      inviteCode: 0,
      createUser: 0,
      existingUser: 0,
      attestExisting: 0,
      sendMagicLink: 0,
    });
  });

  it("500 without sending when the user store fails, and 500 when the mailer fails", async () => {
    const a = fakes({ createUser: async () => ({ error: "boom" }) });
    expect((await join(good, a.deps)).status).toBe(500);
    expect(a.calls.sendMagicLink).toBe(0);
    const b = fakes({ sendMagicLink: async () => ({ error: "smtp down" }) });
    expect((await join(good, b.deps)).status).toBe(500);
  });
});

/**
 * #85. `createUser` answering `email_exists` used to end the story: the metadata this gate had
 * just assembled was dropped, the link went out, and the callback deleted an invited member for
 * having no attestation. Signups are ON, so any browser can leave a stray auth user on somebody
 * else's address — four of the live project's five auth users were exactly that on 2026-08-25,
 * one of them belonging to a person the owner was about to invite.
 */
describe("join — a stray auth user on the address (#85)", () => {
  it("stamps this submission's attestation onto an unattested existing user, then sends (AC 1)", async () => {
    const { deps, calls, written } = fakes({}, { taken: true });
    const r = await join(good, deps);
    expect(r).toEqual({ status: 200, body: { message: GENERIC_OK } });
    expect(calls).toEqual({
      inviteCode: 1,
      createUser: 1,
      existingUser: 1,
      attestExisting: 1,
      sendMagicLink: 1,
    });
    // The same name and clock the createUser attempt carried — what they typed and when the gate
    // ran, not anything reconstructed later.
    expect(written).toEqual([
      {
        id: EXISTING_ID,
        meta: { display_name: "Alice", adult_attested_at: "2026-08-22T12:00:00.000Z" },
      },
    ]);
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

  it("writes nothing when the existing user is already attested — a member is not overwritten (AC 2)", async () => {
    const { deps, calls, written } = fakes(
      { existingUser: async () => ({ found: true, id: EXISTING_ID, attested: true }) },
      { taken: true },
    );
    const r = await join(good, deps);
    expect(r.status).toBe(200);
    expect(written).toEqual([]);
    expect(calls.attestExisting).toBe(0);
    expect(calls.sendMagicLink).toBe(1);
  });

  it("does NOT send when the attestation write fails — a link that ends in deletion is the defect", async () => {
    const { deps, calls } = fakes(
      { attestExisting: async () => ({ error: "gotrue down" }) },
      { taken: true },
    );
    const r = await join(good, deps);
    expect(r.status).toBe(500);
    expect(calls.sendMagicLink).toBe(0);
  });

  it("does NOT send when the lookup errors", async () => {
    const { deps, calls } = fakes({ existingUser: async () => ({ error: "page 2 failed" }) }, { taken: true });
    const r = await join(good, deps);
    expect(r.status).toBe(500);
    expect(calls.attestExisting).toBe(0);
    expect(calls.sendMagicLink).toBe(0);
  });

  it("does NOT send when the lookup finds nobody, which contradicts the refusal that got us here", async () => {
    const { deps, calls } = fakes({ existingUser: async () => ({ found: false }) }, { taken: true });
    const r = await join(good, deps);
    expect(r.status).toBe(500);
    expect(calls.attestExisting).toBe(0);
    expect(calls.sendMagicLink).toBe(0);
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

describe("codesMatch", () => {
  it("is exact after trimming and unicode normalisation", () => {
    expect(codesMatch(" HSC-2027 ", "HSC-2027")).toBe(true);
    expect(codesMatch("hsc-2027", "HSC-2027")).toBe(false);
    expect(codesMatch("", "HSC-2027")).toBe(false);
    // NFKC: a fullwidth digit folds to its ASCII form, so a pasted code still matches.
    expect(codesMatch("HSC-２０２７", "HSC-2027")).toBe(true);
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
