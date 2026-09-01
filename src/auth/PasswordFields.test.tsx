// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { cleanup, fireEvent, render, within } from "@testing-library/react";
import { PasswordFields } from "./PasswordFields";
import { PASSWORD_MIN } from "./password";

/**
 * Story #100 AC 1–4 and AC 9. The first interactive tests in this repo: every other `.test.tsx`
 * here renders with `renderToStaticMarkup`, which runs no effect and can dispatch no event, and
 * `src/install/InstallBanner.test.tsx` says in band why that matters. The two claims this file
 * exists for — that a toggle flips ONE box, and that pressing it does not submit the form it sits
 * in — are claims about what happens after a click, so no static render can reach them.
 *
 * **The environment is per file, not per config.** Line 1 declares it, and there is
 * deliberately no `environmentMatchGlobs` in `vitest.config.ts`: `test/harness-budget.test.ts`
 * asserts that file's shape as part of #78 — both the absence of pool keys and, in the source
 * scan, that nothing there is mistaken for a comment. Another `/**` + `/` glob in that file is
 * exactly what #78 measured defeating its own comment stripper.
 *
 * Line 1 is also the ONLY declaration here, and that is load-bearing rather than tidy: vitest
 * matches that directive **anywhere in a file, comments included**, so the sentence above used
 * to quote it in full and thereby declared the environment a second time. *Measured*, three
 * arms: with the quote present, deleting line 1 reddened **0 of 8**; with both gone, 8 of 8;
 * with line 1 back and the quote neutralised, 8 pass. The last test in this file holds the
 * count at one so the executable line cannot go quietly dead again.
 *
 * The whole file rests on the DOM being real, and a run without one must FAIL rather than pass,
 * so the first test is the control for every assertion below it (AC 9).
 *
 * `cleanup` is called by hand: this repo runs vitest with `globals: false` (every test imports
 * `describe`/`it`/`expect`), so Testing Library's automatic `afterEach` never registers and
 * mounted trees would otherwise stack up across tests in one file.
 */
afterEach(cleanup);

/** Where the scan below starts: every interactive test file lives somewhere under src/. */
const SRC = join(process.cwd(), "src");

const props = {
  passwordName: "password",
  confirmName: "confirm",
  minLength: PASSWORD_MIN,
} as const;

describe("AC 9 — the harness is a real DOM, or nothing below means anything", () => {
  it("has a document, a window and jsdom behind them", () => {
    // Without this the file's failure mode on a lost line 1 would be a pile of
    // errors nobody reads as "the harness went away". With it, one named test says so.
    expect(typeof document, "no document: the jsdom environment is not active").toBe("object");
    expect(document.createElement("input")).toBeInstanceOf(HTMLInputElement);
    expect(window.navigator.userAgent).toMatch(/jsdom/i);
    // …and a real DOM is one that a click actually travels through, which is the property every
    // toggle assertion below depends on and which a stub `document` could fake the shape of.
    const seen: string[] = [];
    const button = document.createElement("button");
    button.addEventListener("click", () => seen.push("clicked"));
    button.click();
    expect(seen).toEqual(["clicked"]);
  });

  it("declares that environment exactly once — a quoted directive is still a directive", async () => {
    // Both needles are built from fragments rather than written out, because a test that
    // spelled the directive would declare the environment itself — which is the very defect
    // it exists to catch, and is how that defect got in (cairn:
    // satisfying-a-negative-claim-destroys-its-instrument-2026-08-26, "build the needle").
    const declarations = (text: string) =>
      text.match(new RegExp("@" + "vitest-environment\\s+[\\w-]+", "g")) ?? [];

    // The corpus is EVERY interactive file, DERIVED rather than listed. Reading only
    // `import.meta.url` left the sibling unguarded while the ADR and the README state the rule
    // for both; a hand-written list then fixes that for exactly the two files someone
    // remembered, and ADR 008's kill condition explicitly anticipates a third. A list must be
    // edited before a new interactive file can be covered, which makes that edit
    // indistinguishable from suppressing a real failure (cairn: prove-tests, Phase 6).
    //
    // The three source scanners in `test/` cannot be reused: every one filters `.test.` files
    // OUT, so their corpus would contain neither subject and this would pass on an empty set.
    const interactive: string[] = [];
    const walk = async (dir: string): Promise<void> => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) await walk(full);
        else if (entry.name.endsWith(".test.tsx")) {
          const text = await readFile(full, "utf8");
          if (declarations(text).length > 0) interactive.push(relative(SRC, full).replace(/\\/g, "/"));
        }
      }
    };
    await walk(SRC);

    // The scan found something, and specifically found THIS file — a walk that silently
    // resolved nothing would report "every interactive file declares it once" over an empty
    // set and pass forever.
    expect(interactive.length, "the scan found no interactive test files at all").toBeGreaterThan(1);
    expect(interactive).toContain("auth/PasswordFields.test.tsx");

    for (const rel of interactive) {
      const source = await readFile(join(SRC, rel), "utf8");
      expect(
        declarations(source),
        `${rel}: a second declaration means deleting line 1 reddens nothing, and the harness can die unnoticed`,
      ).toHaveLength(1);
    }

    // Positive control: the needle can find one. Without it, a regex that matched nothing
    // would report zero declarations and fail for the opposite reason, or — worse — report
    // one-and-only-one on a file that had none at all.
    expect(declarations("// " + "@vitest-" + "environment jsdom")).toHaveLength(1);
    expect(declarations("nothing to see here")).toHaveLength(0);
  });
});

