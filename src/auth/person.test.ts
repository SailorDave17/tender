import { describe, expect, it } from "vitest";
import { ensurePerson, type PersonStore } from "./person";

function store(existing = false) {
  const inserted: Parameters<PersonStore["insert"]>[0][] = [];
  const s: PersonStore = {
    exists: async () => existing,
    insert: async (row) => {
      inserted.push(row);
      return {};
    },
  };
  return { s, inserted };
}

const invited = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "Alice@Example.org",
  user_metadata: { display_name: "Alice", adult_attested_at: "2026-08-22T12:00:00.000Z" },
};

describe("ensurePerson — the first sign-in mints the person rows (AC 4)", () => {
  it("inserts person and contact from the auth user's metadata on first sign-in", async () => {
    const { s, inserted } = store(false);
    expect(await ensurePerson(invited, s)).toEqual({ created: true });
    expect(inserted).toEqual([
      {
        id: invited.id,
        display_name: "Alice",
        adult_attested_at: "2026-08-22T12:00:00.000Z",
        email: "alice@example.org",
      },
    ]);
  });

  it("writes nothing on a later sign-in", async () => {
    const { s, inserted } = store(true);
    expect(await ensurePerson(invited, s)).toEqual({ created: false });
    expect(inserted).toEqual([]);
  });

  it("refuses an auth user with no attestation — adults-only stays structural", async () => {
    const { s, inserted } = store(false);
    const r = await ensurePerson({ ...invited, user_metadata: { display_name: "Eve" } }, s);
    expect(r).toEqual({ created: false, refused: "no adult attestation on the auth user" });
    expect(inserted).toEqual([]);
  });

  it("refuses a garbage attestation and a user with no email", async () => {
    const { s, inserted } = store(false);
    expect(
      await ensurePerson({ ...invited, user_metadata: { adult_attested_at: "yesterday-ish" } }, s),
    ).toMatchObject({ refused: expect.stringMatching(/attestation/) });
    expect(await ensurePerson({ ...invited, email: null }, s)).toMatchObject({
      refused: "auth user has no email",
    });
    expect(inserted).toEqual([]);
  });

  it("falls back to the address's local part when no display name was recorded", async () => {
    const { s, inserted } = store(false);
    await ensurePerson(
      { ...invited, user_metadata: { adult_attested_at: "2026-08-22T12:00:00.000Z" } },
      s,
    );
    expect(inserted[0].display_name).toBe("alice");
  });

  it("surfaces a store refusal instead of reporting success", async () => {
    const s: PersonStore = { exists: async () => false, insert: async () => ({ error: "42501" }) };
    expect(await ensurePerson(invited, s)).toEqual({ created: false, refused: "42501" });
  });
});
