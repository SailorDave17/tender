import { describe, expect, it } from "vitest";
import { FROM, resendTransport, resendUrl } from "./send";

/**
 * The real transport's request, against a fake fetch (story #23 AC 2's "wrapping Resend").
 * Proves the shape Resend's POST /emails takes — bearer, JSON, from/to/subject/text — and the
 * two ways it refuses: a non-2xx with the body in the error, and a 2xx with no id.
 */

type Call = { url: string; init: RequestInit };

function fakeFetch(status: number, body: unknown) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
  return { calls, impl };
}

describe("resendTransport", () => {
  it("POSTs the message to Resend with the bearer key, from the club's domain, and returns the id", async () => {
    const { calls, impl } = fakeFetch(200, { id: "abc-123" });
    const t = resendTransport("re_test_key", impl);
    const r = await t.send({ to: "crew@example.org", subject: "Crew needed", text: "Hello" });
    expect(r).toEqual({ id: "abc-123" });
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("https://api.resend.com/emails");
    expect(calls[0].init.method).toBe("POST");
    expect(calls[0].init.headers).toEqual({ Authorization: "Bearer re_test_key", "Content-Type": "application/json" });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({ from: FROM, to: ["crew@example.org"], subject: "Crew needed", text: "Hello" });
    expect(FROM).toBe("Tender <tender@tender.madcowsailing.com>");
  });

  it("throws with the status and the body's head when Resend refuses", async () => {
    const { impl } = fakeFetch(422, { message: "Invalid `to` field" });
    const t = resendTransport("re_test_key", impl);
    await expect(t.send({ to: "nope", subject: "s", text: "t" })).rejects.toThrow(/resend 422: .*Invalid `to` field/);
  });

  it("resendUrl defaults to api.resend.com and honours an override with or without a trailing slash", () => {
    expect(resendUrl(undefined)).toBe("https://api.resend.com/emails");
    expect(resendUrl("http://127.0.0.1:4567/")).toBe("http://127.0.0.1:4567/emails");
    expect(resendUrl("http://127.0.0.1:4567")).toBe("http://127.0.0.1:4567/emails");
  });

  it("throws when a 2xx carries no id, and when there is no key at all", async () => {
    const { impl } = fakeFetch(200, {});
    await expect(resendTransport("re_test_key", impl).send({ to: "a@b.c", subject: "s", text: "t" })).rejects.toThrow(/no id/);
    expect(() => resendTransport(undefined, impl)).toThrow(/RESEND_API_KEY is not set/);
  });
});
