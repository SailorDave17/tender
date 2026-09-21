import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { restoreVerifiers, verifierCookies } from "@/auth/link";
import { exchangeGoogleIdToken, startGoogleLink } from "./google";

/**
 * #74, re-taken by #173. The whole story is which Supabase call is made: `signInWithIdToken`
 * exchanges a token the browser obtained on OUR origin (so the Google screen named our host);
 * `signInWithOAuth` — gone since #173 — redirected through Supabase's host; `linkIdentity`
 * attaches an identity to the session's existing user and is still a redirect. The tests
 * assert on which method was called and record that the others were not.
 */

type Call = { method: string; args: unknown };

function fakeClient(answers: Record<string, unknown>): { client: SupabaseClient; calls: Call[] } {
  const calls: Call[] = [];
  const auth = {
    signInWithOAuth: async (args: unknown) => {
      calls.push({ method: "signInWithOAuth", args });
      return answers.signInWithOAuth ?? { data: { url: null }, error: null };
    },
    signInWithIdToken: async (args: unknown) => {
      calls.push({ method: "signInWithIdToken", args });
      return answers.signInWithIdToken ?? { data: { user: null, session: null }, error: null };
    },
    linkIdentity: async (args: unknown) => {
      calls.push({ method: "linkIdentity", args });
      return answers.linkIdentity ?? { data: { url: null }, error: null };
    },
  };
  return { client: { auth } as unknown as SupabaseClient, calls };
}

const OK = { data: { provider: "google", url: "https://accounts.google.com/o/oauth2/v2/auth?x=1", flowId: null }, error: null };

describe("startGoogleLink — links, and does not sign in (#74 AC 1)", () => {
  it("calls linkIdentity and never signInWithOAuth or signInWithIdToken", async () => {
    const { client, calls } = fakeClient({ linkIdentity: OK });
    await startGoogleLink(client, "https://tender.example");
    expect(calls.map((c) => c.method)).toEqual(["linkIdentity"]);
  });

  it("asks for google and returns the URL for the caller to redirect to", async () => {
    const { client, calls } = fakeClient({ linkIdentity: OK });
    const out = await startGoogleLink(client, "https://tender.example");
    expect((calls[0].args as { provider: string }).provider).toBe("google");
    expect(out).toEqual({ url: "https://accounts.google.com/o/oauth2/v2/auth?x=1" });
  });

  it("marks the return leg so the callback lands it on the profile, not on /join", async () => {
    const { client, calls } = fakeClient({ linkIdentity: OK });
    await startGoogleLink(client, "https://tender.example");
    const redirectTo = (calls[0].args as { options: { redirectTo: string } }).options.redirectTo;
    const u = new URL(redirectTo);
    expect(u.origin).toBe("https://tender.example");
    expect(u.pathname).toBe("/auth/callback");
    expect(u.searchParams.get("flow")).toBe("link");
    expect(u.searchParams.get("next")).toBe("/profile");
  });

  it("passes GoTrue's error CODE on, not only its message — link.ts decides on the code", async () => {
    const { client } = fakeClient({
      linkIdentity: {
        data: { provider: "google", url: null, flowId: null },
        error: { code: "manual_linking_disabled", message: "Manual linking is disabled", status: 404 },
      },
    });
    expect(await startGoogleLink(client, "https://tender.example")).toEqual({
      error: { code: "manual_linking_disabled", message: "Manual linking is disabled" },
    });
  });

  it("reports a success carrying no URL as no URL, rather than throwing", async () => {
    const { client } = fakeClient({ linkIdentity: { data: { provider: "google", url: null, flowId: null }, error: null } });
    expect(await startGoogleLink(client, "https://tender.example")).toEqual({ url: null });
  });
});

/**
 * The one test here that drives the REAL client rather than a fake, because the defect it is
 * about lives inside the library: `linkIdentity` writes a PKCE verifier before it asks GoTrue
 * whether the link may proceed, and its failure path cleans nothing up. Everything is offline —
 * the transport is stubbed with GoTrue's own 404 body, which is the shape a project with *Allow
 * manual linking* off returns and which no probe against the live project can produce.
 *
 * #99 removed the magic link and this stayed, which is the one place in that story where the
 * obvious tidy-up would have removed a live defence. `resetPasswordForEmail` is a PKCE link too,
 * addressed at the same fixed slot, so the victim moved rather than went: the link a refused
 * Google start now eats is a password reset, belonging to the one member who cannot sign in
 * without it. The fixture is renamed to say so; the mechanism is untouched.
 */
