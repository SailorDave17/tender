import { describe, expect, it } from "vitest";
import type { RungPost } from "@/notify/rung";
import { PUSH_PAYLOAD_MAX_BYTES, encodePush, rungPush } from "./payload";

/** A race at 1 pm on a Sunday in Ohio — 17:00 UTC in June, when the club is on EDT. */
const post: RungPost = {
  id: "11111111-1111-4111-8111-111111111111",
  raceDateId: "22222222-2222-4222-8222-222222222222",
  boatClass: "Thistle",
  boatName: "Blue Moon",
  minimum: 2,
  startsAt: "2027-06-13T17:00:00Z",
  dateTitle: "Spring Series 3",
  currentRung: 1,
  closedAt: null,
};

describe("rungPush — what the phone shows (AC 5)", () => {
  it("names the boat, its class, the date and the rung word, and links to the post", () => {
    const p = rungPush(post, 2);
    expect(p.title).toBe("Crew needed: Blue Moon (Thistle)");
    expect(p.body).toBe("Sun, Jun 13, 1:00 PM · Rung 2 · amber");
    expect(p.url).toBe("/post/11111111-1111-4111-8111-111111111111");
  });

  it("uses the club's wall clock, not the machine's", () => {
    // 17:00 UTC is 1 pm in Ohio in June. A server in UTC would say 5:00 PM and a phone in
    // California 10:00 AM; both would be wrong for everyone reading this board.
    expect(rungPush(post, 1).body).toContain("1:00 PM");
    expect(rungPush({ ...post, startsAt: "2027-11-07T18:00:00Z" }, 1).body).toContain("1:00 PM"); // EST, after the change
  });

  it("says the crew's own rung, which is not always the post's open rung", () => {
    // A post open to rung 3 still has rung-1 crew on it; each is told their own.
    expect(rungPush(post, 1).body).toContain("Rung 1 · green");
    expect(rungPush(post, 2).body).toContain("Rung 2 · amber");
    expect(rungPush(post, 3).body).toContain("Rung 3 · red");
  });

  it("collapses repeats for one post with a per-post tag", () => {
    expect(rungPush(post, 1).tag).toBe(`post-${post.id}`);
    expect(rungPush(post, 3).tag).toBe(rungPush(post, 1).tag); // same post, same tag, whatever the rung
  });
});

describe("encodePush — the 4 KB ceiling is the protocol's (AC 5)", () => {
  it("encodes a real payload well inside the limit", () => {
    const json = encodePush(rungPush(post, 2));
    expect(new TextEncoder().encode(json).length).toBeLessThan(PUSH_PAYLOAD_MAX_BYTES);
    expect(JSON.parse(json)).toEqual(rungPush(post, 2));
  });

  it("throws rather than sending something the push service would reject", () => {
    // The positive control. Without it the assertion above is satisfied by an encoder that
    // never checks anything — and the failure it guards against is a notification that silently
    // never arrives, which is the hardest kind to notice.
    const huge = { ...rungPush(post, 1), body: "x".repeat(PUSH_PAYLOAD_MAX_BYTES) };
    expect(() => encodePush(huge)).toThrow(/over RFC 8291's 4096/);
  });

  it("counts BYTES, not characters — the limit is on the encoded payload", () => {
    // A boat named in multi-byte characters is shorter in characters than in bytes, and the
    // push service counts bytes. `"…".length` would let a payload through that is over.
    const emoji = "⛵"; // three bytes in UTF-8, one character to String.length
    const body = emoji.repeat(1400); // 4200 bytes, 1400 characters
    expect(body.length).toBeLessThan(PUSH_PAYLOAD_MAX_BYTES);
    expect(() => encodePush({ ...rungPush(post, 1), body })).toThrow(/over RFC 8291/);
  });
});
