"use client";

import { useState, type FormEvent } from "react";

type State = { kind: "idle" } | { kind: "sending" } | { kind: "done"; message: string; ok: boolean };

/**
 * The Forgot-my-password screen (#82 AC 4, narrowed by #99): one email field and exactly one
 * button — reset my password. The second button was *Email me a sign-in link*, and #99 removed the
 * magic link everywhere, so it went with it. The answer is the same generic sentence whether or
 * not the address is registered.
 */
export function ForgotForm() {
  const [state, setState] = useState<State>({ kind: "idle" });

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const email = String(new FormData(form).get("email") ?? "");
    setState({ kind: "sending" });
    let ok = false;
    let message = "Something went wrong.";
    try {
      const res = await fetch("/api/forgot", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email }),
      });
      const b = (await res.json().catch(() => ({}))) as { message?: string };
      ok = res.ok;
      message = b.message ?? message;
    } catch {
      message = "Could not reach the server. Check your connection and try again.";
    }
    setState({ kind: "done", ok, message });
  }

  const busy = state.kind === "sending";

  return (
    <form onSubmit={onSubmit} data-form="forgot" style={{ display: "grid", gap: "0.75rem" }}>
      <label>
        Email
        <input name="email" type="email" required autoComplete="email" />
      </label>
      <button type="submit" data-action="reset" disabled={busy}>
        {busy ? "Sending…" : "Reset my password"}
      </button>
      {state.kind === "done" && <p role={state.ok ? "status" : "alert"}>{state.message}</p>}
    </form>
  );
}
