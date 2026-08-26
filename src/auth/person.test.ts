import { describe, expect, it } from "vitest";
import type { PassPayload } from "./pass";
import { ensurePerson, type PersonStore } from "./person";

/** A fake store recording every write, so each branch can assert what was and was not touched. */
function store(existing = false) {
  const inserted: Parameters<PersonStore["insert"]>[0][] = [];
  const metadata: { id: string; meta: { display_name: string; adult_attested_at: string } }[] = [];
  const deleted: string[] = [];
  const s: PersonStore = {
    exists: async () => existing,
    insert: async (row) => {
      inserted.push(row);
      return {};
    },
    setMetadata: async (id, meta) => {
      metadata.push({ id, meta });
      return {};
    },
    deleteUser: async (id) => {
      deleted.push(id);
      return {};
    },
  };
  return { s, inserted, metadata, deleted };
}

const invited = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "Alice@Example.org",
  user_metadata: { display_name: "Alice", adult_attested_at: "2026-08-22T12:00:00.000Z" },
};

/** A Google-created auth user: an email, no metadata of the gate's. */
const googleUser = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "Bob@Example.org",
  user_metadata: { full_name: "Bob Example", email_verified: true },
};

const pass: PassPayload = {
  display_name: "Bob",
  adult_attested_at: "2026-08-23T10:00:00.000Z",
  issued_at: "2026-08-23T10:00:00.000Z",
};

describe("ensurePerson — the first sign-in mints the person rows (#15 AC 4)", () => {
  it("inserts person and contact from the auth user's metadata on first sign-in", async () => {
    const { s, inserted, deleted, metadata } = store(false);
    expect(await ensurePerson(invited, s)).toEqual({ created: true, usedPass: false });
    expect(inserted).toEqual([
      {
        id: invited.id,
        display_name: "Alice",
        adult_attested_at: "2026-08-22T12:00:00.000Z",
        email: "alice@example.org",
      },
    ]);
    expect(deleted).toEqual([]);
    expect(metadata).toEqual([]);
  });

  it("writes nothing on a later sign-in — with or without a pass lying around", async () => {
    const { s, inserted, deleted, metadata } = store(true);
    expect(await ensurePerson(invited, s)).toEqual({ created: false });
    expect(await ensurePerson(googleUser, s, pass)).toEqual({ created: false });
    expect(inserted).toEqual([]);
    expect(deleted).toEqual([]);
    expect(metadata).toEqual([]);
  });

  it("refuses a garbage attestation with no pass, and a user with no email", async () => {
    const { s, inserted } = store(false);
    expect(
      await ensurePerson({ ...invited, user_metadata: { adult_attested_at: "yesterday-ish" } }, s),
    ).toMatchObject({ refused: expect.stringMatching(/attestation/), deleted: true });
    expect(await ensurePerson({ ...invited, email: null }, s)).toMatchObject({
      refused: "auth user has no email",
      deleted: false,
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
    const { s } = store(false);
    s.insert = async () => ({ error: "42501" });
    expect(await ensurePerson(invited, s)).toEqual({ created: false, refused: "42501", deleted: false });
  });
});

describe("ensurePerson — the Google path and the gate pass (#70 AC 5)", () => {
  it("with a valid pass: writes the attestation onto the user, then mints the rows from it", async () => {
    const { s, inserted, metadata, deleted } = store(false);
    expect(await ensurePerson(googleUser, s, pass)).toEqual({ created: true, usedPass: true });
    expect(metadata).toEqual([
      { id: googleUser.id, meta: { display_name: "Bob", adult_attested_at: pass.adult_attested_at } },
    ]);
    expect(inserted).toEqual([
      {
        id: googleUser.id,
        display_name: "Bob",
        adult_attested_at: pass.adult_attested_at,
        email: "bob@example.org",
      },
    ]);
    expect(deleted).toEqual([]);
  });

  it("without a pass: deletes the auth user exactly once and inserts nothing", async () => {
    const { s, inserted, metadata, deleted } = store(false);
    const r = await ensurePerson(googleUser, s, null);
    expect(r).toEqual({
      created: false,
      refused: "no adult attestation on the auth user and no gate pass",
      deleted: true,
    });
    expect(deleted).toEqual([googleUser.id]);
    expect(inserted).toEqual([]);
    expect(metadata).toEqual([]);
  });

  it("reports a delete that failed as not deleted, still refusing", async () => {
    const { s, inserted } = store(false);
    s.deleteUser = async () => ({ error: "gone already" });
    expect(await ensurePerson(googleUser, s)).toMatchObject({ refused: expect.any(String), deleted: false });
    expect(inserted).toEqual([]);
  });

  it("a user carrying the email gate's metadata ignores the pass — exactly as today", async () => {
    const { s, inserted, metadata, deleted } = store(false);
    const other: PassPayload = { ...pass, display_name: "Impostor", adult_attested_at: "2020-01-01T00:00:00.000Z" };
    expect(await ensurePerson(invited, s, other)).toEqual({ created: true, usedPass: false });
    expect(inserted[0]).toMatchObject({ display_name: "Alice", adult_attested_at: invited.user_metadata.adult_attested_at });
    expect(metadata).toEqual([]);
    expect(deleted).toEqual([]);
  });

  it("a metadata write that fails refuses without inserting or deleting", async () => {
    const { s, inserted, deleted } = store(false);
    s.setMetadata = async () => ({ error: "admin api down" });
    expect(await ensurePerson(googleUser, s, pass)).toEqual({
      created: false,
      refused: "admin api down",
      deleted: false,
    });
    expect(inserted).toEqual([]);
    expect(deleted).toEqual([]);
  });
});