describe("AC 1 — two labelled boxes, and two instances cannot collide", () => {
  it("renders the two inputs with the names, autocomplete and minLength it was handed", () => {
    const { container } = render(<PasswordFields {...props} />);
    const q = within(container);
    const password = q.getByLabelText("Password") as HTMLInputElement;
    const confirm = q.getByLabelText("Confirm password") as HTMLInputElement;

    expect(password.name).toBe("password");
    expect(confirm.name).toBe("confirm");
    // `new-password` on BOTH: a manager that offers a saved credential into the confirm box is
    // how a member confirms a password they did not just choose.
    expect(password.autocomplete).toBe("new-password");
    expect(confirm.autocomplete).toBe("new-password");
    expect(password.minLength).toBe(PASSWORD_MIN);
    expect(confirm.minLength).toBe(PASSWORD_MIN);
    // the two labels really are two different elements, not one matched twice
    expect(password).not.toBe(confirm);
  });

  it("puts required on both boxes when asked, and omits both constraints when not", () => {
    // /reset-password passes `required`; /join passes neither it nor `minLength`, because the
    // Google button shares that form. Both props therefore need exercising at BOTH values: an
    // assertion only ever taken at the default cannot tell a wired prop from a dead one.
    const { container: on } = render(
      <PasswordFields {...props} required />,
    );
    const strict = within(on);
    expect((strict.getByLabelText("Password") as HTMLInputElement).required).toBe(true);
    expect((strict.getByLabelText("Confirm password") as HTMLInputElement).required).toBe(true);
    cleanup();

    const { container: off } = render(
      <PasswordFields passwordName="password" confirmName="confirm" />,
    );
    const loose = within(off);
    const pw = loose.getByLabelText("Password") as HTMLInputElement;
    const cf = loose.getByLabelText("Confirm password") as HTMLInputElement;
    expect(pw.required).toBe(false);
    expect(cf.required).toBe(false);
    // …and with no `minLength` prop, no constraint reaches the DOM at all. React renders
    // `minLength={undefined}` as an absent attribute, which is the behaviour /join depends on.
    expect(pw.hasAttribute("minlength")).toBe(false);
    expect(cf.hasAttribute("minlength")).toBe(false);
  });

  it("renders the error sentence it is handed, and nothing when handed none", () => {
    const { container: quiet } = render(<PasswordFields {...props} />);
    expect(within(quiet).queryByRole("alert")).toBeNull();
    cleanup();

    const { container } = render(<PasswordFields {...props} error="Those two passwords do not match." />);
    expect(within(container).getByRole("alert").textContent).toBe("Those two passwords do not match.");
  });

  it("gives two instances in one tree four distinct ids and four distinct aria-controls", () => {
    const { container } = render(
      <>
        <PasswordFields {...props} />
        <PasswordFields passwordName="other" confirmName="otherConfirm" minLength={PASSWORD_MIN} />
      </>,
    );

    const inputs = [...container.querySelectorAll("input")];
    const buttons = [...container.querySelectorAll("button")];
    expect(inputs).toHaveLength(4);
    expect(buttons).toHaveLength(4);

    const ids = inputs.map((i) => i.id);
    expect(ids.every((id) => id.length > 0), "every box needs an id for its label and its toggle").toBe(true);
    expect(new Set(ids).size, "two instances shared an id").toBe(4);

    const targets = buttons.map((b) => b.getAttribute("aria-controls"));
    expect(new Set(targets).size, "two toggles claim the same box").toBe(4);
    // …and each one names a box that is actually here. A unique id pointing at nothing is still
    // four distinct strings, so the set size above cannot catch it.
    for (const target of targets) {
      expect(container.querySelector(`[id="${target}"]`), `aria-controls="${target}" names nothing`).toBeInstanceOf(
        HTMLInputElement,
      );
    }
    // every id belongs to exactly one label, too — the pairing is what a screen reader reads out
    expect(new Set(ids)).toEqual(new Set(targets));
  });
});

