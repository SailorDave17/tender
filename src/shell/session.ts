import { cache } from "react";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Who the shell is rendering for (story #154): the signed-in person's name and whether they are
 * an admin, or `null` on a signed-out page. Read once per request — `cache()` — because the root
 * layout asks on every page, including `/`, `/join` and `/forgot`, where there is no session and
 * the answer is null without a network call (supabase-js answers `getUser()` from the absent
 * cookie before it would ask GoTrue).
 *
 * NOT `server-only`, on purpose: a module that imports it dies at import under vitest and takes
 * its importer's tests out of the total with `pending` still 0 (the tender overlay, #41(b)). The
 * layout's tests mock this module instead, the way they already mock the club-theme loader.
 *
 * A person with an auth user and no `person` row — the population #99 can strand — still gets an
 * identity line (their email) and a sign-out, because the shell is how they get back out.
 */
export type ShellPerson = {
  id: string;
  email: string | null;
  displayName: string | null;
  isAdmin: boolean;
};

export const currentPerson = cache(async (): Promise<ShellPerson | null> => {
  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) return null;
  const { data } = await client.from("person").select("display_name, is_admin").eq("id", user.id).maybeSingle();
  return {
    id: user.id,
    email: user.email ?? null,
    displayName: data?.display_name ?? null,
    isAdmin: data?.is_admin === true,
  };
});
