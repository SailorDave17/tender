"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { planImport, readPublishRow } from "@/dates/ics-import";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * The publish half of /admin/dates/import (story #40, AC 3): the rows the admin ticked become
 * race_date rows, published, in one insert — after the rows already on the calendar are read
 * and any the file repeats are set aside, so a second import of the same file adds nothing.
 *
 * Authorization is the database's, as for every write on race_date (src/app/admin/dates/
 * actions.ts): the read and the insert go through the cookie-bound client, so a non-admin's
 * insert is refused with 42501 whatever this code believes. The dedup read sees every row for
 * an admin (0004's read policy) — which is the right set to match against, since an unpublished
 * copy of a race is still that race.
 *
 * Refusals come back as ?error=<reason> on the import page, the shape every admin form here
 * uses; a success lands on /admin/dates with the two counts in the query, where the list shows
 * the new rows.
 */

const IMPORT = "/admin/dates/import";
const ADMIN_DATES = "/admin/dates";

export async function publishSelected(formData: FormData): Promise<void> {
  const raw = formData.getAll("row");
  const rows = raw.map(readPublishRow);
  // One unreadable row refuses the whole submit: the form never sends one, so a request that
  // carries one was not this form's.
  if (rows.some((r) => r === null)) redirect(`${IMPORT}?error=bad-row`);
  const selected = rows.filter((r) => r !== null);
  if (selected.length === 0) redirect(`${IMPORT}?error=nothing-selected`);

  const client = await supabaseServer();
  const { data: existing, error: readError } = await client.from("race_date").select("starts_at, title");
  if (readError) redirect(`${IMPORT}?error=refused`);

  const plan = planImport(selected, existing ?? []);
  if (plan.insert.length > 0) {
    const { error } = await client
      .from("race_date")
      .insert(plan.insert.map((r) => ({ starts_at: r.startsAt, title: r.title, published: true })));
    if (error) redirect(`${IMPORT}?error=refused`);
  }

  revalidatePath(ADMIN_DATES);
  revalidatePath("/board");
  redirect(`${ADMIN_DATES}?imported=${plan.insert.length}&skipped=${plan.duplicates.length}`);
}
