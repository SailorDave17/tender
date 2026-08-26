// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { JoinForm } from "./JoinForm";
import { PASSWORD_MIN, explainResetError } from "@/auth/password";

/**
 * Story #100 AC 5 and AC 6 — the Sign up arm's two boxes and the gate in front of `/api/join`.
 *
 * The claim worth the harness is the negative one: **a mismatched sign-up sends nothing**. It is
 * asserted on the whole recorded call list rather than on "no call to /api/join", so a request
 * that went somewhere else is a red test too — the claim is that nothing left the browser, not
 * that one named path was spared (cairn: satisfying-a-negative-claim-destroys-its-instrument).
 * The positive control lives in the same test, because a spy that cannot record a call cannot
 * fail the assertion above it.
 *
 * `minLength` being taken from `PASSWORD_MIN` rather than written out is NOT checkable here:
 * `minLength={8}` and `minLength={PASSWORD_MIN}` produce the same DOM. That difference exists
 * only in the source, which is `test/password-policy.test.ts`'s subject (AC 8).
 *
 * jsdom enforces `required` on a submit-button click — *measured*, an unfilled required field
 * makes the click a silent no-op and no `submit` event fires at all — so every required control
 * is filled before every submit, and the control arm below is what would catch it if one were
 * missed (the same trap the tender overlay records from #69).
 *
 * **What this harness CANNOT see, stated rather than implied.** `minLength` applies only to a
 * *dirty* value, and `fireEvent.change` does not set the dirty-value flag — *measured*,
 * `validity.tooShort` reads `false` here for a 3-character value where a real browser reads
 * `true`. So no test in this file can observe a browser constraint refusing a submit, and the
 * assertions below are about the ATTRIBUTES rather than the refusal. The refusal itself was
 * measured in a browser on 2026-08-26 (with `abc` typed: form invalid, submit event never
 * fired, Google button dead) and is why those attributes are absent. Do not read a green run
 * here as evidence that a constraint added later would be caught — it would not.
 */
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const GOOD = "correct-horse-battery";

/** Fill everything the sign-up form requires, then set the two password boxes. */
function fillSignUp(container: HTMLElement, password: string, confirm: string) {
  const q = within(container);
  fireEvent.change(q.getByLabelText("Your name"), { target: { value: "Ann Crew" } });
  fireEvent.change(q.getByLabelText("Invite code"), { target: { value: "rotate-me" } });
  const attested = q.getByLabelText("I am 18 or over") as HTMLInputElement;
  if (!attested.checked) fireEvent.click(attested);
  fireEvent.change(q.getByLabelText("Email"), { target: { value: "ann@example.com" } });
  fireEvent.change(q.getByLabelText("Password"), { target: { value: password } });
  fireEvent.change(q.getByLabelText("Confirm password"), { target: { value: confirm } });
}

function submitSignUp(container: HTMLElement) {
  fireEvent.click(within(container).getByRole("button", { name: "Create my account" }));
}

/** Records every request the form makes, whatever its path, and answers the way the route does. */
function recordFetch(answer: () => { ok: boolean; body: unknown }) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown) => {
      calls.push(String(input));
      const { ok, body } = answer();
      return { ok, json: async () => body } as unknown as Response;
    }),
  );
  return calls;
}

describe("AC 5 — the Sign up arm carries the shared two boxes", () => {
  it("renders a password and a confirm box, both new-password, neither browser-constrained", () => {
    const { container } = render(<JoinForm initialMode="signup" />);
    const q = within(container);

    const password = q.getByLabelText("Password") as HTMLInputElement;
    const confirm = q.getByLabelText("Confirm password") as HTMLInputElement;
    expect(password.name).toBe("password");
    expect(confirm.name).toBe("confirm");
    expect(password.autocomplete).toBe("new-password");
    expect(confirm.autocomplete).toBe("new-password");
    // NEITHER browser constraint may be present on this screen, and the second one is the
    // finding: *Continue with Google* submits this same form, `required` refuses an EMPTY
    // submission and `minLength` refuses a PARTLY TYPED one. The second is worse because it is
    // inert until the member touches the box, so it turns the Google button into a silent
    // no-op only for people who started a password and changed their mind.
    expect(password.required, "a required password box breaks the Google sign-up").toBe(false);
    expect(confirm.required, "a required confirm box breaks the Google sign-up").toBe(false);
    expect(
      password.hasAttribute("minlength"),
      "minLength on this screen disables Continue with Google once anything is typed",
    ).toBe(false);
    expect(confirm.hasAttribute("minlength")).toBe(false);

    // and the toggles came with them
    expect(q.getByRole("button", { name: "Show password" })).toBeInstanceOf(HTMLButtonElement);
    expect(q.getByRole("button", { name: "Show confirm password" })).toBeInstanceOf(HTMLButtonElement);
  });

  it("still lets Continue with Google submit with both boxes empty", async () => {
    const calls = recordFetch(() => ({ ok: false, body: { message: "no" } }));
    const { container } = render(<JoinForm initialMode="signup" />);
    const q = within(container);
    fireEvent.change(q.getByLabelText("Your name"), { target: { value: "Ann Crew" } });
    fireEvent.change(q.getByLabelText("Invite code"), { target: { value: "rotate-me" } });
    fireEvent.click(q.getByLabelText("I am 18 or over"));

    fireEvent.click(q.getByRole("button", { name: "Continue with Google" }));

    // The Google arm must reach its route without an email or a password; if either box became
    // `required`, jsdom (like a browser) would refuse the submit and this list would stay empty.
    await waitFor(() => expect(calls).toEqual(["/api/signup/google"]));
  });
});

describe("AC 6 — a mismatch is shown and nothing is posted", () => {
  it("posts nothing on a mismatch, and posts exactly once when the two agree", async () => {
    const calls = recordFetch(() => ({ ok: false, body: { message: "You already have an account here." } }));
    const { container } = render(<JoinForm initialMode="signup" />);
    const q = within(container);

    // Both are long enough, so the only thing wrong is that they differ — otherwise this would
    // pass on the weak-password branch and prove nothing about the confirm box.
    expect(GOOD.length).toBeGreaterThanOrEqual(PASSWORD_MIN);
    fillSignUp(container, GOOD, `${GOOD}x`);
    submitSignUp(container);

    expect(q.getByRole("alert").textContent).toBe(explainResetError("mismatch"));
    expect(calls, "a mismatched sign-up reached the network").toEqual([]);

    // The control, in the same test: make the two agree and the same submit must post exactly
    // once. Without it, `calls` staying empty is equally consistent with a form that never
    // submits at all — a broken selector, an unfilled required field, a spy that never installed.
    fireEvent.change(q.getByLabelText("Confirm password"), { target: { value: GOOD } });
    submitSignUp(container);
    await waitFor(() => expect(calls).toEqual(["/api/join"]));
  });

  it("sends the confirm box's value nowhere — the account is made with the password", async () => {
    // The confirm box is a typo guard, not a second credential: it must not reach the route, or
    // the server would be deciding something the client already decided.
    const bodies: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init: { body?: string }) => {
        bodies.push(JSON.parse(String(init?.body ?? "{}")));
        return { ok: false, json: async () => ({ message: "no" }) } as unknown as Response;
      }),
    );
    const { container } = render(<JoinForm initialMode="signup" />);
    fillSignUp(container, GOOD, GOOD);
    submitSignUp(container);

    await waitFor(() => expect(bodies).toHaveLength(1));
    const sent = bodies[0] as Record<string, unknown>;
    expect(sent.password).toBe(GOOD);
    expect(Object.keys(sent), "the confirm value was posted").not.toContain("confirm");
  });
});
