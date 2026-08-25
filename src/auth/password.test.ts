import { describe, expect, it } from "vitest";
import {
  NOT_A_MEMBER,
  WRONG_CREDENTIALS,
  checkNewPassword,
  explainResetError,
  passwordSignIn,
  validatePassword,
  type PasswordSignInDeps,
} from "./password";

const MEMBER = "44444444-4444-4444-8444-444444444444";

/**
 * Fakes for the three effects, recording each call so the AC 7 refusal can assert that a rowless
 * session is signed back out — and that a real member is NOT.
 */
function fakes(overrides: Partial<PasswordSignInDeps> = {}) {
  const calls = { authenticate: 0, hasPerson: 0, signOut: 0 };
  const deps: PasswordSignInDeps = {
    authenticate: async () => {
      calls.authenticate++;
      return { userId: MEMBER };
    },
    hasPerson: async () => {
      calls.hasPerson++;
      return true;
    },
    signOut: async () => {
      calls.signOut++;
    },
    ...overrides,
  };
  return { deps, calls };
}

const good = { email: "Alice@Example.org", password: "sail-away-2027" };

describe("passwordSignIn — email + password, returning member (#82 AC 3)", () => {
  it("authenticates, confirms a person row, and answers where to go — no message", async () => {
    const { deps, calls } = fakes();
    let seen: { email: string; password: string } | undefined;
    deps.authenticate = async (email, password) => {
      seen = { email, password };
      return { userId: MEMBER };
    };
    const r = await passwordSignIn(good, deps);
    expect(r).toEqual({ status: 200, body: { redirect: "/board" } });
    // the address is lowercased before it reaches the platform; the password is passed verbatim
    expect(seen).toEqual({ email: "alice@example.org", password: "sail-away-2027" });
    expect(calls.signOut).toBe(0);
  });

  it("400 on a malformed email or an empty password, before authenticating", async () => {
    const { deps, calls } = fakes();
    expect((await passwordSignIn({ email: "nope", password: "whatever1" }, deps)).status).toBe(400);
    expect((await passwordSignIn({ email: "alice@example.org", password: "" }, deps)).status).toBe(400);
    expect(calls.authenticate).toBe(0);
  });

  it("401 with the same sentence and no session on any auth failure — wrong password or unknown address", async () => {
    const wrong = fakes({ authenticate: async () => ({ error: { code: "invalid_credentials", message: "bad" } }) });
    const r = await passwordSignIn(good, wrong.deps);
    expect(r).toEqual({ status: 401, body: { message: WRONG_CREDENTIALS } });
    // authenticate returning no user is treated the same — never a 200 without a userId
    const noUser = fakes({ authenticate: async () => ({}) });
    expect((await passwordSignIn(good, noUser.deps)).status).toBe(401);
    expect(wrong.calls.hasPerson).toBe(0);
  });
});

describe("passwordSignIn — the callback bypass adds no route in (#82 AC 7)", () => {
  it("refuses a real session with no person row, and signs it back out", async () => {
    const stray = fakes({ hasPerson: async () => false });
    const r = await passwordSignIn(good, stray.deps);
    expect(r).toEqual({ status: 403, body: { message: NOT_A_MEMBER } });
    // the session `authenticate` just wrote is undone — a stray must not keep a usable session
    expect(stray.calls.signOut).toBe(1);
  });

  it("never signs out a member who has a person row", async () => {
    const { deps, calls } = fakes();
    await passwordSignIn(good, deps);
    expect(calls.hasPerson).toBe(1);
    expect(calls.signOut).toBe(0);
  });

  it("checks the person row for the id the platform returned, not the address that was typed", async () => {
    const seen: string[] = [];
    const { deps } = fakes({
      authenticate: async () => ({ userId: MEMBER }),
      hasPerson: async (id) => {
        seen.push(id);
        return true;
      },
    });
    await passwordSignIn(good, deps);
    expect(seen).toEqual([MEMBER]);
  });
});

describe("validatePassword and checkNewPassword (#82 AC 1 / AC 5)", () => {
  it("validatePassword accepts 8+ and refuses shorter, with the length in the message", () => {
    expect(validatePassword("12345678")).toEqual({ ok: true });
    const short = validatePassword("1234567");
    expect(short.ok).toBe(false);
    expect(short.ok === false && short.message).toMatch(/at least 8/);
  });

  it("checkNewPassword reports a mismatch before a weak password", () => {
    expect(checkNewPassword("longenough", "longenough")).toEqual({ ok: true });
    // both wrong: the mismatch is the more useful thing to say
    expect(checkNewPassword("short", "different")).toEqual({ ok: false, reason: "mismatch" });
    expect(checkNewPassword("short", "short")).toEqual({ ok: false, reason: "weak" });
  });
});

describe("explainResetError", () => {
  it("has a distinct sentence per failure and a fallback for anything unknown", () => {
    expect(explainResetError("mismatch")).toMatch(/do not match/);
    expect(explainResetError("weak")).toMatch(/at least 8/);
    expect(explainResetError("failed")).toMatch(/could not be saved/i);
    expect(explainResetError("whatever")).toMatch(/Forgot your password/);
  });
});
