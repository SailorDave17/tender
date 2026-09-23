/**
 * The proxy's one decision: does this request need a signed-in person, and where does it go
 * if there is none? Pure, so the redirect rule is tested without a request or a session.
 *
 * Only paths listed here are gated. Everything else — /join, /auth/callback, the static
 * assets the matcher already excludes — is open, because a person with no session has to be
 * able to reach the page that gives them one.
 */
export const PROTECTED_PREFIXES = ["/board", "/admin", "/profile", "/boats", "/post"] as const;
/** The sign-in screen's PATHNAME, which the gate compares against a request's pathname. Never add a query here. */
export const SIGN_IN_PATH = "/join";
/**
 * What a redirect to the sign-in screen carries (#234): the Sign in tab by name. `/join` alone
 * opens on Sign up for a device with no `tender_seen` cookie (#123), and the person a members-only
 * page turns away is, overwhelmingly, a member.
 */
export const SIGN_IN_SEARCH = "?mode=signin";
/**
 * Where a signed-out visitor is SENT, as a URL: for `redirect()` in pages and actions.
 *
 * Two constants rather than one, and that is the whole of #234's trap. `SIGN_IN_PATH` is compared
 * against a pathname (`isSignInScreen`), so giving it the query would make that comparison never
 * match; and the proxy assigns a target to `url.pathname`, where a `?` is encoded as `%3F` rather
 * than read as the start of a query. So the gate decides in pathnames, and the query is added at
 * the edge, by `searchFor` in the proxy and by this constant in the pages.
 */
export const SIGN_IN_URL = `${SIGN_IN_PATH}${SIGN_IN_SEARCH}`;
/** Where a member who is already signed in goes when they ask for the sign-in screen (#123). */
export const SIGNED_IN_HOME = "/board";
/**
 * "Finish your profile" (#219): where a signed-in member whose `profile_completed_at` is null is
 * sent from every gated path. Deliberately NOT one of the protected prefixes — those send an
 * unfinished member HERE, so listing it among them would redirect it to itself.
 */
export const WELCOME_PATH = "/welcome";

/**
 * Who is asking, as far as the gate needs to know (#219). Until then the proxy passed a boolean.
 *
 * - `signed-out`  no session.
 * - `no-person`   a session with no `person` row — a deleted account whose sign-in record
 *                 survived, or the population #99 could strand. The pages send it to
 *                 `/join?error=not-invited`, so the gate must let it LAND there (see below).
 * - `unfinished`  a person row whose `profile_completed_at` is null.
 * - `finished`    everyone else, and what a signed-in request is taken to be whenever the proxy
 *                 did not read the row (see `needsPersonRead`) or the read failed. That is exactly
 *                 the old `true`, so every path this story does not touch behaves as before.
 */
export type Standing = "signed-out" | "no-person" | "unfinished" | "finished";

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
 * The search string a redirect to `target` carries (#234): the Sign in tab for the sign-in screen,
 * and nothing for any other target. Nothing, not the request's own query: the proxy has always
 * dropped that, so `/board?x=1` never became `/welcome?x=1`, and that stays true.
 */
export function searchFor(target: string): string {
  return target === SIGN_IN_PATH ? SIGN_IN_SEARCH : "";
}

export function isWelcome(pathname: string): boolean {
  return pathname === WELCOME_PATH;
}

/**
 * Does the answer for this path depend on the person row, so the proxy has to read it (#219)?
 * Only the paths where `unfinished`, `no-person` and `finished` answer differently: the protected
 * prefixes, /welcome and /join. Everywhere else a signed-in request answers `null` whatever its
 * standing, so the proxy spends no read on it.
 */
export function needsPersonRead(pathname: string): boolean {
  return isProtected(pathname) || isWelcome(pathname) || isSignInScreen(pathname);
}

/**
 * The standing a signed-in request has, from the proxy's read of its own person row (#219).
 *
 * A FAILED read answers `finished` — the behaviour before this story — rather than `unfinished`:
 * this gate is a screen in front of pages that each read the row again through RLS, not an
 * authorisation, so the cost of failing open is one request that skips /welcome, while failing
 * closed would send every member to /welcome whenever the database hiccuped, from where the page's
 * own read would then fail too.
 */
export function standingFromRow(
  row: { profile_completed_at: string | null } | null,
  error: unknown,
): Exclude<Standing, "signed-out"> {
  if (error) return "finished";
  if (!row) return "no-person";
  return row.profile_completed_at === null ? "unfinished" : "finished";
}

/**
 * The path to redirect to, or null when the request may proceed.
 *
 * No session: sent away from the paths that need one, /welcome included.
 *
 * A finished member is sent away from exactly two paths, `/join` (#123: a member with a live
 * session was being shown a sign-in form and asked to sign in again) and `/welcome` (#219: there is
 * nothing left for them to finish). Every other ungated path answers `null`, which is what keeps
 * this from quietly gating the whole site.
 *
 * An unfinished member is sent TO /welcome from every protected prefix and from /join, and let
 * through on /welcome itself — the one path that must answer null for them, or this is a loop.
 *
 * A session with no person row answers null everywhere. That is the fix for the bounce #219 names:
 * /profile sent it to `/join?error=not-invited`, and the `/join` arm above sent every signed-in
 * request on to /board, so the sentence explaining what was wrong never rendered. The pages keep
 * deciding for this population, as they did before; the gate only stops overruling them on /join.
 */
export function redirectFor(pathname: string, standing: Standing): string | null {
  switch (standing) {
    case "signed-out":
      return isProtected(pathname) || isWelcome(pathname) ? SIGN_IN_PATH : null;
    case "no-person":
      return null;
    case "unfinished":
      return isProtected(pathname) || isSignInScreen(pathname) ? WELCOME_PATH : null;
    case "finished":
      return isSignInScreen(pathname) || isWelcome(pathname) ? SIGNED_IN_HOME : null;
  }
}
