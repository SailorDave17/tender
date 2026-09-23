import { describe, expect, it } from "vitest";
import {
  PROTECTED_PREFIXES,
  SIGN_IN_PATH,
  SIGN_IN_URL,
  SIGNED_IN_HOME,
  WELCOME_PATH,
  isProtected,
  isSignInScreen,
  needsPersonRead,
  redirectFor,
  searchFor,
  standingFromRow,
  type Standing,
} from "./gate";

describe("where a signed-out visitor is sent, and what the gate still matches (#234)", () => {
  it("the sign-in screen's PATH stays a bare pathname, so the gate's exact match still fires", () => {
    // The trap #234 was filed around: this constant is compared against a request's pathname, which
    // never carries a query, so a `?` in it would make isSignInScreen() never match.
    expect(SIGN_IN_PATH).toBe("/join");
    expect(SIGN_IN_PATH).not.toContain("?");
    expect(isSignInScreen("/join")).toBe(true);
  });

  it("the URL a page redirects to names the Sign in tab", () => {
    expect(SIGN_IN_URL).toBe("/join?mode=signin");
  });

  it("the proxy adds the Sign in tab to a redirect to the sign-in screen, and to nothing else", () => {
    expect(searchFor(SIGN_IN_PATH)).toBe("?mode=signin");
    for (const other of [WELCOME_PATH, SIGNED_IN_HOME]) expect(searchFor(other), other).toBe("");
    // ...and the gate keeps deciding in pathnames: the signed-out answer is still the bare path,
    // which is what lets the cycle sweep below feed it back in unchanged.
    expect(redirectFor("/board", "signed-out")).toBe(SIGN_IN_PATH);
  });
});

describe("the proxy's decision (AC 1 / AC 5)", () => {
  it("sends an unauthenticated request for /board, and anything under it, to /join", () => {
    expect(redirectFor("/board", "signed-out")).toBe(SIGN_IN_PATH);
    expect(redirectFor("/board/2027-05-02", "signed-out")).toBe(SIGN_IN_PATH);
    expect(redirectFor("/admin", "signed-out")).toBe(SIGN_IN_PATH);
    expect(redirectFor("/profile", "signed-out")).toBe(SIGN_IN_PATH); // #18: the profile is behind sign-in
    expect(redirectFor("/profile/ann", "signed-out")).toBe(SIGN_IN_PATH);
    expect(redirectFor("/boats", "signed-out")).toBe(SIGN_IN_PATH); // #19
    expect(redirectFor("/post/new", "signed-out")).toBe(SIGN_IN_PATH);
    expect(redirectFor("/post/abc", "signed-out")).toBe(SIGN_IN_PATH);
  });

  it("lets a signed-in request through everywhere except the sign-in screen (#123 AC 7)", () => {
    expect(redirectFor("/board", "finished")).toBeNull();
    // ...and /join is the exception this story adds: a member with a live session was being shown
    // a sign-in form and asked to sign in again. (This case asserted `null` until #123.)
    expect(redirectFor("/join", "finished")).toBe(SIGNED_IN_HOME);
    expect(SIGNED_IN_HOME).toBe("/board");
  });

  it("leaves the open paths open — a person with no session must reach the page that gives one", () => {
    expect(redirectFor("/join", "signed-out")).toBeNull();
    expect(redirectFor("/auth/callback", "signed-out")).toBeNull();
    expect(redirectFor("/", "signed-out")).toBeNull();
    expect(redirectFor("/boardroom", "signed-out")).toBeNull(); // a prefix is not a path segment
  });

  it("leaves /support and /privacy open to a stranger — madcowsailing.com links there (#147)", () => {
    // Signed out is the case that matters: the product page's readers have never had an account,
    // and the person who needs /support most is the one who cannot sign in.
    for (const path of ["/support", "/privacy"]) {
      expect(redirectFor(path, "signed-out"), `${path} signed out`).toBeNull();
      expect(isProtected(path), `${path} is not gated`).toBe(false);
    }
  });

  it("isProtected matches segments, not prefixes", () => {
    expect(isProtected("/board")).toBe(true);
    expect(isProtected("/board/")).toBe(true);
    expect(isProtected("/boards")).toBe(false);
  });
});

