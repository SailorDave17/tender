import { describe, expect, it } from "vitest";
import { INVITE_MAX, type InviteResult } from "./invite";
import { decodeInviteReport, encodeInviteReport } from "./invite-report";

/**
 * Story #31 — the report's round trip through the URL.
 *
 * The decode half is the one that matters: the page renders what comes back, and a query parameter
 * is attacker-supplied by construction. Every rejection case below is paired with the nearest
 * ACCEPTED shape, so a decoder that simply returned null for everything would fail here — which is
 * the failure mode a validator's tests miss (cairn: a guard whose corpus proves nothing).
 */

const full: InviteResult = {
  outcomes: [
    { email: "sent@example.org", state: "sent", providerId: "re_1" },
    { email: "bad@example.org", state: "refused", error: "invalid recipient" },
    { email: "member@example.org", state: "member" },
  ],
  malformed: ["dave@"],
  duplicates: ["Sent@example.org"],
};

describe("the round trip", () => {
  it("survives every field", () => {
    const decoded = decodeInviteReport(encodeInviteReport(full));
    expect(decoded).toEqual({
      sent: ["sent@example.org"],
      refused: [{ email: "bad@example.org", error: "invalid recipient" }],
      members: ["member@example.org"],
      malformed: ["dave@"],
      duplicates: ["Sent@example.org"],
    });
  });

  it("carries each of the three refusals", () => {
    for (const refusal of [
      { reason: "cap", fits: 7 },
      { reason: "too_many", max: INVITE_MAX },
      { reason: "empty" },
    ] as const) {
      const decoded = decodeInviteReport(encodeInviteReport({ ...full, refusal }));
      expect(decoded?.refusal).toEqual(refusal);
    }
  });

  it("omits the refusal when there is none, rather than carrying undefined", () => {
    expect(decodeInviteReport(encodeInviteReport(full))).not.toHaveProperty("refusal");
  });

  it("survives a plus-aliased address, which is why this is base64 and not a query list", () => {
    const result: InviteResult = { ...full, outcomes: [{ email: "dave+crew1@gmail.com", state: "sent", providerId: "re_1" }] };
    expect(decodeInviteReport(encodeInviteReport(result))?.sent).toEqual(["dave+crew1@gmail.com"]);
  });

  it("truncates a provider message rather than putting an unbounded string in a URL", () => {
    const long = "x".repeat(500);
    const result: InviteResult = { ...full, outcomes: [{ email: "a@example.org", state: "refused", error: long }] };
    expect(decodeInviteReport(encodeInviteReport(result))?.refused[0].error).toHaveLength(120);
  });

  it("a fifty-address report stays well inside the length bound", () => {
    const outcomes = Array.from({ length: INVITE_MAX }, (_, i) => ({
      email: `person${i}@averagelengthdomain.example.org`,
      state: "sent" as const,
      providerId: `re_${i}`,
    }));
    const encoded = encodeInviteReport({ outcomes, malformed: [], duplicates: [] });
    expect(encoded.length).toBeLessThan(8000);
    expect(decodeInviteReport(encoded)?.sent).toHaveLength(INVITE_MAX);
  });
});

