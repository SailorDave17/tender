import { createHash, timingSafeEqual } from "node:crypto";

/**
 * The one credential in this app that is not a person: the shared secret a scheduler presents to
 * /api/ladder/tick (story #25). pg_cron reads it from Vault and Vercel's daily sweep carries it
 * from the environment (#26); both spell it `Authorization: Bearer <CRON_SECRET>`.
 *
 * Pure, so the refusal is tested without a request — and because AC 5 asks that a call with no
 * secret leave the repo untouched, which is a claim about ORDER: this answers before anything
 * else in the route runs.
 *
 * AN ABSENT SECRET REFUSES EVERYTHING. That is the whole reason this is a function rather than a
 * comparison at the call site: the natural spelling, `if (secret && header !== …)`, opens the
 * route to the world on any deployment where the variable was never set — which is every
 * preview, and production until step 3 of the runbook is done. A tick nobody can call is a
 * feature that does not work; a tick anybody can call is a mailing list anybody can trigger.
 *
 * The comparison is over SHA-256 digests rather than the strings, so it takes the same time
 * whatever is presented and cannot leak the secret's length. `timingSafeEqual` requires equal
 * lengths and throws otherwise, which digesting guarantees.
 */
const BEARER = /^Bearer\s+(\S.*)$/i;

export function bearerAuthorized(header: string | null | undefined, secret: string | undefined): boolean {
  if (!secret) return false;
  const match = header ? BEARER.exec(header) : null;
  if (!match) return false;
  const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();
  return timingSafeEqual(digest(match[1]), digest(secret));
}
