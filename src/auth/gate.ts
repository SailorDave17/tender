/**
 * The proxy's one decision: does this request need a signed-in person, and where does it go
 * if there is none? Pure, so the redirect rule is tested without a request or a session.
 *
 * Only paths listed here are gated. Everything else — /join, /auth/callback, the static
 * assets the matcher already excludes — is open, because a person with no session has to be
 * able to reach the page that gives them one.
 */
export const PROTECTED_PREFIXES = ["/board", "/admin"] as const;
export const SIGN_IN_PATH = "/join";

export function isProtected(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

/** The path to redirect to, or null when the request may proceed. */
export function redirectFor(pathname: string, signedIn: boolean): string | null {
  if (signedIn) return null;
  return isProtected(pathname) ? SIGN_IN_PATH : null;
}
