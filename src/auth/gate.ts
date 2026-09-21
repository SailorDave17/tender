/**
 * The proxy's one decision: does this request need a signed-in person, and where does it go
 * if there is none? Pure, so the redirect rule is tested without a request or a session.
 *
 * Only paths listed here are gated. Everything else — /join, /auth/callback, the static
 * assets the matcher already excludes — is open, because a person with no session has to be
 * able to reach the page that gives them one.
 */
export const PROTECTED_PREFIXES = ["/board", "/admin", "/profile", "/boats", "/post"] as const;
export const SIGN_IN_PATH = "/join";
/** Where a member who is already signed in goes when they ask for the sign-in screen (#123). */
export const SIGNED_IN_HOME = "/board";

export function isProtected(pathname: string): boolean {
  return PROTECTED_PREFIXES.some((p) => pathname === p || pathname.startsWith(p + "/"));
}

/**
 * The sign-in screen itself, and nothing else (#123). An exact match rather than a prefix: this
 * sends a signed-in member somewhere they did not ask to go, so the one path it may fire on is
 * the one that would otherwise hand them a sign-in form they do not need.
 */
export function isSignInScreen(pathname: string): boolean {
  return pathname === SIGN_IN_PATH;
}

/**
 * The path to redirect to, or null when the request may proceed.
 *
 * Both arms redirect, and they are not symmetric. A request with no session is sent away from the
 * paths that need one; a request WITH a session is sent away from exactly one path — `/join` —
 * because a member with a live session was being shown a sign-in form and asked to sign in again
 * (#123). Every other ungated path still answers `null` for a signed-in member, which is what
 * keeps this from quietly gating the whole site.
 */
export function redirectFor(pathname: string, signedIn: boolean): string | null {
  if (signedIn) return isSignInScreen(pathname) ? SIGNED_IN_HOME : null;
  return isProtected(pathname) ? SIGN_IN_PATH : null;
}
