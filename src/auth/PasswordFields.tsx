"use client";

import { useId, useState } from "react";

/**
 * Both toggles get the same width floor and the same two-word visible label, so the two boxes
 * render at the SAME size. *Measured 2026-08-26* before this existed: the longer label
 * ("Show confirm password", 21 characters) wrapped and stretched its flex row, so on
 * /reset-password the password box was 208x21 and the confirm box 173x36, and at a 320px
 * viewport they were 173x36 and 173x52. Two boxes whose whole purpose is to be compared by eye
 * cannot be different shapes.
 */
const TOGGLE = { minWidth: "4.5rem" } as const;

export type PasswordFieldsProps = {
  /** `name` for the first box — what the FormData key will be. */
  passwordName: string;
  /** `name` for the second box. */
  confirmName: string;
  /**
   * The policy minimum, passed in from `PASSWORD_MIN`; never written out here. **Optional,
   * and /join deliberately omits it** — see `required` below, which it shares a reason with.
   */
  minLength?: number;
  /**
   * The sentence to show, already chosen by the caller (`explainResetError`). Undefined renders
   * nothing. The sign-up arm passes nothing and keeps its own single message paragraph, so a
   * member never sees the same sentence twice.
   */
  error?: string;
  /**
   * `required` on both boxes. Off by default and deliberately so: /join's sign-up form is also
   * submitted by *Continue with Google*, which needs no password, and a `required` box would let
   * the browser refuse that submission (#99).
   *
   * **`minLength` is off there for the same reason, and that took a browser to see.** A
   * `minLength` constraint applies to a *dirty* value, so it is inert while a box is empty and
   * bites the moment somebody types — which means a member who starts a password, thinks
   * better of it and taps *Continue with Google* gets a button that does nothing at all.
   * *Measured 2026-08-26* in a real browser with `abc` typed: `validity.tooShort` true,
   * `form.checkValidity()` false, and the submit event never fires. It also made the
   * weak-password branch unreachable, so the app's own sentence could never be shown. On
   * /reset-password nothing else submits the form, so the constraint is free help and stays.
   */
  required?: boolean;
};

/**
 * The two boxes a person fills in when they are CHOOSING a password (#100), in one place: the
 * Sign up tab of /join and the /reset-password landing. Both used to hand-write their own inputs,
 * and the sign-up arm had only one box, so a typo there locked a new member out of the board with
 * nothing on screen that could have shown them.
 *
 * **This component decides nothing.** It renders two inputs, two toggles and an error sentence it
 * is handed. Whether a password is acceptable stays in `./password` — `checkNewPassword` and
 * `explainResetError` — which is the only reason that module is worth having: the reset landing
 * decides on the server in a Server Action, the sign-up arm decides in the browser, and they must
 * not drift. A component that validated would be a third copy.
 *
 * Two things here are load-bearing rather than decorative:
 *
 * - **The ids come from `useId()`**, so two instances in one tree (or one instance beside anything
 *   else on the page) cannot collide. A shared id would point both `aria-controls` at the same
 *   box and give a screen reader two controls that claim the same target.
 * - **Each toggle is `type="button"`.** The default for a `<button>` inside a form is `submit`, so
 *   the omission does not look like a bug — it looks like nothing at all, and the first press of
 *   *Show password* would submit a half-filled sign-up.
 *
 * The toggles read *Show* / *Hide* and carry the field name on `aria-label` instead. A screen
 * reader hears a control out of context, so its accessible name has to name the box; a sighted
 * user has the label an inch away and does not. Putting the field name in the visible text made
 * the confirm button wider than its neighbour, which is what pulled the two boxes out of
 * alignment (see `TOGGLE` below for the measurement).
 */
export function PasswordFields({
  passwordName,
  confirmName,
  minLength,
  error,
  required = false,
}: PasswordFieldsProps) {
  const passwordId = useId();
  const confirmId = useId();
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  return (
    <>
      <div style={{ display: "grid", gap: "0.25rem" }}>
        <label htmlFor={passwordId}>Password</label>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <input
            id={passwordId}
            name={passwordName}
            type={showPassword ? "text" : "password"}
            autoComplete="new-password"
            minLength={minLength}
            required={required}
            style={{ flex: 1 }}
          />
          <button
            type="button"
            aria-pressed={showPassword}
            aria-controls={passwordId}
            // The field name lives in the ACCESSIBLE name, not the visible one: a screen-reader
            // user hears the control out of context and needs to know which box it opens, while
            // a sighted user has the label right there. Keeping it visible made this button
            // wider than its neighbour and dragged the two boxes out of alignment.
            aria-label={showPassword ? "Hide password" : "Show password"}
            onClick={() => setShowPassword((v) => !v)}
            style={TOGGLE}
          >
            {showPassword ? "Hide" : "Show"}
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gap: "0.25rem" }}>
        <label htmlFor={confirmId}>Confirm password</label>
        <div style={{ display: "flex", gap: "0.5rem" }}>
          <input
            id={confirmId}
            name={confirmName}
            type={showConfirm ? "text" : "password"}
            autoComplete="new-password"
            minLength={minLength}
            required={required}
            style={{ flex: 1 }}
          />
          <button
            type="button"
            aria-pressed={showConfirm}
            aria-controls={confirmId}
            aria-label={showConfirm ? "Hide confirm password" : "Show confirm password"}
            onClick={() => setShowConfirm((v) => !v)}
            style={TOGGLE}
          >
            {showConfirm ? "Hide" : "Show"}
          </button>
        </div>
      </div>

      {error && <p role="alert">{error}</p>}
    </>
  );
}
