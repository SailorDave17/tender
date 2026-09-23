import { describe, expect, it, vi } from "vitest";
import {
  ATTEMPT_WINDOW_MS,
  EMAIL_ATTEMPT_LIMIT,
  GUESSING_GATES,
  IP_ATTEMPT_LIMIT,
  clientAddress,
  keyHash,
  withAttemptLimit,
  type AttemptStore,
} from "./attempt-limit";

/**
 * #206, the wrapper's own decisions. What the COUNT is lives in 0032 and is proven with the real
 * functions in test/auth-attempt.test.ts; this file holds what the wrapper sends, when it settles,
 * and what it does when the store cannot answer — the cases a working database cannot produce.
 */

const NOW = new Date("2026-09-23T14:00:00.000Z");

function recorder(begin: AttemptStore["begin"] = async () => "r-1") {
  const calls: { begin: Parameters<AttemptStore["begin"]>[0][]; settle: string[] } = { begin: [], settle: [] };
  const store: AttemptStore = {
    begin: async (a) => {
      calls.begin.push(a);
      return begin(a);
    },
    settle: async (id) => {
      calls.settle.push(id);
    },
  };
  return { store, calls };
}

const run = (store: AttemptStore, over: Partial<Parameters<typeof withAttemptLimit<string>>[0]> = {}) =>
  withAttemptLimit<string>({
    gate: "join",
    ip: "198.51.100.7",
    email: "  Jamie@Example.com ",
    store,
    now: () => NOW,
    refusal: "wrong code",
    isFailure: (r) => r === "wrong code",
    attempt: async () => "welcome",
    ...over,
  });

describe("what the wrapper asks the store", () => {
  it("sends digests of the address and the normalised email, the shared gates, the window and both limits", async () => {
    const { store, calls } = recorder();
    await run(store);
    expect(calls.begin).toEqual([
      {
        gate: "join",
        gates: GUESSING_GATES,
        ipHash: keyHash("198.51.100.7"),
        emailHash: keyHash("jamie@example.com"),
        at: NOW,
        since: new Date(NOW.getTime() - ATTEMPT_WINDOW_MS),
        ipLimit: IP_ATTEMPT_LIMIT,
        emailLimit: EMAIL_ATTEMPT_LIMIT,
      },
    ]);
  });

  it("the Google gate has no email key, and forgot has its own gate set and no email key", async () => {
    const google = recorder();
    await run(google.store, { gate: "signup-google", email: undefined });
    expect(google.calls.begin[0]).toMatchObject({ gate: "signup-google", gates: GUESSING_GATES, emailHash: null });

    const forgot = recorder();
    await run(forgot.store, { gate: "forgot" });
    expect(forgot.calls.begin[0]).toMatchObject({ gate: "forgot", gates: ["forgot"], emailHash: null });
  });

  it("the limits are the owner's numbers (2026-09-23), so a change to them is a visible change", () => {
    expect([IP_ATTEMPT_LIMIT, EMAIL_ATTEMPT_LIMIT, ATTEMPT_WINDOW_MS]).toEqual([20, 10, 15 * 60 * 1000]);
  });
});

describe("settling", () => {
  it("a success is settled; a failure is not", async () => {
    const ok = recorder();
    expect(await run(ok.store)).toBe("welcome");
    expect(ok.calls.settle).toEqual(["r-1"]);

    const wrong = recorder();
    expect(await run(wrong.store, { attempt: async () => "wrong code" })).toBe("wrong code");
    expect(wrong.calls.settle).toEqual([]);
  });

  it("forgot never settles, whatever the attempt answered: every request counts", async () => {
    const { store, calls } = recorder();
    await run(store, { gate: "forgot", isFailure: () => false });
    expect(calls.settle).toEqual([]);
  });

  it("a settle that throws leaves the answer alone: the attempt stays counted, which is the safe side", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store: AttemptStore = {
      begin: async () => "r-2",
      settle: async () => {
        throw new Error("database gone");
      },
    };
    expect(await run(store)).toBe("welcome");
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/settle failed/), expect.any(Error));
    error.mockRestore();
  });
});

describe("refusing, and failing open", () => {
  it("a null reservation returns the refusal as given and never runs the attempt", async () => {
    const { store } = recorder(async () => null);
    let ran = false;
    const answer = await run(store, {
      attempt: async () => {
        ran = true;
        return "welcome";
      },
    });
    expect(answer).toBe("wrong code");
    expect(ran).toBe(false);
  });

  it("a begin that throws lets the attempt through and says so on the server log", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const store: AttemptStore = {
      begin: async () => {
        throw new Error("relation public.auth_attempt does not exist");
      },
      settle: async () => undefined,
    };
    expect(await run(store)).toBe("welcome");
    expect(error).toHaveBeenCalledWith(expect.stringMatching(/not limited/), expect.any(Error));
    error.mockRestore();
  });
});

describe("clientAddress", () => {
  it("prefers x-real-ip, then the first x-forwarded-for entry, then one shared key", () => {
    expect(clientAddress(new Headers({ "x-real-ip": "203.0.113.5", "x-forwarded-for": "198.51.100.1" }))).toBe("203.0.113.5");
    expect(clientAddress(new Headers({ "x-forwarded-for": " 198.51.100.1 , 10.0.0.1" }))).toBe("198.51.100.1");
    expect(clientAddress(new Headers())).toBe("unknown");
  });

  it("keyHash is SHA-256 hex, the only shape 0032's table accepts", () => {
    expect(keyHash("198.51.100.1")).toMatch(/^[0-9a-f]{64}$/);
    expect(keyHash("a")).not.toBe(keyHash("A"));
  });
});
