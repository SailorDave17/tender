import { describe, expect, it } from "vitest";
import { DEFAULT_NEXT, safeNext } from "./next";

describe("safeNext — the redirect after the magic link never leaves this origin (AC 4)", () => {
  it.each([
    ["https://evil.example/phish", "absolute URL"],
    ["//evil.example/phish", "protocol-relative"],
    ["/\\evil.example", "backslash after the slash, which browsers read as //"],
    ["javascript:alert(1)", "a scheme with no slash"],
    ["/board\r\nSet-Cookie: x=y", "a control character smuggling a header"],
  ])("sends %s (%s) to the board", (hostile) => {
    expect(safeNext(hostile)).toBe(DEFAULT_NEXT);
  });

  it("keeps an honest path with its query and hash", () => {
    expect(safeNext("/board")).toBe("/board");
    expect(safeNext("/admin/dates?d=2027-05-02#top")).toBe("/admin/dates?d=2027-05-02#top");
  });

  it("defaults when there is nothing", () => {
    expect(safeNext(null)).toBe(DEFAULT_NEXT);
    expect(safeNext(undefined)).toBe(DEFAULT_NEXT);
    expect(safeNext("")).toBe(DEFAULT_NEXT);
  });
});
