import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RECOGNITION_COOKIE, RECOGNITION_VALUE } from "@/auth/recognition";
import ForgotPage from "./forgot/page";
import JoinPage from "./join/page";

/**
 * #99 AC 7. The two screens a person meets before they have a session, asserted from the HTML
 * they actually produce rather than from the source that produces it — a button's label is what a
 * member reads, and a source assertion would pass on a label rendered by a branch nobody takes.
 *
 * `renderToStaticMarkup` is this repo's instrument for that (`src/app/page.test.tsx`, #83). It is
 * the initial render and nothing else: no effect runs and no event can be dispatched, which is
 * why the one part of this criterion that lives behind a submit — the client-side "enter your
 * email" message — is checked against the source below, and said to be checked that way.
 */
/**
 * Since #123 the page reads a cookie before it renders, so the fixture is a browser as well as a
 * URL. `next/headers` is replaced rather than stubbed per test: `cookies()` throws outside a
 * request, and the jar below is the one thing the page asks it for.
 */
let jar: Record<string, string> = {};
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (name in jar ? { name, value: jar[name] } : undefined),
  }),
}));

/**
 * `recognized` is the device this render happens in: `false` is a browser that has never signed
 * in here, which since #123 is what a first visit looks like. It is a required argument on
 * purpose — the default is the whole subject of this story, so a call that does not say which
 * browser it means is a call that will read as whichever default is current, silently, the next
 * time somebody changes one.
 */
async function join(
  searchParams: Record<string, string>,
  recognized: boolean,
): Promise<string> {
  jar = recognized ? { [RECOGNITION_COOKIE]: RECOGNITION_VALUE } : {};
  return renderToStaticMarkup(await JoinPage({ searchParams: Promise.resolve(searchParams) }));
}

function forgot(): string {
  return renderToStaticMarkup(ForgotPage());
}

/**
 * Every way this app has ever offered to email somebody a way IN, as opposed to a way to RESET —
 * and the distinction is the whole difficulty, because the reset this app still sends is also a
 * link that is also on its way. The control below is what found that: the first version of this
 * pattern refused the reset sentence, which would have made the criterion unsatisfiable by any
 * correct screen.
 */
const PROMISES_A_LINK =
  /magic link|sign-?in link|email me a link|emailed link|we emailed you|open the link|(?<!reset )link is on its way/i;

describe("the Forgot screen keeps one arm and it is the reset (#99 AC 7)", () => {
  it("offers exactly one button, and it says Reset my password", () => {
    const html = forgot();
    const buttons = html.match(/<button[^>]*>([\s\S]*?)<\/button>/g) ?? [];
    expect(buttons).toHaveLength(1);
    expect(buttons[0]).toContain("Reset my password");
    // the one that went: it was a magic link, and #99 removed the mechanism
    expect(html).not.toContain("Email me a sign-in link");
  });

  it("says that resetting sets a first password for anyone who has none", () => {
    const html = forgot();
    expect(html).toMatch(/never had one|no password|first/i);
    expect(html).toMatch(/set (a )?new password|set your first/i);
  });
});

describe("the Sign up tab finishes here, not in an inbox (#99 AC 7)", () => {
  it("the finish button reads Create my account", async () => {
    const html = await join({ mode: "signup" }, false);
    expect(html).toContain("Create my account");
    expect(html).not.toContain("Email me a link");
  });

  it("the sign-up tab really is what was rendered — the negative control", async () => {
    // Without this, "contains Create my account" is consistent with a page that renders both
    // tabs at once, and "does not contain Email me a link" is consistent with rendering neither.
    //
    // #123 AC 8: the sign-in half was `await join()` with no arguments, because Sign in was the
    // default for everybody. It is not any more, so this REACHES the sign-in tab the way a
    // returning member does — with the recognition cookie — rather than being deleted. The claim
    // here was never about the default: it is that the two tabs are distinct, and that is the only
    // assertion in the file that would notice a page rendering both at once.
    const signup = await join({ mode: "signup" }, false);
    const signin = await join({}, true);
    expect(signup).toContain('data-form="signup"');
    expect(signup).not.toContain('data-form="signin"');
    expect(signin).toContain('data-form="signin"');
    expect(signin).not.toContain('data-form="signup"');
    // and the sign-in tab still carries its own way out for a forgotten password
    expect(signin).toContain('href="/forgot"');
  });
});

/**
 * #123 AC 1–3. Which tab /join opens on, read off the HTML the server produced — which is the
 * criterion, not a proxy for it: a test that asserted `initialMode`'s return value would pass on a
 * page that computed the right mode and handed the component the wrong one, and a test that drove
 * a browser would pass on a page that painted Sign in and flipped after hydration. The absence of
 * `data-form="signin"` from the first byte of HTML is what proves there is no flip to watch.
 */
