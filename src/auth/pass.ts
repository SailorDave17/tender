import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * The gate pass: what the invite gate hands a new member who finishes sign-up with Google.
 *
 * With signups ON (epic #7 decision E, dashboard half reversed 2026-08-23 on #70), Supabase will
 * mint an auth user for any Google account that completes the OAuth dance. The pass is how
 * /auth/callback tells an invited new member from a stray one: the sign-up route checks the
 * invite code and the attestation, signs this payload with a server-only secret and sets it as
 * a short-lived HttpOnly cookie; the callback verifies it before writing the attestation onto
 * the user and minting the person row. No pass, no person — and the stray auth user is deleted.
 *
 * Pure: the secret and the clock are inputs, so a tampered, expired or foreign-secret pass is
 * a unit test with no cookies involved.
 */

export const PASS_COOKIE = "tender_gate";
export const PASS_TTL_MS = 10 * 60 * 1000;

export type PassPayload = {
  display_name: string;
  adult_attested_at: string;
  issued_at: string;
};

function b64url(buf: Buffer): string {
  return buf.toString("base64url");
}

type Hmac = typeof createHmac;

function mac(body: string, secret: string, hmac: Hmac = createHmac): Buffer {
  return hmac("sha256", secret).update(body).digest();
}

export function signPass(payload: PassPayload, secret: string): string {
  if (!secret) throw new Error("gate pass secret is empty");
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  return `${body}.${b64url(mac(body, secret))}`;
}

/** The payload if the token is intact, signed with this secret and younger than the TTL; else null. */
export function verifyPass(
  token: string | null | undefined,
  secret: string,
  now: Date = new Date(),
): PassPayload | null {
  return verifyPassWith(token, secret, now, createHmac);
}

/** verifyPass with the HMAC injectable, so a test can assert an empty secret never reaches it. */
export function verifyPassWith(
  token: string | null | undefined,
  secret: string,
  now: Date,
  hmac: Hmac,
): PassPayload | null {
  if (!token || !secret) return null;
  const dot = token.indexOf(".");
  if (dot < 1) return null;
  const body = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  const expected = mac(body, secret, hmac);
  let given: Buffer;
  try {
    given = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof payload !== "object" || payload === null) return null;
  const p = payload as Record<string, unknown>;
  if (
    typeof p.display_name !== "string" ||
    typeof p.adult_attested_at !== "string" ||
    typeof p.issued_at !== "string"
  ) {
    return null;
  }
  const issued = Date.parse(p.issued_at);
  if (Number.isNaN(issued)) return null;
  const age = now.getTime() - issued;
  if (age < 0 || age > PASS_TTL_MS) return null;
  return { display_name: p.display_name, adult_attested_at: p.adult_attested_at, issued_at: p.issued_at };
}