describe("the signed-in arm sends a finished member off /join — and since #219 /welcome — and nowhere else (#123 AC 7)", () => {
  /**
   * The second half of the criterion, and the one worth a test of its own: the change adds a
   * redirect on the arm that until now always answered `null`, so the risk it carries is not
   * "does /join work" but "what else did this just start redirecting". A single `expect` on
   * `/join` cannot see that; a sweep can.
   */
  const EVERY_OTHER_PATH = [
    "/",
    "/forgot",
    "/auth/callback",
    "/api/signin/google",
    "/api/signup/google",
    "/auth/link/google",
    "/auth/signout",
    "/api/signin",
    "/api/join",
    "/manifest.webmanifest",
    "/support", // #147
    "/privacy",
    "/joining", // /join is a path, not a prefix — this one must be left alone
    "/join/extra",
    "/welcomes", // #219: /welcome is exact too
    "/welcome/extra",
    ...PROTECTED_PREFIXES,
  ];

  it("returns null for a signed-in member on every ungated path that is not /join or /welcome", () => {
    for (const path of EVERY_OTHER_PATH) {
      expect(redirectFor(path, "finished"), `${path} must not redirect a signed-in member`).toBeNull();
    }
    // The positive controls: a sweep over a list that missed the paths under test would pass
    // this silently (cairn: an-absent-result-reads-as-a-clean-one).
    expect(EVERY_OTHER_PATH).not.toContain(SIGN_IN_PATH);
    expect(EVERY_OTHER_PATH).not.toContain(WELCOME_PATH);
    expect(redirectFor(SIGN_IN_PATH, "finished")).toBe(SIGNED_IN_HOME);
    expect(redirectFor(WELCOME_PATH, "finished")).toBe(SIGNED_IN_HOME);
  });

  it("leaves the signed-OUT arm exactly as it was — /join still opens for a stranger", () => {
    // The whole point: a person with no session must still reach the page that gives them one.
    expect(redirectFor("/join", "signed-out")).toBeNull();
    expect(redirectFor("/board", "signed-out")).toBe(SIGN_IN_PATH);
  });

  it("does not send a signed-in member somewhere that would bounce them back", () => {
    // /board is protected, so the redirect target has to be a path a signed-in member may have —
    // otherwise this is a loop rather than a redirect.
    expect(isProtected(SIGNED_IN_HOME)).toBe(true);
    expect(redirectFor(SIGNED_IN_HOME, "finished")).toBeNull();
  });
});

describe("Finish your profile: the unfinished member's gate (#219 AC 2)", () => {
  /** The five the criterion names, as requests — /post/new rather than the bare prefix. */
  const AC_PATHS = ["/board", "/profile", "/boats", "/post/new", "/admin"];

  it("sends a signed-in member with profile_completed_at null to /welcome from every path the AC names", () => {
    for (const path of AC_PATHS) {
      expect(redirectFor(path, "unfinished"), path).toBe(WELCOME_PATH);
    }
    // ...and from anything under a protected prefix, which is where most of those pages live.
    expect(redirectFor("/post/00000000-0000-4000-8000-000000000001", "unfinished")).toBe(WELCOME_PATH);
    expect(redirectFor("/admin/dates", "unfinished")).toBe(WELCOME_PATH);
    // /join too: a signed-in member was sent to /board from there, which would now be two hops.
    expect(redirectFor(SIGN_IN_PATH, "unfinished")).toBe(WELCOME_PATH);
  });

  it("lets the unfinished member stay on /welcome — the one path that must answer null, or this is a loop", () => {
    expect(redirectFor(WELCOME_PATH, "unfinished")).toBeNull();
    expect(isProtected(WELCOME_PATH)).toBe(false);
  });

  it("sends a finished member from /welcome to /board", () => {
    expect(redirectFor(WELCOME_PATH, "finished")).toBe(SIGNED_IN_HOME);
  });

  it("leaves the open pages open to an unfinished member — /support and /privacy are not gated on a profile", () => {
    for (const path of ["/", "/support", "/privacy", "/forgot", "/auth/signout", "/api/join"]) {
      expect(redirectFor(path, "unfinished"), path).toBeNull();
    }
  });

  it("sends a signed-out request for /welcome to /join — it needs a session to finish anything", () => {
    expect(redirectFor(WELCOME_PATH, "signed-out")).toBe(SIGN_IN_PATH);
  });

  it("lets a session with no person row reach /join, so not-invited is shown rather than bounced (#219's known bounce)", () => {
    // /profile sends this population to /join?error=not-invited; the #123 arm used to send every
    // signed-in /join request on to /board, so the sentence never rendered.
    expect(redirectFor(SIGN_IN_PATH, "no-person")).toBeNull();
    for (const path of [...AC_PATHS, WELCOME_PATH, "/"]) {
      expect(redirectFor(path, "no-person"), path).toBeNull();
    }
  });
});

