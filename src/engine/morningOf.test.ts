import { describe, expect, it } from "vitest";
import type { RungPost } from "@/notify/rung";
import { REMINDER_HOUR, reminderDue, runMorningOf, type MorningMatch, type MorningOfRepo } from "./morningOf";

/**
 * The morning-of rule at its boundaries, with `now` pinned (story #37 AC 2, AC 5). The club's
 * wall clock is the subject — a race at 1 pm in Ohio is 17:00 UTC in June and 18:00 UTC in
 * November — so every instant below is written in UTC and annotated with what Ohio reads.
 *
 * The behaviour fixtures — who is emailed, that reminded_at moves, that a second tick is
 * quiet — run over real SQL in test/morning-of.test.ts. What this file can say that a database
 * cannot is exactly where the boundary falls, to the second, on both sides of a DST change.
 */

/** A race at 1 pm EDT on a Sunday in June. */
const JUNE_RACE = "2027-06-13T17:00:00Z";
/** A race at 1 pm EST on the Sunday AFTER the clocks go back (2027-11-07). */
const NOVEMBER_RACE = "2027-11-07T18:00:00Z";

describe("reminderDue — the race morning, on the club's clock", () => {
  it("is 06:00 America/New_York, as decision H recorded it", () => {
    expect(REMINDER_HOUR).toBe(6);
  });

  it("is not due at 05:59:59 and is due at 06:00:00 on the race day (June, EDT)", () => {
    expect(reminderDue(JUNE_RACE, new Date("2027-06-13T09:59:59Z"))).toBe(false); // 05:59:59 EDT
    expect(reminderDue(JUNE_RACE, new Date("2027-06-13T10:00:00Z"))).toBe(true); // 06:00:00 EDT
    expect(reminderDue(JUNE_RACE, new Date("2027-06-13T12:30:00Z"))).toBe(true); // 08:30 EDT
  });

  it("is not due the night before, however late — the day is the calendar day in Ohio, not UTC", () => {
    // 23:59:59 EDT on Saturday is already 03:59:59 UTC on the race's UTC date; a UTC-day rule
    // would fire here, at midnight in Ohio, five hours early.
    expect(reminderDue(JUNE_RACE, new Date("2027-06-13T03:59:59Z"))).toBe(false);
    // and 00:00 on the race day is the day, but 06:00 has not come
    expect(reminderDue(JUNE_RACE, new Date("2027-06-13T04:00:00Z"))).toBe(false);
  });

  it("is not due once the race has started — a catch-up tick after the boat left sends nothing (owner decision 2026-09-18)", () => {
    expect(reminderDue(JUNE_RACE, new Date("2027-06-13T16:59:59Z"))).toBe(true); // 12:59:59 EDT, still before
    expect(reminderDue(JUNE_RACE, new Date("2027-06-13T17:00:00Z"))).toBe(false); // the start itself
    expect(reminderDue(JUNE_RACE, new Date("2027-06-13T20:00:00Z"))).toBe(false); // 4 pm, race day, sailed
  });

  it("is not due the day after, nor a week out", () => {
    expect(reminderDue(JUNE_RACE, new Date("2027-06-14T10:00:00Z"))).toBe(false);
    expect(reminderDue(JUNE_RACE, new Date("2027-06-06T10:00:00Z"))).toBe(false);
  });

  it("uses the offset in force on the race day — 06:00 EST in November is 11:00 UTC, not 10:00", () => {
    expect(reminderDue(NOVEMBER_RACE, new Date("2027-11-07T10:59:59Z"))).toBe(false); // 05:59:59 EST
    expect(reminderDue(NOVEMBER_RACE, new Date("2027-11-07T11:00:00Z"))).toBe(true); // 06:00:00 EST
    // and the night before is still the night before: 23:59:59 EDT (the clocks go back at 02:00)
    expect(reminderDue(NOVEMBER_RACE, new Date("2027-11-07T03:59:59Z"))).toBe(false);
  });
});

const post = (id: string, startsAt: string): RungPost => ({
  id,
  raceDateId: "22222222-2222-4222-8222-222222222222",
  boatClass: "Thistle",
  boatName: "Blue Moon",
  minimum: 2,
  startsAt,
  dateTitle: "Spring Series 3",
  currentRung: 1,
  closedAt: "2027-06-01T00:00:00Z",
});

const match = (id: string, startsAt: string): MorningMatch => ({
  id,
  skipperId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  crewId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  post: post(`post-${id}`, startsAt),
});

class RecordingRepo implements MorningOfRepo {
  reads = 0;
  rows: MorningMatch[] = [];
  async candidates() {
    this.reads += 1;
    return this.rows;
  }
}

describe("runMorningOf — what it hands to `remind`, and what it does not", () => {
  const SIX_AM_JUNE_13 = new Date("2027-06-13T10:00:00Z");

  it("reminds exactly the due candidates, in order, and reports both counts", async () => {
    const repo = new RecordingRepo();
    repo.rows = [
      match("today-1", JUNE_RACE),
      match("next-week", "2027-06-20T17:00:00Z"),
      match("today-2", "2027-06-13T18:30:00Z"), // a second race the same day, later
    ];
    const reminded: string[] = [];
    const result = await runMorningOf(repo, async (m) => void reminded.push(m.id), SIX_AM_JUNE_13);
    expect(result).toEqual({ candidates: 3, due: ["today-1", "today-2"] });
    expect(reminded).toEqual(["today-1", "today-2"]);
    expect(repo.reads).toBe(1);
  });

  it("reads the candidates and reminds nobody when none is due — a quiet pass still reports its work", async () => {
    const repo = new RecordingRepo();
    repo.rows = [match("next-week", "2027-06-20T17:00:00Z")];
    const reminded: string[] = [];
    const result = await runMorningOf(repo, async (m) => void reminded.push(m.id), SIX_AM_JUNE_13);
    expect(result).toEqual({ candidates: 1, due: [] });
    expect(reminded).toEqual([]);
  });

  it("lets a `remind` that throws propagate, and reports nothing past it", async () => {
    const repo = new RecordingRepo();
    repo.rows = [match("today-1", JUNE_RACE), match("today-2", "2027-06-13T18:30:00Z")];
    const reminded: string[] = [];
    await expect(
      runMorningOf(
        repo,
        async (m) => {
          if (m.id === "today-1") throw new Error("the store said no");
          reminded.push(m.id);
        },
        SIX_AM_JUNE_13,
      ),
    ).rejects.toThrow("the store said no");
    expect(reminded).toEqual([]); // the live wrapper swallows per match; the engine does not
  });
});