describe("/join opens on the tab the device has earned (#123 AC 1-3)", () => {
  it("a browser that has never signed in here opens on Sign up", async () => {
    const html = await join({}, false);
    expect(html).toContain('data-form="signup"');
    expect(html).not.toContain('data-form="signin"');
  });

  it("a browser carrying the cookie opens on Sign in, as it did for everybody before", async () => {
    const html = await join({}, true);
    expect(html).toContain('data-form="signin"');
    expect(html).not.toContain('data-form="signup"');
  });

  it("?mode= beats the cookie in both directions, so the deep link keeps working", async () => {
    // The invited member who was SENT /join?mode=signup, on a device that has signed in before.
    const deepLinked = await join({ mode: "signup" }, true);
    expect(deepLinked).toContain('data-form="signup"');
    expect(deepLinked).not.toContain('data-form="signin"');
    // ...and the other direction, which is new: an unrecognised browser asked for Sign in.
    const askedForSignin = await join({ mode: "signin" }, false);
    expect(askedForSignin).toContain('data-form="signin"');
    expect(askedForSignin).not.toContain('data-form="signup"');
  });

  it("the cookie is what decides it — the same URL renders both tabs", async () => {
    // The control on the two assertions above: if the page ignored the cookie entirely, one of
    // them would still pass, and `not.toContain` on a page rendering neither tab would pass both.
    const [stranger, member] = [await join({}, false), await join({}, true)];
    expect(stranger).not.toBe(member);
    expect(stranger).toContain('data-form="signup"');
    expect(member).toContain('data-form="signin"');
  });

  it("still shows the tab controls, so a first-timer who does have an account can get out", async () => {
    // Opening on Sign up must not strand a member whose browser forgot: both tabs are on screen.
    const html = await join({}, false);
    expect(html).toContain('data-mode="signin"');
    expect(html).toContain('data-mode="signup"');
  });
});

/**
 * #173. The Google option on both tabs is Google Identity Services' button, rendered into a slot
 * the page marks `data-google`, and the page passes the client id from its own environment — so
 * with the variable set both tabs carry the slot, and with it unset neither does and nothing on
 * the page points at the old redirect route. Read off the HTML, as the tabs above are.
 */
describe("Continue with Google is the ID-token slot, on both tabs, only with a client id (#173)", () => {
  const CLIENT_ID = "727868912920-test.apps.googleusercontent.com";

  async function withClientId<T>(value: string | undefined, body: () => Promise<T>): Promise<T> {
    const was = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    if (value === undefined) delete process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
    else process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID = value;
    try {
      return await body();
    } finally {
      if (was === undefined) delete process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID;
      else process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID = was;
    }
  }

  it("with the client id, each tab carries its own slot and neither links to /auth/google", async () => {
    await withClientId(CLIENT_ID, async () => {
      const signin = await join({}, true);
      const signup = await join({ mode: "signup" }, false);
      expect(signin).toContain('data-google="signin"');
      expect(signin).not.toContain('data-google="signup"');
      expect(signup).toContain('data-google="signup"');
      expect(signup).not.toContain('data-google="signin"');
      for (const html of [signin, signup]) {
        expect(html).not.toContain('href="/auth/google"');
        expect(html).not.toContain("supabase.co");
        // The old sign-up arm was a submit button; the slot is not one, so the form's only submit
        // on that tab is the password one and Google cannot be reached by pressing Enter.
        expect(html).not.toMatch(/<button[^>]*value="google"/);
      }
    });
  });

  it("without the client id there is no Google option at all — the degrade, and no dead link", async () => {
    await withClientId(undefined, async () => {
      for (const html of [await join({}, true), await join({ mode: "signup" }, false)]) {
        expect(html).not.toContain("data-google");
        // ...and no sentence promising it: the intro's ", or with Google" goes with the button
        expect(html).not.toMatch(/with Google|use Google/);
      }
      // the control: with the id, the intro does promise it
      await withClientId(CLIENT_ID, async () => expect(await join({}, true)).toMatch(/, or with Google/));
    });
  });
});

describe("neither screen promises an emailed way in (#99 AC 7)", () => {
  it("no sentence on /join, either tab, or on /forgot offers to email a sign-in link", async () => {
    for (const [name, html] of [
      ["/join (sign in)", await join({}, true)],
      ["/join (sign up)", await join({ mode: "signup" }, false)],
      ["/forgot", forgot()],
    ] as const) {
      expect(html, `${name} promises an emailed way in`).not.toMatch(PROMISES_A_LINK);
    }
  });

  it("the pattern would catch one — the control for the three assertions above", () => {
    // A regex that matched nothing would pass all three silently.
    expect("Email me a sign-in link").toMatch(PROMISES_A_LINK);
    expect("If that address can sign in, a link is on its way.").toMatch(PROMISES_A_LINK);
    // ...while the reset the app still sends is not one of them
    expect("If that address has an account here, a password reset link is on its way. Check your inbox.")
      .not.toMatch(PROMISES_A_LINK);
  });
});

/**
 * The half no rendered HTML can reach: the message only exists after a submit, and THIS file
 * cannot dispatch one — it renders with `renderToStaticMarkup`, which runs no effect and
 * fires no event. The source is the only subject here, and it is a weaker instrument — recorded
 * as such rather than presented as equivalent.
 *
 * (This paragraph said *this repo* has no way to dispatch a submit, which was true when #99
 * wrote it and stopped being true on #100: `src/auth/PasswordFields.test.tsx` and
 * `src/app/join/JoinForm.test.tsx` opt into a jsdom environment per file and do dispatch
 * events. The instrument choice here is unchanged and still right for what it asserts — the
 * absence of a sentence from a source file — but the reason given for it was a claim about the
 * whole repo, and that claim expired.)
 */
describe("the client-side sentence about being sent a link is gone (#99 AC 7, source)", () => {
  it("JoinForm no longer offers to send anything", async () => {
    const src = await readFile(new URL("./join/JoinForm.tsx", import.meta.url), "utf8");
    expect(src).not.toContain("to be sent a link");
    expect(src).not.toMatch(PROMISES_A_LINK);
  });
});
