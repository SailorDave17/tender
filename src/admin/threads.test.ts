import { describe, expect, it } from "vitest";
import { threadsByActivity, type ThreadMatch, type ThreadMessage } from "./threads";

const match = (id: string, accepted_at: string): ThreadMatch => ({
  id,
  post_id: `post-${id}`,
  skipper_id: "s",
  crew_id: "c",
  accepted_at,
});
const msg = (match_id: string, created_at: string, removed_at: string | null = null): ThreadMessage => ({
  match_id,
  created_at,
  removed_at,
});

describe("threadsByActivity (#36 AC 1)", () => {
  it("orders by the newest message, newest thread first", () => {
    const out = threadsByActivity(
      [match("a", "2027-05-01T10:00:00Z"), match("b", "2027-05-01T11:00:00Z")],
      [
        msg("a", "2027-05-03T09:00:00Z"),
        msg("b", "2027-05-02T09:00:00Z"),
        // a's older message must not win: the newest message is the activity, not the first.
        msg("a", "2027-05-01T12:00:00Z"),
      ],
    );
    expect(out.map((t) => [t.id, t.lastActivity, t.messages])).toEqual([
      ["a", "2027-05-03T09:00:00.000Z", 2],
      ["b", "2027-05-02T09:00:00.000Z", 1],
    ]);
  });

  it("lists a silent thread at its acceptance, between busier ones", () => {
    const out = threadsByActivity(
      [match("quiet", "2027-05-02T12:00:00Z"), match("old", "2027-05-01T00:00:00Z"), match("new", "2027-05-01T00:00:00Z")],
      [msg("old", "2027-05-01T06:00:00Z"), msg("new", "2027-05-03T06:00:00Z")],
    );
    expect(out.map((t) => [t.id, t.messages])).toEqual([
      ["new", 1],
      ["quiet", 0],
      ["old", 1],
    ]);
    expect(out[1].lastActivity).toBe("2027-05-02T12:00:00Z");
  });

  it("counts a removed message as activity, and counts it separately", () => {
    const out = threadsByActivity(
      [match("x", "2027-05-01T00:00:00Z"), match("y", "2027-05-01T00:00:00Z")],
      [msg("x", "2027-05-01T01:00:00Z"), msg("y", "2027-05-01T02:00:00Z", "2027-05-01T03:00:00Z")],
    );
    expect(out.map((t) => [t.id, t.messages, t.removed])).toEqual([
      ["y", 1, 1],
      ["x", 1, 0],
    ]);
  });

  it("ignores messages for a match it was not given", () => {
    const out = threadsByActivity([match("x", "2027-05-01T00:00:00Z")], [msg("ghost", "2027-06-01T00:00:00Z")]);
    expect(out).toEqual([{ ...match("x", "2027-05-01T00:00:00Z"), lastActivity: "2027-05-01T00:00:00Z", messages: 0, removed: 0 }]);
  });
});
