import { describe, expect, it } from "vitest";
import { NAME_MAX } from "@/profile/welcome";
import { attestationOf, ensurePerson, provisionalName, type GateAttestation, type PersonStore } from "./person";

/** A fake store recording every write, so each branch can assert what was and was not touched. */
function store(existing = false) {
  const inserted: Parameters<PersonStore["insert"]>[0][] = [];
  const metadata: { id: string; meta: { adult_attested_at: string } }[] = [];
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

/**
 * An auth user the email gate created: its attestation in `app_metadata`, which only the service
 * role writes (#267), and a pre-#220 `display_name` in `user_metadata`, which the user writes.
 */
const invited = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "Alice@Example.org",
  user_metadata: { display_name: "Alice" },
  app_metadata: { provider: "email", adult_attested_at: "2026-08-22T12:00:00.000Z" },
};

/** A Google-created auth user: an email, no metadata of the gate's. */
const googleUser = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "Bob@Example.org",
  user_metadata: { full_name: "Bob Example", email_verified: true },
};

/** Since #220 the gate proves one thing: when the account was created, which is the 18+ confirmation. */
const gate: GateAttestation = {
  adult_attested_at: "2026-08-23T10:00:00.000Z",
};

describe("ensurePerson — the first sign-in mints the person rows (#15 AC 4)", () => {
  it("inserts person and contact from the auth user's metadata on first sign-in", async () => {
    const { s, inserted, deleted, metadata } = store(false);
    expect(await ensurePerson(invited, s)).toEqual({ created: true, usedGate: false });
    // profile_completed_at is written as an explicit NULL on every mint (#220): 0031's
    // `default now()` would otherwise stamp the member finished and skip /welcome.
    expect(inserted).toEqual([
      {
        id: invited.id,
        display_name: "Alice",
        adult_attested_at: "2026-08-22T12:00:00.000Z",
        profile_completed_at: null,
        email: "alice@example.org",
      },
    ]);
    expect(deleted).toEqual([]);
    expect(metadata).toEqual([]);
  });

  it("writes nothing on a later sign-in — with or without a gate attestation offered", async () => {
    const { s, inserted, deleted, metadata } = store(true);
    expect(await ensurePerson(invited, s)).toEqual({ created: false });
    expect(await ensurePerson(googleUser, s, gate)).toEqual({ created: false });
    expect(inserted).toEqual([]);
    expect(deleted).toEqual([]);
    expect(metadata).toEqual([]);
  });

  it("refuses a garbage attestation with no gate, and a user with no email", async () => {
    const { s, inserted } = store(false);
    expect(
      await ensurePerson({ ...invited, app_metadata: { adult_attested_at: "yesterday-ish" } }, s),
    ).toMatchObject({ refused: expect.stringMatching(/attestation/), deleted: true });
    expect(await ensurePerson({ ...invited, email: null }, s)).toMatchObject({
      refused: "auth user has no email",
      deleted: false,
    });
    expect(inserted).toEqual([]);
  });

  it("falls back to the address's local part when no display name was recorded", async () => {
    const { s, inserted } = store(false);
    await ensurePerson({ ...invited, user_metadata: {} }, s);
    expect(inserted[0].display_name).toBe("alice");
  });

  it("surfaces a store refusal instead of reporting success", async () => {
    const { s } = store(false);
    s.insert = async () => ({ error: "42501" });
    expect(await ensurePerson(invited, s)).toEqual({ created: false, refused: "42501", deleted: false });
  });
});

