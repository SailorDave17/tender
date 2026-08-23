"use client";

import { useState, type FormEvent } from "react";
import { explainReason } from "@/auth/callback";

type State = { kind: "idle" } | { kind: "sending" } | { kind: "done"; message: string; ok: boolean };
type Mode = "signin" | "signup";

/**
 * /join since #70: two distinct choices. Sign in (returning member) asks for email only, or
 * offers Google; Sign up (new member) asks for name, invite code and the 18+ attestation, then
 * finishes by email link or by Google. Only sign-up ever sends the code.
 */
export function JoinForm({ initialError }: { initialError?: string }) {
  const [mode, setMode] = useState<Mode>("signin");
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
    const { ok, body } = await post("/api/signin", { email: f.get("email") });
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
      form.querySelector<HTMLInputElement>('input[name="email"]')?.reportValidity();
      setState({ kind: "done", ok: false, message: "Enter your email address to be sent a link." });
      return;
    }
    setState({ kind: "sending" });
    const { ok, body } = await post("/api/join", { ...common, email });
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
          <p>Already a member? A sign-in link will be emailed to you — no invite code needed.</p>
          <label>
            Email
            <input name="email" type="email" required autoComplete="email" />
          </label>
          <button type="submit" disabled={busy}>
            {busy ? "Sending…" : "Email me a sign-in link"}
          </button>
          <a href="/auth/google" data-google="signin">
            Continue with Google
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
            <button type="submit" value="email" disabled={busy}>
              {busy ? "Sending…" : "Email me a link"}
            </button>
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