describe("no redirect cycle, for any standing (#219 AC 2)", () => {
  const STANDINGS: Standing[] = ["signed-out", "no-person", "unfinished", "finished"];
  const EVERY_PATH = [
    "/",
    SIGN_IN_PATH,
    WELCOME_PATH,
    "/support",
    "/privacy",
    "/forgot",
    "/post/new",
    "/admin/dates",
    ...PROTECTED_PREFIXES,
  ];

  /** Follow the gate from `path` until it lets the request through; throw if it revisits a path. */
  function settle(path: string, standing: Standing, gate = redirectFor): string[] {
    const seen = [path];
    let at = path;
    for (;;) {
      const next = gate(at, standing);
      if (next === null) return seen;
      if (seen.includes(next)) throw new Error(`${standing}: cycle ${[...seen, next].join(" → ")}`);
      seen.push(next);
      at = next;
    }
  }

  it("every path settles, in at most one redirect, and where it settles lets the request through", () => {
    for (const standing of STANDINGS) {
      for (const path of EVERY_PATH) {
        const hops = settle(path, standing);
        expect(hops.length, `${standing} ${hops.join(" → ")}`).toBeLessThanOrEqual(2);
        expect(redirectFor(hops[hops.length - 1], standing)).toBeNull();
      }
    }
  });

  it("where each standing lands from /board, which is where sign-in sends everyone", () => {
    expect(settle("/board", "signed-out")).toEqual(["/board", SIGN_IN_PATH]);
    expect(settle("/board", "unfinished")).toEqual(["/board", WELCOME_PATH]);
    expect(settle("/board", "finished")).toEqual(["/board"]);
    expect(settle(WELCOME_PATH, "finished")).toEqual([WELCOME_PATH, SIGNED_IN_HOME]);
  });

  it("the cycle detector itself fires — a gate answering /welcome on /welcome is caught, not looped", () => {
    // Positive control for the helper: without it, a `settle` that returned early would make the
    // sweep above pass whatever the gate did.
    const looping = (p: string) => (p === "/board" ? WELCOME_PATH : p === WELCOME_PATH ? "/board" : null);
    expect(() => settle("/board", "unfinished", looping)).toThrow(/cycle \/board → \/welcome → \/board/);
  });
});

describe("standingFromRow — what the proxy's read means (#219)", () => {
  it("null profile_completed_at is unfinished; a timestamp is finished; no row is no-person", () => {
    expect(standingFromRow({ profile_completed_at: null }, null)).toBe("unfinished");
    expect(standingFromRow({ profile_completed_at: "2026-09-22T12:00:00Z" }, null)).toBe("finished");
    expect(standingFromRow(null, null)).toBe("no-person");
  });

  it("a failed read is finished — the gate fails open, never sending everyone to /welcome", () => {
    expect(standingFromRow(null, { message: "refused" })).toBe("finished");
    expect(standingFromRow({ profile_completed_at: null }, { message: "refused" })).toBe("finished");
  });
});

describe("which requests the proxy reads the person row for (#219)", () => {
  it("reads it on the protected prefixes, /welcome and /join, and nowhere else", () => {
    for (const path of [...PROTECTED_PREFIXES, "/post/new", WELCOME_PATH, SIGN_IN_PATH]) {
      expect(needsPersonRead(path), path).toBe(true);
    }
    for (const path of ["/", "/support", "/privacy", "/forgot", "/auth/callback", "/api/join", "/welcomes"]) {
      expect(needsPersonRead(path), path).toBe(false);
    }
  });

  it("skipping the read is safe: where it is skipped, every signed-in standing answers alike", () => {
    // The proxy passes `finished` without reading wherever needsPersonRead is false. That is only
    // correct if the answer there would not have changed with the row — held here, path by path.
    for (const path of ["/", "/support", "/privacy", "/forgot", "/auth/callback", "/api/join", "/welcomes"]) {
      const answers = new Set((["no-person", "unfinished", "finished"] as const).map((s) => redirectFor(path, s)));
      expect(answers.size, path).toBe(1);
    }
  });
});
