import { attestationOf } from "./person";

/**
 * Find the auth user at an address, and say whether it carries an attestation (#85).
 *
 * The invite gate needs this only on one branch: `createUser` came back `email_exists`, so an
 * auth user is already there and the gate has to know *which* human it belongs to before it
 * decides whether to stamp its attestation onto them.
 *
 * GoTrue's admin API has no lookup by address — `listUsers` sends `page` and `per_page` and
 * nothing else (read off @supabase/auth-js 2.112.3, `GoTrueAdminApi.listUsers`), so the paging
 * is ours. That is affordable here because the population is one sailing club, and it is a
 * property of the deployment rather than of the code: see USERS_PER_PAGE.
 *
 * Pure over an injected pager, so the route supplies the effect and every branch below is
 * reachable from a unit test — the live project cannot be reached from a session at all
 * (`SUPABASE_SERVICE_ROLE_KEY` is name-only in .env.local).
 */

export type ListedUser = {
  id: string;
  email?: string | null;
  user_metadata?: Record<string, unknown> | null;
};

export type UserPage = { users: ListedUser[] } | { error: string };

export type FoundUser =
  | { found: false }
  | { found: true; id: string; attested: boolean }
  | { error: string };

/**
 * GoTrue's own maximum. A club that outgrows one page is a club that outgrew this app's whole
 * shape, so the paging below exists to be correct rather than to be exercised.
 */
export const USERS_PER_PAGE = 1000;

/** Enough for a million users. Reaching it is an error, never a "not found" — see below. */
export const MAX_PAGES = 1000;

export async function findAuthUser(
  email: string,
  listPage: (page: number, perPage: number) => Promise<UserPage>,
): Promise<FoundUser> {
  const wanted = email.trim().toLowerCase();
  if (!wanted) return { found: false };

  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = await listPage(page, USERS_PER_PAGE);
    if ("error" in result) return { error: result.error };

    const hit = result.users.find((u) => (u.email ?? "").trim().toLowerCase() === wanted);
    if (hit) return { found: true, id: hit.id, attested: attestationOf(hit.user_metadata) !== null };

    // A short page is the last page. Without this the loop would ask for MAX_PAGES empty pages
    // on every miss.
    if (result.users.length < USERS_PER_PAGE) return { found: false };
  }

  // Running out of pages is NOT a "not found". A false negative here puts the caller back on the
  // exact branch #85 is about — the gate would decide there was nothing to attest, send the link
  // anyway, and the callback would delete a legitimately invited member. An error refuses to
  // send; a `found: false` would ship the defect back under a different cause.
  return { error: `auth user lookup exhausted ${MAX_PAGES} pages without reaching the end` };
}