describe("AC 2 — a toggle moves its own box and leaves the other one alone", () => {
  it("walks all four visibility states, asserting BOTH types at each one", () => {
    const { container } = render(<PasswordFields {...props} />);
    const q = within(container);
    const password = q.getByLabelText("Password") as HTMLInputElement;
    const confirm = q.getByLabelText("Confirm password") as HTMLInputElement;
    const showPassword = () => q.getByRole("button", { name: /^(Show|Hide) password$/ });
    const showConfirm = () => q.getByRole("button", { name: /^(Show|Hide) confirm password$/ });

    // Both boxes are asserted at every step, never only the one that was clicked: a component
    // that flipped BOTH would pass a test that read the toggled box alone, and flipping both is
    // the likeliest way to get this wrong (one piece of state instead of two).
    const walk: [() => void, string, string][] = [
      [() => {}, "password", "password"],
      [() => fireEvent.click(showPassword()), "text", "password"],
      [() => fireEvent.click(showConfirm()), "text", "text"],
      [() => fireEvent.click(showPassword()), "password", "text"],
      [() => fireEvent.click(showConfirm()), "password", "password"],
    ];

    const seen: string[] = [];
    for (const [act, wantPassword, wantConfirm] of walk) {
      act();
      expect(password.type).toBe(wantPassword);
      expect(confirm.type).toBe(wantConfirm);
      seen.push(`${password.type}/${confirm.type}`);
    }
    // the walk really did visit all four combinations, rather than four steps in two of them
    expect(new Set(seen).size, "the walk never reached all four states").toBe(4);
  });
});

