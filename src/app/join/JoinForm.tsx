"use client";

import { useState, type FormEvent } from "react";
import { explainReason } from "@/auth/callback";

type State = { kind: "idle" } | { kind: "sending" } | { kind: "done"; message: string; ok: boolean };
type Mode = "signin" | "signup";

/**
 * /join since #70, mechanisms changed by #82 and #99: two distinct choices. Sign in (returning
 * member) asks for email + password, or offers Google, with a Forgot-my-password link. Sign up
 * (new member) asks for name, invite code, the 18+ attestation and a password, and finishes
 * **here** — the gate creates the account, mints the person row and signs them in, so the browser
 * follows a redirect to the board rather than waiting for an email. Or it finishes with Google,
 * which needs no password. Only sign-up ever sends the code.
 *
 * `initialMode` exists because the sign-up tab is otherwise unreachable without an event, and
 * #99 AC 7 asks for its button to be asserted from the rendered HTML. It earns its place beyond
 * that: /join?mode=signup deep-links an invited member straight to the form they need.
 *
 * A response carrying `then: "signin"` moves the member to the Sign in tab **without clearing the
 * message** — the two answers that use it (an address that already has an account, and an account
 * created whose sign-in did not follow) are both "you have an account, use it", and the Sign in
 * tab is where the password box and the Forgot link are. Switching tabs by hand still clears.
 */
export function JoinForm({
  initialError,
  initialMode = "signin",
}: {
  initialError?: string;
  initialMode?: Mode;
}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [state, setState] = useState<State>(
    initialError ? { kind: "done", ok: false, message: explainReason(initialError) } : { kind: "idle" },
  );

  async function post(path: string, payload: unknown): Promise<{ ok: boolean; body: Record<string, unknown> }> {
    let res: Response;
    try {
      res = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
    } catch {
      // A dropped connection rejects the fetch before any status exists; without this the form
      // stayed on "Sending…" with every button disabled and no message (review finding, #70).
      return { ok: false, body: { message: "Could not reach the server. Check your connection and try again." } };
    }
    const body = (await res.json().catch(() => ({ message: "Something went wrong." }))) as Record<
      string,
      unknown
    >;
    return { ok: res.ok, body };
  }

  async function onSignIn(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setState({ kind: "sending" });
    const { ok, body } = await post("/api/signin", { email: f.get("email"), password: f.get("password") });
    // A successful password sign-in returns where to go, not a message — the session cookies are
    // already on the response, so the browser just follows.
    if (ok && typeof body.redirect === "string") {
      window.location.assign(body.redirect);
      return;
    }
    setState({ kind: "done", ok, message: String(body.message ?? "Something went wrong.") });
  }

  async function onSignUp(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    // Which finish button was pressed: the submitter carries a value.
    const finish = (e.nativeEvent as SubmitEvent).submitter?.getAttribute("value") ?? "email";
    const common = {
      displayName: f.get("displayName"),
      code: f.get("code"),
      attested: f.get("attested") === "on",
    };
    if (finish === "google") {
      setState({ kind: "sending" });
      const { ok, body } = await post("/api/signup/google", common);
      if (ok && typeof body.url === "string") {
        window.location.assign(body.url);
        return;
      }
      setState({ kind: "done", ok: false, message: String(body.message ?? "Something went wrong.") });
      return;
    }
    const email = String(f.get("email") ?? "");
    if (!email) {
      // Neither box can be `required`, because *Continue with Google* submits the same form and
      // needs neither — so the two checks below stand in for the browser's. The sentence changed
      // with the mechanism (#99): nothing is sent to this address, it is the account's name.
      form.querySelector<HTMLInputElement>('input[name="email"]')?.reportValidity();
      setState({ kind: "done", ok: false, message: "Enter the email address you want to sign in with." });
      return;
    }
    const password = String(f.get("password") ?? "");
    if (password.length < 8) {
      form.querySelector<HTMLInputElement>('input[name="password"]')?.reportValidity();
      setState({ kind: "done", ok: false, message: "Choose a password of at least 8 characters." });
      return;
    }
    setState({ kind: "sending" });
    const { ok, body } = await post("/api/join", { ...common, email, password });
    // A finished sign-up is a session, not a sentence: the gate signed them in and says where to go.
    if (ok && typeof body.redirect === "string") {
      window.location.assign(body.redirect);
      return;
    }
    if (body.then === "signin") setMode("signin");
    setState({ kind: "done", ok, message: String(body.message ?? "Something went wrong.") });
  }

  const busy = state.kind === "sending";

  return (
    <div style={{ display: "grid", gap: "1rem" }}>
      <div role="tablist" aria-label="Sign in or sign up" style={{ display: "flex", gap: "0.5rem" }}>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "signin"}
          data-mode="signin"
          onClick={() => {
            setMode("signin");
            setState({ kind: "idle" });
          }}
        >
          Sign in
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "signup"}
          data-mode="signup"
          onClick={() => {
            setMode("signup");
            setState({ kind: "idle" });
          }}
        >
          Sign up
        </button>
      </div>

      {mode === "signin" ? (
        <form onSubmit={onSignIn} data-form="signin" style={{ display: "grid", gap: "0.75rem" }}>
          <p>Already a member? Sign in with your email and password — no invite code needed.</p>
          <label>
            Email
            <input name="email" type="email" required autoComplete="email" />
          </label>
          <label>
            Password
            <input name="password" type="password" required autoComplete="current-password" />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? "Signing in…" : "Sign in"}
          </button>
          <a href="/auth/google" data-google="signin">
            Continue with Google
          </a>
          <a href="/forgot" data-forgot>
            Forgot my password?
          </a>
        </form>
      ) : (
        <form onSubmit={onSignUp} data-form="signup" style={{ display: "grid", gap: "0.75rem" }}>
          <p>New here? You need this season&apos;s invite code from the club.</p>
          <label>
            Your name
            <input name="displayName" required maxLength={80} autoComplete="name" />
          </label>
          <label>
            Invite code
            <input name="code" required autoComplete="off" />
          </label>
          <label>
            <input name="attested" type="checkbox" required /> I am 18 or over
          </label>
          <fieldset style={{ display: "grid", gap: "0.5rem" }}>
            <legend>Finish with</legend>
            <label>
              Email
              <input name="email" type="email" autoComplete="email" />
            </label>
            <label>
              Password
              <input name="password" type="password" autoComplete="new-password" minLength={8} />
            </label>
            <button type="submit" value="email" disabled={busy}>
              {busy ? "Setting up…" : "Create my account"}
            </button>
            <p style={{ margin: 0, fontSize: "0.85rem" }}>
              Or skip the password and use Google — nothing else to fill in:
            </p>
            <button type="submit" value="google" data-google="signup" disabled={busy}>
              Continue with Google
            </button>
          </fieldset>
        </form>
      )}
      {state.kind === "done" && <p role={state.ok ? "status" : "alert"}>{state.message}</p>}
    </div>
  );
}
