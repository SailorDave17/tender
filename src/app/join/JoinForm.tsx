"use client";

import { useRef, useState, type FormEvent } from "react";
import { explainReason } from "@/auth/callback";
import { GoogleButton } from "@/auth/GoogleButton";
import { PasswordFields } from "@/auth/PasswordFields";
import { checkNewPassword, explainResetError } from "@/auth/password";

type State = { kind: "idle" } | { kind: "sending" } | { kind: "done"; message: string; ok: boolean };
type Mode = "signin" | "signup";

/**
 * /join since #70, mechanisms changed by #82, #99, #173 and #220: two distinct choices. Sign in
 * (returning member) asks for email + password, or offers Google, with a Forgot-my-password link.
 * Sign up (new member) is about one thing, the invite code, in a large panel before any other
 * input (#220, owner decision 2026-09-22); then an email and password, or Google, which needs no
 * password. It finishes **here** — the gate creates the account, mints the person row with a
 * provisional name and signs them in, so the browser follows a redirect to /welcome ("Finish
 * your profile", #219) rather than waiting for an email. The name used to be asked on this form
 * and the 18+ confirmation was a checkbox; since #220 the name is /welcome's and the confirmation
 * is a line of text beside the create-account buttons — creating the account IS the confirmation,
 * so both create actions still post `attested: true` and both routes still refuse a request
 * without it. Only sign-up ever sends the code.
 *
 * **Google is the ID-token flow since #173.** Both tabs render Google Identity Services' own
 * button (`src/auth/GoogleButton.tsx`); Google hands this page an ID token on our own origin, and
 * the page posts it — with the raw nonce, and on the sign-up tab with the three form values — to
 * a server route that exchanges it and answers `{redirect}` with the session already on the
 * response, exactly as the password routes do. Nothing leaves this origin by redirect, which is
 * why the Google screens now name tender.madcowsailing.com rather than the Supabase host (#77).
 * The sign-up tab's Google arm used to be a submit button on this form; the form's own `required`
 * checks are now run by hand (`reportValidity`) when Google's callback fires, because Google's
 * button is an iframe that no `<form>` can own. `googleClientId` empty hides the option on both
 * tabs — the degrade `scripts/server-env.mjs` records.
 *
 * `initialMode` exists because the sign-up tab is otherwise unreachable without an event, and
 * #99 AC 7 asks for its button to be asserted from the rendered HTML. It earns its place beyond
 * that: /join?mode=signup deep-links an invited member straight to the form they need.
 *
 * Since #123 the page always passes it, and the `= "signin"` default below is a fallback rather
 * than the app's answer: `src/auth/recognition.ts` decides, from the URL first and the device's
 * recognition cookie second, so a browser that has never signed in here opens on **Sign up**. The
 * paragraph above described the only two reasons the prop existed, and that is what made Sign in
 * look chosen when it was the else-branch of a ternary — do not read the default here as a
 * decision.
 *
 * A response carrying `then: "signin"` moves the member to the Sign in tab **without clearing the
 * message** — the two answers that use it (an address that already has an account, and an account
 * created whose sign-in did not follow) are both "you have an account, use it", and the Sign in
 * tab is where the password box and the Forgot link are. Switching tabs by hand still clears.
 */
