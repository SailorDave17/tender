import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { restoreVerifiers, verifierCookies } from "@/auth/link";
import { startGoogle, startGoogleLink } from "./google";

/**
 * #74. The whole story is which Supabase call is made: `signInWithOAuth` authenticates a browser
 * and, when the Google address does not match the member's, mints a SECOND auth user;
 * `linkIdentity` attaches the identity to the session's existing user. Both hand back a URL to
 * redirect to, so the OUTCOME is identical and only the mechanism differs — which is why these
 * tests assert on which method was called, and record that the other was not.
 */

type Call = { method: string; args: unknown };

function fakeClient(answers: Record<string, unknown>): { client: SupabaseClient; calls: Call[] } {
  const calls: Call[] = [];
  const auth = {
    signInWithOAuth: async (args: unknown) => {
      calls.push({ method: "signInWithOAuth", args });
      return answers.signInWithOAuth ?? { data: { url: null }, error: null };
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
  it("calls linkIdentity and never signInWithOAuth", async () => {
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

describe("startGoogle — the sign-in path is untouched by #74 (negative control)", () => {
  it("still calls signInWithOAuth and never linkIdentity", async () => {
    const { client, calls } = fakeClient({ signInWithOAuth: OK });
    const out = await startGoogle(client, "https://tender.example");
    expect(calls.map((c) => c.method)).toEqual(["signInWithOAuth"]);
    expect(out).toEqual({ url: OK.data.url });
  });

  it("carries no flow marker, so its callback returns to /join as before", async () => {
    const { client, calls } = fakeClient({ signInWithOAuth: OK });
    await startGoogle(client, "https://tender.example");
    const redirectTo = (calls[0].args as { options: { redirectTo: string } }).options.redirectTo;
    expect(new URL(redirectTo).searchParams.get("flow")).toBeNull();
    expect(new URL(redirectTo).searchParams.get("next")).toBe("/board");
  });
});
