"use client";

import { useState, type FormEvent } from "react";

type State = { kind: "idle" } | { kind: "sending" } | { kind: "done"; message: string; ok: boolean };

export function JoinForm({ initialError }: { initialError?: string }) {
  const [state, setState] = useState<State>(
    initialError ? { kind: "done", ok: false, message: explain(initialError) } : { kind: "idle" },
  );

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setState({ kind: "sending" });
    const res = await fetch("/api/join", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: f.get("email"),
        displayName: f.get("displayName"),
        code: f.get("code"),
        attested: f.get("attested") === "on",
      }),
    });
    const body = (await res.json().catch(() => ({ message: "Something went wrong." }))) as {
      message: string;
    };
    setState({ kind: "done", ok: res.ok, message: body.message });
  }

  return (
    <form onSubmit={onSubmit} style={{ display: "grid", gap: "0.75rem" }}>
      <label>
        Your name
        <input name="displayName" required maxLength={80} autoComplete="name" />
      </label>
      <label>
        Email
        <input name="email" type="email" required autoComplete="email" />
      </label>
      <label>
        Invite code
        <input name="code" required autoComplete="off" />
      </label>
      <label>
        <input name="attested" type="checkbox" required /> I am 18 or over
      </label>
      <button type="submit" disabled={state.kind === "sending"}>
        {state.kind === "sending" ? "Sending…" : "Send me a sign-in link"}
      </button>
      {state.kind === "done" && <p role={state.ok ? "status" : "alert"}>{state.message}</p>}
    </form>
  );
}

function explain(code: string): string {
  switch (code) {
    case "link-invalid":
      return "That link has expired or was already used. Ask for a new one.";
    case "not-invited":
      return "That account did not come through the invite gate. Ask for a new link here.";
    case "missing-code":
      return "That link was incomplete. Ask for a new one.";
    default:
      return "Sign-in did not complete. Ask for a new link.";
  }
}
