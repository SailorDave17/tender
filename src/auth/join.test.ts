import { describe, expect, it } from "vitest";
import { GENERIC_OK, codesMatch, join, type JoinDeps, type JoinInput } from "./join";

/** A fake for every effect, recording each call so the negative cases can assert zero. */
function fakes(overrides: Partial<JoinDeps> = {}) {
  const calls = { inviteCode: 0, createUser: 0, sendMagicLink: 0 };
  const deps: JoinDeps = {
    inviteCode: async () => {
      calls.inviteCode++;
      return "HSC-2027";
    },
    createUser: async () => {
      calls.createUser++;
      return { created: true };
    },
    sendMagicLink: async () => {
      calls.sendMagicLink++;
      return {};
    },
    now: () => new Date("2026-08-22T12:00:00Z"),
    ...overrides,
  };
  return { deps, calls };
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
    expect(calls).toEqual({ inviteCode: 1, createUser: 1, sendMagicLink: 1 });
    expect(created).toEqual({
      email: "alice@example.org",
      user_metadata: { display_name: "Alice", adult_attested_at: "2026-08-22T12:00:00.000Z" },
    });
  });

  it("answers the same sentence for a returning member, so the address is not revealed", async () => {
    const { deps, calls } = fakes({ createUser: async () => ({ created: false }) });
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
    expect(calls).toEqual({ inviteCode: 0, createUser: 0, sendMagicLink: 0 });
  });

  it("403 on a wrong invite code", async () => {
    const { deps, calls } = fakes();
    const r = await join({ ...good, code: "HSC-2026" }, deps);
    expect(r.status).toBe(403);
    expect(r.body.message).toMatch(/invite code/);
    expect(calls).toEqual({ inviteCode: 1, createUser: 0, sendMagicLink: 0 });
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
    expect(calls).toEqual({ inviteCode: 0, createUser: 0, sendMagicLink: 0 });
  });

  it("500 without sending when the user store fails, and 500 when the mailer fails", async () => {
    const a = fakes({ createUser: async () => ({ error: "boom" }) });
    expect((await join(good, a.deps)).status).toBe(500);
    expect(a.calls.sendMagicLink).toBe(0);
    const b = fakes({ sendMagicLink: async () => ({ error: "smtp down" }) });
    expect((await join(good, b.deps)).status).toBe(500);
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