describe("a refused link start must not eat a pending reset link (#74, kept by #99)", () => {
  const REF = "sb-proj-auth-token";
  const FIXED = `${REF}-code-verifier`;
  const PENDING_RESET = "the-verifier-a-reset-link-in-the-inbox-depends-on";

  function jar(seed: Record<string, string>) {
    const map = new Map(Object.entries(seed));
    return {
      map,
      cookies: {
        getAll: () => [...map].map(([name, value]) => ({ name, value })),
        setAll: (toSet: { name: string; value: string }[]) => {
          for (const { name, value } of toSet) if (value === "") map.delete(name); else map.set(name, value);
        },
      },
    };
  }

  const REFUSED = () =>
    new Response(JSON.stringify({ code: 404, error_code: "manual_linking_disabled", msg: "Manual linking is disabled" }),
      { status: 404, headers: { "content-type": "application/json" } });

  it("the library really does clobber the fixed key on a refusal — and the plan puts it back", async () => {
    const j = jar({ [FIXED]: PENDING_RESET });
    const client = createServerClient("https://proj.supabase.co", "anon-key", {
      cookies: j.cookies,
      global: { fetch: async () => REFUSED() },
    });
    const before = verifierCookies(j.cookies.getAll());

    const out = await startGoogleLink(client as unknown as SupabaseClient, "https://tender.example");
    expect(out).toEqual({ error: { code: "manual_linking_disabled", message: "Manual linking is disabled" } });

    // The damage, asserted rather than assumed — if the library ever starts cleaning up, this
    // goes red and the restore below becomes unnecessary rather than silently pointless.
    expect(j.map.get(FIXED), "a refused start overwrote the reset link's verifier").not.toBe(PENDING_RESET);

    for (const { name, value } of restoreVerifiers(before, verifierCookies(j.cookies.getAll()))) {
      if (value === null) j.map.delete(name); else j.map.set(name, value);
    }
    expect(j.map.get(FIXED)).toBe(PENDING_RESET);
    expect([...j.map.keys()]).toEqual([FIXED]); // and the keys it added are gone too
  });

  it("a jar with no pending flow ends up empty, not carrying the failed start's leftovers", async () => {
    const j = jar({});
    const client = createServerClient("https://proj.supabase.co", "anon-key", {
      cookies: j.cookies,
      global: { fetch: async () => REFUSED() },
    });
    const before = verifierCookies(j.cookies.getAll());
    await startGoogleLink(client as unknown as SupabaseClient, "https://tender.example");
    expect(verifierCookies(j.cookies.getAll()).length, "positive control: the start did write").toBeGreaterThan(0);

    for (const { name, value } of restoreVerifiers(before, verifierCookies(j.cookies.getAll()))) {
      if (value === null) j.map.delete(name); else j.map.set(name, value);
    }
    expect(verifierCookies(j.cookies.getAll())).toEqual([]);
  });
});

/**
 * #173 AC 2 / AC 6. The exchange is the one Supabase call on the sign-in and sign-up paths, and
 * the nonce is what it must carry: with *Skip nonce checks* OFF, GoTrue hashes the raw value
 * given here and compares it with the token's claim, so a call that dropped it would be refused
 * on the live project — and a test that did not assert it would pass on that call.
 */
describe("exchangeGoogleIdToken — one call, with the nonce, and never a redirect (#173)", () => {
  const USER = { id: "u-1", email: "bob@example.org", user_metadata: {} };
  const SESSION = { data: { user: USER, session: { access_token: "x" } }, error: null };

  it("calls signInWithIdToken for google with the token AND the raw nonce, and nothing else", async () => {
    const { client, calls } = fakeClient({ signInWithIdToken: SESSION });
    const out = await exchangeGoogleIdToken(client, "eyJ.id.token", "raw-nonce");
    expect(calls.map((c) => c.method)).toEqual(["signInWithIdToken"]);
    expect(calls[0].args).toEqual({ provider: "google", token: "eyJ.id.token", nonce: "raw-nonce" });
    expect(out).toEqual({ user: USER });
  });

  it("passes GoTrue's refusal on with its code — a nonce mismatch is one of them", async () => {
    const { client } = fakeClient({
      signInWithIdToken: {
        data: { user: null, session: null },
        error: { code: "bad_oidc", message: "Passed nonce and nonce in id_token should either both exist or not.", status: 400 },
      },
    });
    expect(await exchangeGoogleIdToken(client, "t", "n")).toEqual({
      error: { code: "bad_oidc", message: "Passed nonce and nonce in id_token should either both exist or not." },
    });
  });

  it("a success carrying no user is an error, not a session", async () => {
    const { client } = fakeClient({ signInWithIdToken: { data: { user: null, session: null }, error: null } });
    expect(await exchangeGoogleIdToken(client, "t", "n")).toEqual({ error: { message: "no user on the exchanged session" } });
  });
});
