import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
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
async function join(searchParams: Record<string, string> = {}): Promise<string> {
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
    const html = await join({ mode: "signup" });
    expect(html).toContain("Create my account");
    expect(html).not.toContain("Email me a link");
  });

  it("the sign-up tab really is what was rendered — the negative control", async () => {
    // Without this, "contains Create my account" is consistent with a page that renders both
    // tabs at once, and "does not contain Email me a link" is consistent with rendering neither.
    const signup = await join({ mode: "signup" });
    const signin = await join();
    expect(signup).toContain('data-form="signup"');
    expect(signup).not.toContain('data-form="signin"');
    expect(signin).toContain('data-form="signin"');
    expect(signin).not.toContain('data-form="signup"');
    // and the sign-in tab still carries its own way out for a forgotten password
    expect(signin).toContain('href="/forgot"');
  });
});

describe("neither screen promises an emailed way in (#99 AC 7)", () => {
  it("no sentence on /join, either tab, or on /forgot offers to email a sign-in link", async () => {
    for (const [name, html] of [
      ["/join (sign in)", await join()],
      ["/join (sign up)", await join({ mode: "signup" })],
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
