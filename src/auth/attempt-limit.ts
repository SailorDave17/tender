import { createHash } from "node:crypto";

/**
 * A bound on guessing (story #206, security-audit SA-5 / A07:2025), as a pure decision over an
 * injected store — the route supplies 0032's two functions, a test supplies anything.
 *
 * WHAT COUNTS. A FAILURE: a wrong invite code at `/api/join` or `/api/signup/google`, a wrong
 * email-and-password at `/api/signin`. Everything else — a missing attestation, a malformed
 * address, a Google token that did not verify, a success — is settled and stops counting, because
 * none of it is a guess. `/api/forgot` is the exception and counts every request, on a budget of
 * its own: it answers the same sentence whatever happens, so it has no failure to count, and what
 * it costs is mail sent to a member.
 *
 * WHICH KEYS. The source address always, across all three guessing gates at once, so a guesser
 * cannot spread tries across them. The submitted email address too wherever there is one (join,
 * sign-in), which is what bounds a guesser who rotates addresses. The Google gate has no email
 * before the token is exchanged, and the code is checked before that, so it is keyed by address
 * alone.
 *
 * THE LIMITS (owner decision 2026-09-23, on the issue). 20 failures per source address and 10 per
 * email address in 15 minutes. The address limit is loose on purpose: members at the clubhouse or
 * at a regatta share one address, and a tight limit would lock the dock out. README's runbook
 * carries the same numbers with the reason; this file is where they are read.
 *
 * WHAT A LIMITED CALLER SEES. Exactly what a wrong code or a wrong password gets, status and body,
 * so the limit is not an oracle: nothing in the answer says whether the code was wrong or the
 * caller was limited. The cost falls on a member who types the right code while their address is
 * limited, and it is the one the owner chose.
 *
 * WHY A RESERVATION. See 0032's header: `begin` writes this attempt's row before the attempt runs,
 * under a lock, so parallel guesses cannot all read the same count; `settle` removes the row
 * afterwards when the attempt was not a failure.
 *
 * WHEN THE STORE FAILS, THE GATE STAYS OPEN. A `begin` that throws lets the attempt through
 * unlimited, and says so on the server log. Refusing instead would turn a missing table or a
 * database hiccup into every member locked out of signing in, which is a worse failure than one
 * window of unlimited guessing at a code the admin can rotate. A `settle` that throws leaves the
 * row counted, which is the safe direction.
 */

export const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
export const IP_ATTEMPT_LIMIT = 20;
export const EMAIL_ATTEMPT_LIMIT = 10;

export type Gate = "join" | "signup-google" | "signin" | "forgot";

/** The gates whose failures share one budget per source address and per email. */
export const GUESSING_GATES: readonly Gate[] = ["join", "signup-google", "signin"];

export type AttemptStore = {
  /** 0032's `begin_auth_attempt`: this attempt's reservation id, or null when a key is at its limit. */
  begin: (a: {
    gate: Gate;
    gates: readonly Gate[];
    ipHash: string;
    emailHash: string | null;
    at: Date;
    since: Date;
    ipLimit: number;
    emailLimit: number;
  }) => Promise<string | null>;
  /** 0032's `settle_auth_attempt`: the attempt was not a failure. */
  settle: (id: string) => Promise<void>;
};

/** SHA-256 hex, so neither an address nor an email is stored. */
export function keyHash(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * The caller's address. On Vercel `x-real-ip` and `x-forwarded-for` both carry the client's public
 * address, and Vercel overwrites a client-supplied `X-Forwarded-For` rather than forwarding it
 * (docs: headers/request-headers, "to prevent IP spoofing"), so neither can be chosen by the
 * caller in production. Off Vercel there may be neither; every such request then shares one key,
 * which is a stricter limit, never a missing one.
 */
export function clientAddress(headers: Headers): string {
  const real = headers.get("x-real-ip")?.trim();
  if (real) return real;
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return forwarded || "unknown";
}

export type Limited<R> = {
  gate: Gate;
  ip: string;
  /** The submitted address, as typed; normalised here the way join() normalises it. Absent for the Google gate. */
  email?: string | null;
  store: AttemptStore;
  now?: () => Date;
  /** The answer a wrong code or wrong password gets — returned as-is when a key is at its limit. */
  refusal: R;
  attempt: () => Promise<R>;
  /** Whether this outcome is a failure that keeps counting. */
  isFailure: (result: R) => boolean;
};

export async function withAttemptLimit<R>(opts: Limited<R>): Promise<R> {
  const at = (opts.now ?? (() => new Date()))();
  const forgot = opts.gate === "forgot";
  const email = opts.email?.trim().toLowerCase() || null;

  let id: string | null;
  try {
    id = await opts.store.begin({
      gate: opts.gate,
      gates: forgot ? ["forgot"] : GUESSING_GATES,
      ipHash: keyHash(opts.ip),
      emailHash: email && !forgot ? keyHash(email) : null,
      at,
      since: new Date(at.getTime() - ATTEMPT_WINDOW_MS),
      ipLimit: IP_ATTEMPT_LIMIT,
      emailLimit: EMAIL_ATTEMPT_LIMIT,
    });
  } catch (error) {
    console.error(`attempt limit: ${opts.gate}: the store failed, so this attempt is not limited`, error);
    return opts.attempt();
  }
  if (id === null) return opts.refusal;

  const result = await opts.attempt();
  if (!forgot && !opts.isFailure(result)) {
    await opts.store.settle(id).catch((error) => {
      console.error(`attempt limit: ${opts.gate}: settle failed, so this attempt stays counted`, error);
    });
  }
  return result;
}
