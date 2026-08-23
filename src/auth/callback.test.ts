import { describe, expect, it } from "vitest";
import { decideCallback, explainReason } from "./callback";

describe("decideCallback — what the callback does with its query (#70 AC 7)", () => {
  it("exchanges when a code is present, whatever else rides along", () => {
    expect(decideCallback({ code: "abc" })).toEqual({ kind: "exchange", code: "abc" });
    expect(decideCallback({ code: "abc", error: "ignored" })).toEqual({ kind: "exchange", code: "abc" });
  });

  it("reads a cancellation at Google as a cancellation, not a fault", () => {
    expect(decideCallback({ error: "access_denied" })).toEqual({ kind: "back", reason: "cancelled" });
    expect(decideCallback({ error: "server_error", error_code: "access_denied" })).toEqual({
      kind: "back",
      reason: "cancelled",
    });
    expect(
      decideCallback({ error: "server_error", error_description: "User cancelled the consent flow" }),
    ).toEqual({ kind: "back", reason: "cancelled" });
  });

  it("names any other provider failure as a provider error", () => {
    expect(decideCallback({ error: "server_error", error_description: "Unable to exchange external code" })).toEqual(
      { kind: "back", reason: "provider-error" },
    );
    expect(decideCallback({ error_code: "unexpected_failure" })).toEqual({ kind: "back", reason: "provider-error" });
  });

  it("still answers missing-code for an empty query — a truncated magic link", () => {
    expect(decideCallback({})).toEqual({ kind: "back", reason: "missing-code" });
    expect(decideCallback({ code: "", error: null })).toEqual({ kind: "back", reason: "missing-code" });
  });
});

describe("explainReason — plain words for every reason the callback can return", () => {
  it("has a distinct sentence for each known reason and a fallback for the rest", () => {
    const known = ["link-invalid", "not-invited", "missing-code", "cancelled", "provider-error"];
    const sentences = known.map(explainReason);
    expect(new Set(sentences).size).toBe(known.length);
    expect(explainReason("cancelled")).toMatch(/cancelled/i);
    expect(explainReason("cancelled")).not.toMatch(/error|fault|wrong/i);
    expect(explainReason("not-invited")).toMatch(/invite code/i);
    expect(explainReason("whatever")).toMatch(/did not complete/);
  });
});
