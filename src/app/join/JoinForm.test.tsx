// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, waitFor, within } from "@testing-library/react";
import { JoinForm } from "./JoinForm";
import { WRONG_CODE } from "@/auth/join";
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

/**
 * #173: *Continue with Google* is Google Identity Services' own iframe, which jsdom cannot render
 * and no test should drive. The stand-in is a plain button that hands the form a fixed token and
 * nonce the way GIS's callback would — so what these tests exercise is everything on OUR side of
 * that callback: which route is posted to, with what, and what the two password boxes may not do
 * to it. The real component's own contract (the nonce it generates, the hash it hands GIS) is
 * `src/auth/GoogleButton.test.ts`.
 */
vi.mock("@/auth/GoogleButton", () => ({
  GoogleButton: ({ flow, onCredential }: { flow: string; onCredential: (c: string, n: string) => void }) => (
    <button type="button" data-google={flow} onClick={() => onCredential("fake-id-token", "fake-raw-nonce")}>
      Continue with Google
    </button>
  ),
}));

const CLIENT_ID = "727868912920-test.apps.googleusercontent.com";

const GOOD = "correct-horse-battery";

/**
 * Fill everything the sign-up form requires, then set the two password boxes. Since #220 the
 * invite code is the form's only required control — there is no name box and no 18+ checkbox.
 */
function fillSignUp(container: HTMLElement, password: string, confirm: string) {
  const q = within(container);
  fireEvent.change(q.getByLabelText("Invite code"), { target: { value: "rotate-me" } });
  fireEvent.change(q.getByLabelText("Email"), { target: { value: "ann@example.com" } });
  fireEvent.change(q.getByLabelText("Password"), { target: { value: password } });
  fireEvent.change(q.getByLabelText("Confirm password"), { target: { value: confirm } });
}

function submitSignUp(container: HTMLElement) {
  fireEvent.click(within(container).getByRole("button", { name: "Create my account" }));
}

/** Records every request the form makes, whatever its path, and answers the way the route does. */
function recordFetch(answer: () => { ok: boolean; body: unknown }, bodies: unknown[] = []) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: unknown, init?: { body?: string }) => {
      calls.push(String(input));
      if (init?.body) bodies.push(JSON.parse(init.body));
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

  it("still lets Continue with Google go through with both boxes empty, carrying the token and the nonce", async () => {
    const bodies: unknown[] = [];
    const calls = recordFetch(() => ({ ok: false, body: { message: "no" } }), bodies);
    const { container } = render(<JoinForm initialMode="signup" googleClientId={CLIENT_ID} />);
    const q = within(container);
    fireEvent.change(q.getByLabelText("Invite code"), { target: { value: "rotate-me" } });

    fireEvent.click(q.getByRole("button", { name: "Continue with Google" }));

    // The Google arm must reach its route without an email or a password; since #173 it checks
    // the form's constraints itself with `reportValidity`, so a `required` on either box would
    // make that call refuse and this list would stay empty. Since #220 it posts no name, and
    // `attested` is `true` by construction — creating the account is the confirmation.
    await waitFor(() => expect(calls).toEqual(["/api/signup/google"]));
    expect(bodies).toEqual([{ code: "rotate-me", attested: true, credential: "fake-id-token", nonce: "fake-raw-nonce" }]);
  });

  it("posts nothing to the Google route while the invite code is missing (#173 AC 3, narrowed by #220)", async () => {
    const calls = recordFetch(() => ({ ok: false, body: { message: "no" } }));
    const { container } = render(<JoinForm initialMode="signup" googleClientId={CLIENT_ID} />);
    const q = within(container);
    // the code left empty — the only thing this form can now refuse on
    fireEvent.click(q.getByRole("button", { name: "Continue with Google" }));
    await waitFor(() => expect(q.getByRole("alert").textContent).toMatch(/invite code/));
    expect(calls).toEqual([]);
  });

  it("the Sign in tab's Google button posts the token and nonce to the sign-in route", async () => {
    const bodies: unknown[] = [];
    const calls = recordFetch(() => ({ ok: false, body: { message: "no" } }), bodies);
    const { container } = render(<JoinForm initialMode="signin" googleClientId={CLIENT_ID} />);
    fireEvent.click(within(container).getByRole("button", { name: "Continue with Google" }));
    await waitFor(() => expect(calls).toEqual(["/api/signin/google"]));
    expect(bodies).toEqual([{ credential: "fake-id-token", nonce: "fake-raw-nonce" }]);
  });

  it("with no client id there is no Google option on either tab — the degrade, not an error", () => {
    for (const mode of ["signin", "signup"] as const) {
      const { container, unmount } = render(<JoinForm initialMode={mode} />);
      expect(within(container).queryByRole("button", { name: "Continue with Google" })).toBeNull();
      expect(container.querySelector("[data-google]")).toBeNull();
      unmount();
    }
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
    // #220: the whole payload — the code, the confirmation this submit is, and the account. No
    // name (it is /welcome's now) and no checkbox value: `attested` is posted as `true`.
    expect(sent).toEqual({ code: "rotate-me", attested: true, email: "ann@example.com", password: GOOD });
  });
});