export function JoinForm({
  initialError,
  initialMode = "signin",
  googleClientId = "",
}: {
  initialError?: string;
  initialMode?: Mode;
  /** The public web client id GIS renders with; empty hides *Continue with Google* (#173). */
  googleClientId?: string;
}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [state, setState] = useState<State>(
    initialError ? { kind: "done", ok: false, message: explainReason(initialError) } : { kind: "idle" },
  );
  const signUpForm = useRef<HTMLFormElement>(null);

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

  /** A route answered: follow its redirect, or show its sentence. Shared by all four posts. */
  function settle({ ok, body }: { ok: boolean; body: Record<string, unknown> }) {
    if (ok && typeof body.redirect === "string") {
      window.location.assign(body.redirect);
      return;
    }
    if (body.then === "signin") setMode("signin");
    setState({ kind: "done", ok, message: String(body.message ?? "Something went wrong.") });
  }

  async function onSignIn(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setState({ kind: "sending" });
    // A successful password sign-in returns where to go, not a message — the session cookies are
    // already on the response, so the browser just follows.
    settle(await post("/api/signin", { email: f.get("email"), password: f.get("password") }));
  }

  /** Google's callback on the Sign in tab: the token goes to the route, nothing else is needed. */
  async function onGoogleSignIn(credential: string, nonce: string) {
    setState({ kind: "sending" });
    settle(await post("/api/signin/google", { credential, nonce }));
  }

  /**
   * Google's callback on the Sign up tab. The member has already been to Google, so the form's
   * one required control — the invite code — is checked here rather than by a submit:
   * `reportValidity` shows the browser's own bubble on it when empty and posts nothing, which is
   * what a submit would have done. The email and password boxes carry no constraint (see the
   * JSX), so they cannot block this arm. A wrong code comes back from the route as a sentence;
   * the token is simply dropped, and pressing Google again is a silent re-authentication.
   *
   * `attested: true` is posted rather than read off a box (#220): the 18+ confirmation is the
   * line of text beside this button, and pressing the button is the confirmation. The route
   * still refuses a request without it, so a caller that skips this screen gets no account.
   */
  async function onGoogleSignUp(credential: string, nonce: string) {
    const form = signUpForm.current;
    if (!form) return;
    if (!form.reportValidity()) {
      setState({ kind: "done", ok: false, message: "Enter your invite code first." });
      return;
    }
    const f = new FormData(form);
    setState({ kind: "sending" });
    settle(await post("/api/signup/google", { code: f.get("code"), attested: true, credential, nonce }));
  }

  async function onSignUp(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    // The code from the panel, and the confirmation this submit IS (#220, see onGoogleSignUp).
    const common = { code: f.get("code"), attested: true };
    const email = String(f.get("email") ?? "");
    if (!email) {
      // Neither box can be `required`, because *Continue with Google* reads this same form and
      // needs neither — so the two checks below stand in for the browser's. The sentence changed
      // with the mechanism (#99): nothing is sent to this address, it is the account's name.
      form.querySelector<HTMLInputElement>('input[name="email"]')?.reportValidity();
      setState({ kind: "done", ok: false, message: "Enter the email address you want to sign in with." });
      return;
    }
    const password = String(f.get("password") ?? "");
    const confirm = String(f.get("confirm") ?? "");
    // One decision, in `@/auth/password`, shared with the reset landing (#100): a mismatch is
    // reported before a weak password, because "they don't match" is the more useful thing to say
    // when both are wrong. Nothing is posted until this passes — the confirm box exists precisely
    // so a typo costs a sentence rather than an account nobody can sign in to.
    const check = checkNewPassword(password, confirm);
    if (!check.ok) {
      // No `reportValidity()` here, deliberately: neither box carries a browser constraint on
      // this screen (see below), so both are always individually valid and the call could only
      // ever be a no-op. The sentence is the whole message.
      setState({ kind: "done", ok: false, message: explainResetError(check.reason) });
      return;
    }
    setState({ kind: "sending" });
    // A finished sign-up is a session, not a sentence: the gate signed them in and says where to go.
    settle(await post("/api/join", { ...common, email, password }));
  }

  const busy = state.kind === "sending";
  const google = googleClientId.length > 0;

  return (
    <div data-stack="loose">
      <div role="tablist" aria-label="Sign in or sign up" data-tabs>
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
        <form onSubmit={onSignIn} data-form="signin" data-stack>
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
          {google && (
            <GoogleButton clientId={googleClientId} text="signin_with" flow="signin" onCredential={onGoogleSignIn} />
          )}
          <a href="/forgot" data-forgot>
            Forgot my password?
          </a>
        </form>
      ) : (
        <form ref={signUpForm} onSubmit={onSignUp} data-form="signup" data-stack>
          {/*
            #220: the invite code is the whole of the first thing a new member sees — its own
            bordered, tinted region with the page's largest heading, before any other input. (The
            "Already a member? Sign in" block is #218's, and sits above this when it lands.) A
            `role="group"` labelled by the heading rather than a second fieldset: the fieldset
            below is the account method, and two nested fieldsets read as one form in two boxes.
            The code input is the form's only `required` control, which is what lets the Google
            arm check it with `reportValidity` (see onGoogleSignUp).
          */}
          <section role="group" aria-labelledby="invite-heading" data-invite>
            <h2 id="invite-heading">Your invite code</h2>
            <label>
              Invite code
              <input name="code" required autoComplete="off" autoCapitalize="none" spellCheck={false} />
            </label>
            <p data-hint>It is in the club&apos;s invite email — or ask the organiser.</p>
          </section>
          <fieldset>
            <legend>Create your account with</legend>
            <label>
              Email
              <input name="email" type="email" autoComplete="email" />
            </label>
            {/*
              Neither box carries a browser constraint — no `required` AND no `minLength` — because
              *Continue with Google* reads this same form and needs no password. `required`
              would refuse an empty submission; `minLength` refuses a PARTLY TYPED one, which is
              worse, because it is inert until the member touches the box and then silently
              disables the Google arm (*measured in a browser 2026-08-26*: with `abc` typed,
              the submit event never fired). Since #173 the Google arm runs `reportValidity` itself
              rather than submitting, and that call honours the same constraints — so the reason
              the two boxes carry none is unchanged. `onSignUp` checks both boxes itself, on the
              email arm only, via the same `checkNewPassword` the reset landing uses.
            */}
            <PasswordFields passwordName="password" confirmName="confirm" />
            {/*
              #220: the 18+ confirmation as a line of text, where the checkbox was (owner decision
              2026-09-22, accepting that a sentence is weaker evidence than a box that had to be
              ticked). It precedes BOTH create-account buttons in the same group, so it is read
              before either is used, and it is body ink rather than a muted hint. Creating the
              account is the confirmation: both actions post `attested: true`, and both routes
              still refuse without it.
            */}
            <p data-attest>By creating an account you confirm you&apos;re 18 or over.</p>
            <button type="submit" value="email" disabled={busy}>
              {busy ? "Setting up…" : "Create my account"}
            </button>
            {google && (
              <GoogleButton clientId={googleClientId} text="signup_with" flow="signup" onCredential={onGoogleSignUp} />
            )}
          </fieldset>
        </form>
      )}
      {state.kind === "done" && <p role={state.ok ? "status" : "alert"}>{state.message}</p>}
    </div>
  );
}
