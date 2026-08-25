import { createClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { MAX_PAGES, USERS_PER_PAGE, findAuthUser, type ListedUser, type UserPage } from "./find-user";

const ATTESTED = { display_name: "Alice", adult_attested_at: "2026-08-22T12:00:00.000Z" };

function user(id: string, email: string, meta: Record<string, unknown> | null = null): ListedUser {
  return { id, email, user_metadata: meta };
}

/** A pager over fixed pages, recording what it was asked for. */
function pager(pages: ListedUser[][]) {
  const asked: { page: number; perPage: number }[] = [];
  const listPage = async (page: number, perPage: number): Promise<UserPage> => {
    asked.push({ page, perPage });
    return { users: pages[page - 1] ?? [] };
  };
  return { listPage, asked };
}

/** A full page, so the caller keeps paging. Only the last entry's address is ever interesting. */
function filler(n = USERS_PER_PAGE): ListedUser[] {
  return Array.from({ length: n }, (_, i) => user(`id-${i}`, `filler-${i}@example.org`));
}

describe("findAuthUser — the address", () => {
  it("finds the user on the first page and reports an attestation", async () => {
    const { listPage, asked } = pager([[user("a", "someone@example.org"), user("b", "alice@example.org", ATTESTED)]]);
    expect(await findAuthUser("alice@example.org", listPage)).toEqual({
      found: true,
      id: "b",
      attested: true,
    });
    expect(asked).toEqual([{ page: 1, perPage: USERS_PER_PAGE }]);
  });

  it("matches case-insensitively and ignores surrounding space on both sides", async () => {
    const { listPage } = pager([[user("b", "  Alice@Example.ORG ")]]);
    expect(await findAuthUser("  ALICE@example.org  ", listPage)).toEqual({
      found: true,
      id: "b",
      attested: false,
    });
  });

  it("reports no attestation for absent, empty and unparseable values", async () => {
    for (const meta of [null, {}, { adult_attested_at: "" }, { adult_attested_at: "yesterday" }, { adult_attested_at: 12 }]) {
      const { listPage } = pager([[user("b", "alice@example.org", meta)]]);
      const r = await findAuthUser("alice@example.org", listPage);
      expect(r, JSON.stringify(meta)).toEqual({ found: true, id: "b", attested: false });
    }
  });

  it("stops at a short page and answers not-found, without asking for another", async () => {
    const { listPage, asked } = pager([[user("a", "someone@example.org")]]);
    expect(await findAuthUser("alice@example.org", listPage)).toEqual({ found: false });
    expect(asked).toEqual([{ page: 1, perPage: USERS_PER_PAGE }]);
  });

  it("answers not-found for an empty address without asking at all", async () => {
    const { listPage, asked } = pager([[user("a", "someone@example.org")]]);
    expect(await findAuthUser("   ", listPage)).toEqual({ found: false });
    expect(asked).toEqual([]);
  });

  it("pages on past a full page and finds the user on the second", async () => {
    const { listPage, asked } = pager([filler(), [user("b", "alice@example.org", ATTESTED)]]);
    expect(await findAuthUser("alice@example.org", listPage)).toEqual({
      found: true,
      id: "b",
      attested: true,
    });
    expect(asked.map((a) => a.page)).toEqual([1, 2]);
  });

  it("surfaces a page error rather than paging past it", async () => {
    let calls = 0;
    const listPage = async (): Promise<UserPage> => {
      calls++;
      return { error: "listUsers: 503" };
    };
    expect(await findAuthUser("alice@example.org", listPage)).toEqual({ error: "listUsers: 503" });
    expect(calls).toBe(1);
  });
});

/**
 * The one branch whose *choice of answer* is load-bearing rather than obvious. A `found: false`
 * here would put join() back on exactly the branch #85 is about: nothing to attest, send the
 * link anyway, callback deletes an invited member. So exhaustion is an error and the gate
 * refuses to send.
 */
describe("findAuthUser — running out of pages is an error, not a not-found", () => {
  it("returns an error after MAX_PAGES full pages", async () => {
    let calls = 0;
    const listPage = async (): Promise<UserPage> => {
      calls++;
      return { users: filler() };
    };
    const r = await findAuthUser("alice@example.org", listPage);
    expect(r).not.toEqual({ found: false });
    expect(r).toMatchObject({ error: expect.stringContaining(String(MAX_PAGES)) });
    expect(calls).toBe(MAX_PAGES);
  });
});

/**
 * Everything above proves the decision. Nothing above proves the ROUTE asks GoTrue the question
 * it thinks it is asking — a pager that dropped its `page` argument would loop on page 1 to
 * MAX_PAGES and answer "error" for every address past the first thousand, and no test with a
 * fake pager can see it. The live project cannot be reached from a session (the service-role key
 * is name-only in .env.local) and Docker is down, so the real client is driven offline against a
 * stubbed transport instead — the instrument #74 used for the same reason.
 */
describe("the real admin client sends what the pager promises", () => {
  function stubbed() {
    const seen: { method: string; url: string; body?: string }[] = [];
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      seen.push({ method: init?.method ?? "GET", url, body: init?.body as string | undefined });
      // GoTrue answers /admin/users with an OBJECT carrying `users`, and auth-js spreads that
      // body into its result — a bare `[]` here spreads to `{}` and `data.users` comes back
      // undefined. Learned from this stub, which is the point of driving the real client.
      return new Response(JSON.stringify({ users: [], aud: "authenticated" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof globalThis.fetch;
    const client = createClient("https://stub.supabase.invalid", "service-role-stub", {
      auth: { autoRefreshToken: false, persistSession: false },
      global: { fetch },
    });
    return { client, seen };
  }

  it("listUsers({ page, perPage }) asks for that page — so the route's pager really pages", async () => {
    const { client, seen } = stubbed();
    await findAuthUser("alice@example.org", async (page, perPage) => {
      const { data, error } = await client.auth.admin.listUsers({ page, perPage });
      if (error) return { error: error.message };
      return { users: data.users };
    });
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("GET");
    expect(seen[0].url).toContain(`page=1`);
    expect(seen[0].url).toContain(`per_page=${USERS_PER_PAGE}`);
  });

  it("updateUserById puts the metadata at that user's own admin URL", async () => {
    const { client, seen } = stubbed();
    await client.auth.admin.updateUserById(EXISTING, { user_metadata: ATTESTED });
    expect(seen).toHaveLength(1);
    expect(seen[0].method).toBe("PUT");
    expect(seen[0].url).toContain(`/auth/v1/admin/users/${EXISTING}`);
    expect(JSON.parse(seen[0].body ?? "{}")).toEqual({ user_metadata: ATTESTED });
  });
});

const EXISTING = "33333333-3333-4333-8333-333333333333";
