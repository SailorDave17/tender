import "server-only";
import LIST from "./common-passwords.json";

/**
 * The common-password check for a NEW password, at sign-up and at the reset landing (#268,
 * security-audit SA-R2). NIST SP 800-63B-4 §3.1.1.2: a verifier "SHALL compare the prospective
 * secret against a blocklist that contains known commonly used, expected, or compromised passwords.
 * The entire password SHALL be subject to comparison". So this is a whole-password match, never a
 * substring one.
 *
 * SERVER ONLY, which is what the first line enforces. `src/auth/password.ts` is imported by the
 * Sign up tab (`JoinForm`, a client component), so a list placed there would ship ~590 KB to every
 * browser that opens /join. The two callers are `/api/join` (through `join()`'s `isCommonPassword`
 * dep) and the reset landing's Server Action. Sign-in never asks: an existing member is not refused
 * because the policy moved, for the reason `password.ts` gives.
 *
 * THE LIST (owner decision at pickup, 2026-10-11): the UK National Cyber Security Centre's 100,000
 * most-used passwords from Have I Been Pwned's breach corpus (published 2019), as mirrored in
 * SecLists at commit 1a7bb9127eca9e6ff2fc0301c597fe6e16a0cb56,
 * `Passwords/Common-Credentials/100k-most-used-passwords-NCSC.txt` (99,839 lines, sha256
 * c2e5696882c603b76bb67a47ee970897e5a76fc4c3f5547abe3d0ca340c576e0, retrieved 2026-10-11).
 * SecLists is MIT-licensed, copyright (c) 2018 Daniel Miessler. `common-passwords.json` holds every
 * entry after NFC normalisation and lower-casing that is at least `PASSWORD_MIN` (8) code points
 * long, first occurrence kept, in the source's rank order: 46,483 entries. A shorter one is refused
 * by the length rule before this is asked, so carrying it would cost bytes and catch nothing.
 * `test/common-password.test.ts` holds the count and the shortest entry against the policy, so
 * lowering `PASSWORD_MIN` without regenerating the file goes red.
 *
 * The comparison folds the candidate the same way: NFC, then lower case. "Password1" is tried
 * as early as "password1", and a decomposed spelling must not slip past a composed entry.
 */

const COMMON: ReadonlySet<string> = new Set(LIST);

export function isCommonPassword(password: string): boolean {
  return COMMON.has(password.normalize("NFC").toLowerCase());
}

/** How many entries the check holds. Exported for the test that pins the list to its source. */
export const COMMON_PASSWORD_COUNT = COMMON.size;