describe("ensurePerson — the Google path and the gate attestation (#70 AC 5, the pass retired by #173)", () => {
  it("with a gate attestation: writes it onto the user, then mints the rows from it", async () => {
    const { s, inserted, metadata, deleted } = store(false);
    expect(await ensurePerson(googleUser, s, gate)).toEqual({ created: true, usedGate: true });
    expect(metadata).toEqual([{ id: googleUser.id, meta: { adult_attested_at: gate.adult_attested_at } }]);
    // The name is PROVISIONAL since #220 — what Google sent, here its `full_name` — and the row is
    // unfinished, so the member is asked for their real name on /welcome.
    expect(inserted).toEqual([
      {
        id: googleUser.id,
        display_name: "Bob Example",
        adult_attested_at: gate.adult_attested_at,
        profile_completed_at: null,
        email: "bob@example.org",
      },
    ]);
    expect(deleted).toEqual([]);
  });

  it("without a gate: deletes the auth user exactly once and inserts nothing", async () => {
    const { s, inserted, metadata, deleted } = store(false);
    const r = await ensurePerson(googleUser, s, null);
    expect(r).toEqual({
      created: false,
      refused: "no adult attestation on the auth user and no invite gate behind it",
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

  it("a user carrying the email gate's metadata ignores the gate attestation — exactly as today", async () => {
    const { s, inserted, metadata, deleted } = store(false);
    const other: GateAttestation = { adult_attested_at: "2020-01-01T00:00:00.000Z" };
    expect(await ensurePerson(invited, s, other)).toEqual({ created: true, usedGate: false });
    expect(inserted[0]).toMatchObject({ display_name: "Alice", adult_attested_at: invited.app_metadata.adult_attested_at });
    expect(metadata).toEqual([]);
    expect(deleted).toEqual([]);
  });

  it("with a gate, the attestation written onto the user is the GATE's, and it goes to app_metadata's writer", async () => {
    // A Google user arriving with an attestation in user_metadata — one they could have written —
    // gets the gate's clock, not their own: the store writes what the gate proved (#267).
    const { s, inserted, metadata } = store(false);
    const selfAttested = { ...googleUser, user_metadata: { ...googleUser.user_metadata, adult_attested_at: "2020-01-01T00:00:00.000Z" } };
    expect(await ensurePerson(selfAttested, s, gate)).toEqual({ created: true, usedGate: true });
    expect(metadata).toEqual([{ id: googleUser.id, meta: { adult_attested_at: gate.adult_attested_at } }]);
    expect(inserted[0].adult_attested_at).toBe(gate.adult_attested_at);
  });

  it("a metadata write that fails refuses without inserting or deleting", async () => {
    const { s, inserted, deleted } = store(false);
    s.setMetadata = async () => ({ error: "admin api down" });
    expect(await ensurePerson(googleUser, s, gate)).toEqual({
      created: false,
      refused: "admin api down",
      deleted: false,
    });
    expect(inserted).toEqual([]);
    expect(deleted).toEqual([]);
  });
});

/**
 * #267 (SA-R1's first regression check). `user_metadata` is written by the user — at sign-up
 * through `options.data`, afterwards through `updateUser({ data })`, with only the public anon key
 * — so an attestation found there is one the user wrote about themselves. With *Allow new users to
 * sign up* ON, anyone could sign up outside the invite gate, put the attestation in their own
 * user_metadata, and arrive at a no-gate caller (/auth/callback on a reset link, the Google sign-in
 * route) to be minted a member without the season's code. The attestation counts only in
 * `app_metadata`, which only the service role writes.
 */
describe("ensurePerson — an attestation the user wrote themselves admits nobody (#267)", () => {
  it("with no gate, an attestation found only in user_metadata is refused and the auth user deleted", async () => {
    const { s, inserted, metadata, deleted } = store(false);
    const selfAttested = {
      id: "33333333-3333-4333-8333-333333333333",
      email: "Mallory@Example.org",
      user_metadata: { adult_attested_at: "2026-08-22T12:00:00.000Z" },
      app_metadata: { provider: "email", providers: ["email"] },
    };
    expect(await ensurePerson(selfAttested, s, null)).toEqual({
      created: false,
      refused: "no adult attestation on the auth user and no invite gate behind it",
      deleted: true,
    });
    expect(inserted, "a person row minted without the invite code").toEqual([]);
    expect(deleted).toEqual([selfAttested.id]);
    expect(metadata).toEqual([]);
  });

  it("attestationOf reads app_metadata and nothing else", () => {
    const at = "2026-08-22T12:00:00.000Z";
    expect(attestationOf({ app_metadata: { adult_attested_at: at } })).toBe(at);
    // The user-writable copy is invisible to it, however well-formed.
    expect(attestationOf({ user_metadata: { adult_attested_at: at } } as { app_metadata?: null })).toBeNull();
    expect(attestationOf({ app_metadata: null })).toBeNull();
    expect(attestationOf({})).toBeNull();
    for (const bad of ["", "yesterday", 12, null]) {
      expect(attestationOf({ app_metadata: { adult_attested_at: bad } }), JSON.stringify(bad)).toBeNull();
    }
  });
});

/**
 * #220 AC 4's mechanism, and its fallbacks in order. The form no longer supplies a name, so the row
 * gets a provisional one the member replaces on /welcome: a `display_name` the pre-#220 gate wrote,
 * else Google's given name, else the whole name Google sends under either key GoTrue has used, else
 * the address's local part. Whether GoTrue actually forwards `given_name` for a Google ID token is
 * NOT established here — the fixtures this repo has carried since #70 hold `full_name` only — which
 * is why the chain does not stop at the given name.
 */
describe("provisionalName — the name a member has until they say who they are (#220)", () => {
  const email = "bob@example.org";

  it("prefers a display_name the email gate wrote, then given_name, then name, then full_name", () => {
    expect(provisionalName({ display_name: "Alice", given_name: "Al", full_name: "Alice Example" }, email)).toBe("Alice");
    expect(provisionalName({ given_name: "Bob", name: "Bob Example", full_name: "Bob Example" }, email)).toBe("Bob");
    expect(provisionalName({ name: "Bob Example", full_name: "Robert Example" }, email)).toBe("Bob Example");
    expect(provisionalName({ full_name: "Robert Example" }, email)).toBe("Robert Example");
  });

  it("falls back to the address's local part when nothing usable was sent", () => {
    expect(provisionalName({ email_verified: true }, email)).toBe("bob");
    expect(provisionalName({}, email)).toBe("bob");
    expect(provisionalName(null, email)).toBe("bob");
    expect(provisionalName(undefined, email)).toBe("bob");
    // blank and non-string values do not count as a name
    expect(provisionalName({ given_name: "   ", full_name: 7 }, email)).toBe("bob");
  });

  it("trims, and cuts to NAME_MAX so 0002's check cannot refuse the insert over a name nobody typed", () => {
    expect(provisionalName({ given_name: "  Bob  " }, email)).toBe("Bob");
    expect(provisionalName({ full_name: "x".repeat(NAME_MAX + 1) }, email)).toHaveLength(NAME_MAX);
    expect(provisionalName({}, `${"y".repeat(NAME_MAX + 5)}@example.org`)).toHaveLength(NAME_MAX);
  });
});