describe("what the decoder refuses", () => {
  it("nothing at all", () => {
    expect(decodeInviteReport(undefined)).toBeNull();
    expect(decodeInviteReport("")).toBeNull();
  });

  it("an over-long parameter, refused on its LENGTH and not on its content", () => {
    // The mutation that removed the length bound reddened NOTHING against a predicted 1, because
    // the case here was `"A".repeat(8001)` — over-long AND not valid base64 JSON, so it was
    // refused by the parse and the bound was never the reason. An instrument that cannot fail for
    // the reason it names is not an instrument (cairn: prove-a-guard-test-can-fail).
    //
    // So the subject is a report that would decode perfectly at any shorter length: a real one,
    // padded past MAX_ENCODED with a long address. Its own validity is asserted first, on the
    // unpadded form, which is what makes the refusal below attributable to the length alone.
    const small = encodeInviteReport({ outcomes: [{ email: "a@example.org", state: "sent", providerId: "re_1" }], malformed: [], duplicates: [] });
    expect(decodeInviteReport(small)).not.toBeNull();

    const padded = encodeInviteReport({
      outcomes: [{ email: `${"a".repeat(7000)}@example.org`, state: "sent", providerId: "re_1" }],
      malformed: [],
      duplicates: [],
    });
    expect(padded.length).toBeGreaterThan(8000);
    // Valid base64url, valid JSON, valid shape — and still refused, on length.
    expect(JSON.parse(Buffer.from(padded, "base64url").toString("utf8"))).toHaveProperty("sent");
    expect(decodeInviteReport(padded)).toBeNull();
  });

  it("text that is not base64 JSON, and JSON that is not an object", () => {
    expect(decodeInviteReport("not base64 at all !!!")).toBeNull();
    for (const value of ["null", "[]", '"a string"', "42"]) {
      expect(decodeInviteReport(Buffer.from(value).toString("base64url")), value).toBeNull();
    }
  });

  const encode = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const good = { sent: [], refused: [], members: [], malformed: [], duplicates: [] };

  it("accepts the minimal valid shape — the control for every rejection below", () => {
    expect(decodeInviteReport(encode(good))).toEqual(good);
  });

  it("a missing or wrongly-typed list", () => {
    expect(decodeInviteReport(encode({ ...good, sent: undefined }))).toBeNull();
    expect(decodeInviteReport(encode({ ...good, sent: "a@example.org" }))).toBeNull();
    expect(decodeInviteReport(encode({ ...good, members: [1, 2] }))).toBeNull();
    expect(decodeInviteReport(encode({ ...good, malformed: [{}] }))).toBeNull();
  });

  it("a list longer than any real report could be", () => {
    const many = Array.from({ length: INVITE_MAX * 2 + 1 }, (_, i) => `p${i}@example.org`);
    expect(decodeInviteReport(encode({ ...good, sent: many }))).toBeNull();
    // and the length just inside the bound is accepted
    expect(decodeInviteReport(encode({ ...good, sent: many.slice(0, INVITE_MAX * 2) }))).not.toBeNull();
  });

  it("a refused entry that is not an {email, error} pair", () => {
    expect(decodeInviteReport(encode({ ...good, refused: ["a@example.org"] }))).toBeNull();
    expect(decodeInviteReport(encode({ ...good, refused: [{ email: "a@example.org" }] }))).toBeNull();
    expect(decodeInviteReport(encode({ ...good, refused: [{ email: 1, error: "x" }] }))).toBeNull();
    expect(decodeInviteReport(encode({ ...good, refused: null }))).toBeNull();
    expect(decodeInviteReport(encode({ ...good, refused: [{ email: "a@example.org", error: "x" }] }))).not.toBeNull();
  });

  it("a refusal with an unknown reason or a nonsense number", () => {
    expect(decodeInviteReport(encode({ ...good, refusal: { reason: "because" } }))).toBeNull();
    expect(decodeInviteReport(encode({ ...good, refusal: { reason: "cap" } }))).toBeNull();
    expect(decodeInviteReport(encode({ ...good, refusal: { reason: "cap", fits: -1 } }))).toBeNull();
    expect(decodeInviteReport(encode({ ...good, refusal: { reason: "cap", fits: 1.5 } }))).toBeNull();
    expect(decodeInviteReport(encode({ ...good, refusal: { reason: "too_many", max: 0 } }))).toBeNull();
    // and the valid spellings, so the rejections above are not a decoder that refuses everything
    expect(decodeInviteReport(encode({ ...good, refusal: { reason: "cap", fits: 0 } }))).not.toBeNull();
    expect(decodeInviteReport(encode({ ...good, refusal: { reason: "empty" } }))).not.toBeNull();
  });
});
