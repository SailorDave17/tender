import { describe, expect, it } from "vitest";
import { GENERIC_OK } from "./join";
import { isNotAUser, signIn, type SignInDeps } from "./signin";

function fakes(overrides: Partial<SignInDeps> = {}) {
  const sent: string[] = [];
  const deps: SignInDeps = {
    sendMagicLink: async (email) => {
      sent.push(email);
      return {};
    },
    ...overrides,
  };
  return { deps, sent };
}

describe("signIn — email only, returning member (#70 AC 2)", () => {
  it("sends the link to the normalised address and answers the generic sentence", async () => {
    const { deps, sent } = fakes();
    const r = await signIn({ email: " Alice@Example.org " }, deps);
    expect(r).toEqual({ status: 200, body: { message: GENERIC_OK } });
    expect(sent).toEqual(["alice@example.org"]);
  });

  it("answers the SAME status and sentence when Supabase says there is no such user", async () => {
    const { deps } = fakes({
      sendMagicLink: async () => ({ error: { code: "otp_disabled", message: "Signups not allowed for otp" } }),
    });
    const r = await signIn({ email: "nobody@example.org" }, deps);
    expect(r).toEqual({ status: 200, body: { message: GENERIC_OK } });
  });

  it("400 on a malformed address, before anything is sent", async () => {
    const { deps, sent } = fakes();
    expect((await signIn({ email: "not-an-address" }, deps)).status).toBe(400);
    expect((await signIn({ email: "" }, deps)).status).toBe(400);
    expect(sent).toEqual([]);
  });

  it("500 on any other mailer failure — a refusal that is not about the address", async () => {
    const { deps } = fakes({ sendMagicLink: async () => ({ error: { message: "smtp down" } }) });
    expect((await signIn({ email: "alice@example.org" }, deps)).status).toBe(500);
  });
});

describe("isNotAUser", () => {
  it("matches the code, or the message when the code is missing, and nothing else", () => {
    expect(isNotAUser({ code: "otp_disabled", message: "anything" })).toBe(true);
    expect(isNotAUser({ message: "Signups not allowed for otp" })).toBe(true);
    expect(isNotAUser({ code: "over_email_send_rate_limit", message: "rate limited" })).toBe(false);
    expect(isNotAUser({ message: "smtp down" })).toBe(false);
  });
});