describe("AC 3 — each toggle announces itself and does not submit", () => {
  it("moves aria-pressed, keeps aria-controls on its own box, and renames itself", () => {
    const { container } = render(<PasswordFields {...props} />);
    const q = within(container);
    const password = q.getByLabelText("Password") as HTMLInputElement;
    const confirm = q.getByLabelText("Confirm password") as HTMLInputElement;

    const pwToggle = q.getByRole("button", { name: "Show password" });
    const cfToggle = q.getByRole("button", { name: "Show confirm password" });
    expect(pwToggle.getAttribute("aria-controls")).toBe(password.id);
    expect(cfToggle.getAttribute("aria-controls")).toBe(confirm.id);
    expect(pwToggle.getAttribute("aria-pressed")).toBe("false");
    expect(cfToggle.getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(pwToggle);
    // The accessible name is what a screen-reader user hears; it has to say the box is now open.
    expect(q.getByRole("button", { name: "Hide password" })).toBe(pwToggle);
    expect(pwToggle.getAttribute("aria-pressed")).toBe("true");
    // …and the other toggle is untouched in BOTH of its announcements, not only its input's type
    expect(cfToggle.getAttribute("aria-pressed")).toBe("false");
    expect(q.getByRole("button", { name: "Show confirm password" })).toBe(cfToggle);
    // aria-controls must not wander when the label does
    expect(pwToggle.getAttribute("aria-controls")).toBe(password.id);

    fireEvent.click(cfToggle);
    expect(q.getByRole("button", { name: "Hide confirm password" })).toBe(cfToggle);
    expect(cfToggle.getAttribute("aria-pressed")).toBe("true");
    expect(cfToggle.getAttribute("aria-controls")).toBe(confirm.id);
  });

  it("is type=button, so pressing it inside a form submits nothing — with a control that one CAN", () => {
    const submits = vi.fn((e: { preventDefault: () => void }) => e.preventDefault());
    const { container } = render(
      <form onSubmit={submits}>
        <PasswordFields {...props} />
        <button type="submit">Save</button>
      </form>,
    );
    const q = within(container);

    for (const button of container.querySelectorAll("button[aria-controls]")) {
      // The attribute is the mechanism and the zero below is the consequence; assert both, since
      // a default-submit button inside a form with no action can look inert in a harness.
      expect(button.getAttribute("type")).toBe("button");
    }

    fireEvent.click(q.getByRole("button", { name: "Show password" }));
    fireEvent.click(q.getByRole("button", { name: "Show confirm password" }));
    expect(submits, "a visibility toggle submitted the form").toHaveBeenCalledTimes(0);

    // The positive control, in the same test: a spy that cannot record a submit cannot fail the
    // assertion above, so a real submit button must move it to exactly one.
    fireEvent.click(q.getByRole("button", { name: "Save" }));
    expect(submits).toHaveBeenCalledTimes(1);
  });
});

describe("AC 11 — the two boxes cannot render at different sizes", () => {
  /**
   * From the design-bar pass on 2026-08-26, and it is the property this component exists for:
   * two boxes a member is asked to compare by eye must look like the same box.
   *
   * They did not. The field name was in the toggle's VISIBLE text, so "Show confirm password"
   * (21 characters) wrapped and stretched its flex row. *Measured in a real browser*:
   * /reset-password at 390px gave a 208x21 password box beside a 173x36 confirm box, and
   * /join at 320px gave 173x36 beside 173x52.
   */
  it("keeps both toggles to one short label and one width floor, in all four states", () => {
    const { container } = render(<PasswordFields {...props} />);
    const q = within(container);
    const pw = q.getByRole("button", { name: "Show password" });
    const cf = q.getByRole("button", { name: "Show confirm password" });

    // Both rows are identical only if the two buttons are: same text, same width floor.
    expect(pw.textContent).toBe("Show");
    expect(cf.textContent).toBe("Show");
    expect(pw.style.minWidth, "a toggle with no width floor can be sized by its text").not.toBe("");
    expect(pw.style.minWidth).toBe(cf.style.minWidth);

    // …and it has to hold in the other three states too, not just at rest: the regression
    // this replaces was a LABEL that changed width, so a check at one state proves nothing.
    fireEvent.click(pw);
    expect([pw.textContent, cf.textContent]).toEqual(["Hide", "Show"]);
    fireEvent.click(cf);
    expect([pw.textContent, cf.textContent]).toEqual(["Hide", "Hide"]);
    fireEvent.click(pw);
    expect([pw.textContent, cf.textContent]).toEqual(["Show", "Hide"]);

    // The field name is not gone, it moved to the accessible name — which is the half a
    // screen-reader user needs and the half a sighted user already has from the label.
    expect(pw.getAttribute("aria-label")).toBe("Show password");
    expect(cf.getAttribute("aria-label")).toBe("Hide confirm password");
  });

  it("is a proxy, because jsdom has no layout engine — asserted, not assumed", () => {
    // The claim above is about TEXT and STYLE, not geometry, and that is a real limitation
    // rather than a preference: jsdom lays nothing out, so every box here is 0x0 and a size
    // assertion would pass on any component at all. The geometry was measured in a browser and
    // the numbers are in the docblock. This test exists so a later reader who swaps in a
    // layout-capable environment finds out that the proxy can be upgraded.
    const { container } = render(<PasswordFields {...props} />);
    const input = container.querySelector("input")!;
    expect(input.getBoundingClientRect().width).toBe(0);
  });
});

describe("AC 4 — toggling keeps what was typed, in the same input element", () => {
  it("preserves both values and remounts neither box", () => {
    const { container } = render(<PasswordFields {...props} />);
    const q = within(container);
    const password = q.getByLabelText("Password") as HTMLInputElement;
    const confirm = q.getByLabelText("Confirm password") as HTMLInputElement;

    fireEvent.change(password, { target: { value: "a-long-passphrase" } });
    fireEvent.change(confirm, { target: { value: "a-different-one" } });

    fireEvent.click(q.getByRole("button", { name: "Show password" }));
    fireEvent.click(q.getByRole("button", { name: "Show confirm password" }));

    // Re-query rather than trusting the captured references: a remount would leave the old nodes
    // detached and still carrying their values, so reading them would pass on the very defect
    // this test is about.
    const afterPassword = q.getByLabelText("Password") as HTMLInputElement;
    const afterConfirm = q.getByLabelText("Confirm password") as HTMLInputElement;
    expect(afterPassword.value).toBe("a-long-passphrase");
    expect(afterConfirm.value).toBe("a-different-one");

    // The identity half. A re-keyed input clears itself, and a component that re-keyed AND
    // re-applied the value would pass the value check alone — which is why the AC asks for both.
    expect(afterPassword, "the password box was remounted").toBe(password);
    expect(afterConfirm, "the confirm box was remounted").toBe(confirm);
    expect(document.contains(password), "the original node left the document").toBe(true);
  });
});