/**
 * #220 AC 1 — the sign-up screen is the invite code first, then the account, with the 18+
 * confirmation as a sentence beside the two ways of creating one. Read off the rendered DOM, which
 * is the order a screen reader and a phone both follow. Whether the panel is visually dominant at
 * 360px is the owner's phone review (AC 7); jsdom applies no stylesheet and cannot see it.
 */
describe("#218 AC 1 — a member who landed on Sign up can see the way to Sign in before any field", () => {
  it("the control comes before the first input, and activating it shows Sign in with no invite-code field", () => {
    const { container } = render(<JoinForm initialMode="signup" googleClientId={CLIENT_ID} />);
    const form = container.querySelector<HTMLFormElement>('form[data-form="signup"]');
    if (!form) throw new Error("no sign-up form rendered");
    const control = within(form).getByRole("button", { name: "Already a member? Sign in" });
    const firstInput = form.querySelector("input");
    // Before the first input in DOM order: the control precedes it.
    expect(firstInput).not.toBeNull();
    expect(control.compareDocumentPosition(firstInput!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // It is a button that cannot submit the form it sits in.
    expect(control.getAttribute("type")).toBe("button");

    fireEvent.click(control);

    const signIn = container.querySelector<HTMLFormElement>('form[data-form="signin"]');
    expect(signIn, "the Sign in form is shown").not.toBeNull();
    expect(container.querySelector('form[data-form="signup"]'), "and the Sign up form is gone").toBeNull();
    // No name and no invite code on the way in: the member's email and password are all it asks.
    expect([...signIn!.querySelectorAll("input")].map((i) => i.name)).toEqual(["email", "password"]);
    expect(within(signIn!).queryByLabelText(/invite code/i)).toBeNull();
    // The tab strip agrees with what is shown.
    expect(container.querySelector('[role="tab"][data-mode="signin"]')?.getAttribute("aria-selected")).toBe("true");
    // The control removed itself, so focus is handed to the email field rather than dropped.
    expect(document.activeElement).toBe(signIn!.querySelector('input[name="email"]'));
  });

  it("the Sign in tab carries no such control — it is the way out of Sign up only", () => {
    const { container } = render(<JoinForm initialMode="signin" googleClientId={CLIENT_ID} />);
    expect(container.querySelector("[data-already-member]")).toBeNull();
  });
});

describe("#220 AC 1 — the sign-up tab is the invite code, then the account", () => {
  function signUpForm(googleClientId = CLIENT_ID) {
    const { container } = render(<JoinForm initialMode="signup" googleClientId={googleClientId} />);
    const form = container.querySelector<HTMLFormElement>('form[data-form="signup"]');
    if (!form) throw new Error("no sign-up form rendered");
    return { container, form, q: within(form) };
  }

  it("the invite code is the first input, in a region labelled by the heading, and there is no name box and no checkbox", () => {
    const { form, q } = signUpForm();
    const inputs = [...form.querySelectorAll("input")];
    expect(inputs[0]?.name, "the first input in DOM order").toBe("code");
    // The whole set: an added box anywhere on this form reddens this line.
    expect(inputs.map((i) => i.name)).toEqual(["code", "email", "password", "confirm"]);
    expect(inputs.some((i) => i.type === "checkbox")).toBe(false);
    expect(form.querySelector('input[name="displayName"]')).toBeNull();

    // A labelled region — `role="group"` with `aria-labelledby`, or a fieldset with a legend —
    // whose label is the heading text the issue names. Either form is accepted, so this test does
    // not pin an element the design may change; what it pins is that the label text reaches it.
    const region = inputs[0].closest<HTMLElement>('[role="group"], fieldset');
    expect(region, "the code input sits in a labelled region").not.toBeNull();
    const labelledBy = region!.getAttribute("aria-labelledby");
    const heading = labelledBy ? form.querySelector(`#${labelledBy}`) : region!.querySelector("legend");
    expect(heading?.textContent).toBe("Your invite code");
    // ...and the input itself has an explicit label, over and above the region's.
    expect(q.getByLabelText("Invite code")).toBe(inputs[0]);
    expect(inputs[0].required).toBe(true);
  });

  it("the code box asks a phone keyboard for capitals, since every code is minted in capitals (#243)", () => {
    const { form } = signUpForm();
    expect(form.querySelector('input[name="code"]')?.getAttribute("autocapitalize")).toBe("characters");
  });

  it("the 18+ statement is rendered beside both Create my account and the Google button", () => {
    const { form, q } = signUpForm();
    const attest = form.querySelector<HTMLElement>("[data-attest]");
    expect(attest?.textContent).toBe("By creating an account you confirm you're 18 or over.");
    const create = q.getByRole("button", { name: "Create my account" });
    const google = q.getByRole("button", { name: "Continue with Google" });
    // Beside: the same parent as both buttons, and before both in DOM order, so it is read before
    // either is used. (The Google stand-in renders a bare button where GIS renders its slot; both
    // are direct children of the fieldset.)
    expect(attest!.parentElement).toBe(create.parentElement);
    expect(attest!.parentElement).toBe(google.parentElement);
    expect(attest!.compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(attest!.compareDocumentPosition(google) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // and the old checkbox label is gone with the box
    expect(q.queryByLabelText("I am 18 or over")).toBeNull();
  });

  it("without a Google client id the statement still stands beside the one button there is", () => {
    const { form, q } = signUpForm("");
    const attest = form.querySelector<HTMLElement>("[data-attest]");
    expect(attest).not.toBeNull();
    expect(attest!.parentElement).toBe(q.getByRole("button", { name: "Create my account" }).parentElement);
    expect(q.queryByRole("button", { name: "Continue with Google" })).toBeNull();
  });

  it("the Google hint that there was nothing else to fill in is gone — it would be misleading now", () => {
    const { form } = signUpForm();
    expect(form.textContent).not.toMatch(/nothing else to fill in/);
    // the panel says where the code comes from, in the region itself
    expect(form.querySelector('[data-invite] [data-hint]')?.textContent).toMatch(/invite email/);
  });
});

/**
 * #226 — the invite link's code, from the form's side. The page's half (the code in the first
 * byte of HTML, the tab on a recognised device) is `src/app/sign-in-screens.test.tsx`; this is
 * what happens once the member acts: the pre-filled code is what gets posted with nothing typed,
 * a code typed over it wins, and a refusal is the route's own sentence. Whether the route refuses
 * a rotated code, and creates nothing when it does, is `src/auth/join.test.ts`'s and the smoke's.
 */
describe("#226 — the code the invite link carried", () => {
  /** Everything but the code: the member's email and matching passwords, nothing typed in the panel. */
  function fillAccount(container: HTMLElement) {
    const q = within(container);
    fireEvent.change(q.getByLabelText("Email"), { target: { value: "ann@example.com" } });
    fireEvent.change(q.getByLabelText("Password"), { target: { value: GOOD } });
    fireEvent.change(q.getByLabelText("Confirm password"), { target: { value: GOOD } });
  }

  it("posts the link's code to /api/join with no code typed (AC 3)", async () => {
    const bodies: unknown[] = [];
    const calls = recordFetch(() => ({ ok: false, body: { message: "no" } }), bodies);
    const { container } = render(<JoinForm initialMode="signup" linkCode="SPINNAKER" />);
    expect((within(container).getByLabelText("Invite code") as HTMLInputElement).value).toBe("SPINNAKER");
    fillAccount(container);
    submitSignUp(container);
    await waitFor(() => expect(calls).toEqual(["/api/join"]));
    expect(bodies).toEqual([{ code: "SPINNAKER", attested: true, email: "ann@example.com", password: GOOD }]);
  });

  it("the Google arm posts the link's code too, with nothing typed", async () => {
    const bodies: unknown[] = [];
    const calls = recordFetch(() => ({ ok: false, body: { message: "no" } }), bodies);
    const { container } = render(<JoinForm initialMode="signup" linkCode="SPINNAKER" googleClientId={CLIENT_ID} />);
    fireEvent.click(within(container).getByRole("button", { name: "Continue with Google" }));
    await waitFor(() => expect(calls).toEqual(["/api/signup/google"]));
    expect((bodies[0] as Record<string, unknown>).code).toBe("SPINNAKER");
  });

  it("stays editable: a code typed over the link's is the one posted (AC 2)", async () => {
    const bodies: unknown[] = [];
    recordFetch(() => ({ ok: false, body: { message: "no" } }), bodies);
    const { container } = render(<JoinForm initialMode="signup" linkCode="LASTYEAR" />);
    const input = within(container).getByLabelText("Invite code") as HTMLInputElement;
    expect(input.readOnly).toBe(false);
    expect(input.disabled).toBe(false);
    fireEvent.change(input, { target: { value: "THISYEAR" } });
    fillAccount(container);
    submitSignUp(container);
    await waitFor(() => expect(bodies).toHaveLength(1));
    expect((bodies[0] as Record<string, unknown>).code).toBe("THISYEAR");
  });

  it("a rotated code in the link gets the route's 403 sentence, and the member stays on the form (AC 4)", async () => {
    // The route's answer, verbatim: WRONG_CODE is what both gates return for a code that is not
    // this season's, so the sentence here is the one a member with an old link reads.
    recordFetch(() => ({ ok: false, body: WRONG_CODE.body }));
    const { container } = render(<JoinForm initialMode="signup" linkCode="LASTYEAR" />);
    fillAccount(container);
    submitSignUp(container);
    await waitFor(() => expect(within(container).getByRole("alert").textContent).toBe(WRONG_CODE.body.message));
    // Still on the form, with the old code in the box to be replaced.
    const input = container.querySelector<HTMLInputElement>('form[data-form="signup"] input[name="code"]');
    expect(input?.value).toBe("LASTYEAR");
  });
});
