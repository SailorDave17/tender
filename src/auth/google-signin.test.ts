import { describe, expect, it } from "vitest";
import { explainReason } from "./callback";
import {
  AFTER_GOOGLE_SIGNIN,
  NOT_VERIFIED,
  NO_CREDENTIAL,
  googleSignIn,
  hasCredential,
  type GoogleSignInDeps,
} from "./google-signin";
import type { PersonStore } from "./person";

/**
 * #173 AC 2. The sign-in decision over fakes: which effects run, in which order, and — the half
 * worth the file — which do NOT. A recorder counts every dep by name, so "no Supabase call before
 * the token is present" is a claim about the whole list rather than about one named call.
 */

const USER = {
  id: "22222222-2222-4222-8222-222222222222",
  email: "Bob@Example.org",
  user_metadata: { full_name: "Bob Example", email_verified: true },
};

function fakes(overrides: { exists?: boolean; exchangeFails?: boolean } = {}) {
  const calls: string[] = [];
  const deleted: string[] = [];
  const inserted: string[] = [];
  const person: PersonStore = {
    exists: async () => {
      calls.push("exists");
      return overrides.exists ?? true;
    },
    insert: async (row) => {
      calls.push("insert");
      inserted.push(row.id);
      return {};
    },
    setMetadata: async () => {
      calls.push("setMetadata");
      return {};
    },
    deleteUser: async (id) => {
      calls.push("deleteUser");
      deleted.push(id);
      return {};
    },
  };
  const exchanged: string[] = [];
  const deps: GoogleSignInDeps = {
    exchange: async (credential, nonce) => {
      calls.push("exchange");
      exchanged.push(`${credential}|${nonce}`);
      if (overrides.exchangeFails) return { error: { code: "bad_oidc", message: "nonce mismatch" } };
      return { user: USER };
    },
    person,
    signOut: async () => {
      calls.push("signOut");
    },
  };
  return { deps, calls, deleted, inserted, exchanged };
}

const GOOD = { credential: "eyJ.id.token", nonce: "raw-nonce-from-the-browser" };

describe("googleSignIn — a returning member (#173 AC 2)", () => {
  it("exchanges the token WITH the nonce, finds the person row, and answers the board", async () => {
    const { deps, calls, exchanged } = fakes();
    expect(await googleSignIn(GOOD, deps)).toEqual({ status: 200, body: { redirect: AFTER_GOOGLE_SIGNIN } });
    expect(calls).toEqual(["exchange", "exists"]);
    // The nonce is what makes the token unreplayable; a route that dropped it would still sign in.
    expect(exchanged).toEqual(["eyJ.id.token|raw-nonce-from-the-browser"]);
  });

  it("makes NO call of any kind before the token is present", async () => {
    for (const input of [
      {},
      { credential: "", nonce: "n" },
      { credential: "t", nonce: "" },
      { credential: "t" },
      { nonce: "n" },
      { credential: 42, nonce: "n" },
    ]) {
      const { deps, calls } = fakes();
      expect(await googleSignIn(input, deps)).toEqual({ status: 400, body: { message: NO_CREDENTIAL } });
      expect(calls, JSON.stringify(input)).toEqual([]);
    }
  });

  it("the recorder really would catch a call — the control for the assertion above", async () => {
    const { deps, calls } = fakes();
    await deps.exchange("t", "n");
    await deps.person.exists("x");
    expect(calls).toEqual(["exchange", "exists"]);
  });

  it("a Google account matching no member is deleted once, nothing inserted, and told to sign up first", async () => {
    const { deps, calls, deleted, inserted } = fakes({ exists: false });
    const r = await googleSignIn(GOOD, deps);
    // The exact sentence /auth/callback sends a stray back to /join with — one sentence, one place.
    expect(r).toEqual({ status: 403, body: { message: explainReason("not-invited") } });
    expect(explainReason("not-invited")).toMatch(/sign up with this season's invite code/);
    expect(deleted).toEqual([USER.id]);
    expect(inserted).toEqual([]);
    // ...and the session the exchange wrote is undone, after the delete.
    expect(calls).toEqual(["exchange", "exists", "deleteUser", "signOut"]);
  });

  it("a user the email gate created — attestation on the metadata — is minted, not deleted", async () => {
    const { deps, calls, deleted, inserted } = fakes({ exists: false });
    deps.exchange = async () => ({
      user: { ...USER, user_metadata: { display_name: "Bob", adult_attested_at: "2026-08-22T12:00:00.000Z" } },
    });
    expect((await googleSignIn(GOOD, deps)).status).toBe(200);
    expect(deleted).toEqual([]);
    expect(inserted).toEqual([USER.id]);
    expect(calls).not.toContain("signOut");
  });

  it("a refused exchange is one plain sentence, and the person store is never reached", async () => {
    const { deps, calls } = fakes({ exchangeFails: true });
    expect(await googleSignIn(GOOD, deps)).toEqual({ status: 401, body: { message: NOT_VERIFIED } });
    expect(calls).toEqual(["exchange"]);
    // Plain words, no library vocabulary: a member cannot act on "nonce" or "oidc".
    expect(NOT_VERIFIED).not.toMatch(/nonce|oidc|token/i);
    expect(NOT_VERIFIED).toMatch(/email and password/);
  });
});

describe("hasCredential", () => {
  it("wants two non-empty strings and nothing less", () => {
    expect(hasCredential(GOOD)).toBe(true);
    expect(hasCredential({ credential: "t", nonce: "n" })).toBe(true);
    expect(hasCredential({ credential: "t", nonce: 1 })).toBe(false);
    expect(hasCredential({ credential: null, nonce: "n" })).toBe(false);
    expect(hasCredential({})).toBe(false);
  });
});
