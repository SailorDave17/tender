"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { availabilityRefusal } from "@/availability/rules";
import { BOARD_PATH, boardHref, boardView, showsDate } from "@/board/view";
import { supabaseServer } from "@/lib/supabase/server";
import { notifyRungLive } from "@/notify/live";
import { SIGN_IN_URL } from "@/auth/gate";

/**
 * Mark or unmark the signed-in person for a race day (story #18 AC 4). One Server Action for
 * both directions — a yes is a row, a no is its absence (0005) — decided by the `available`
 * field the form carries.
 *
 * The refusals the board already disables buttons for are applied again here, because a
 * disabled button is a courtesy and not a guard: a person with no rating, or a day already
 * started. The database repeats the first (0005's insert policy) and the ownership rule
 * (person_id = auth.uid()), so a crafted POST for someone else's id is refused by Postgres
 * whatever this code believes.
 *
 * Marking a day is the second of notifyRung()'s two call sites (story #23 AC 3): every open
 * post on that date is re-evaluated, so a crew who sits on a post's open rung is proposed and
 * emailed by the toggle, once. Unmarking notifies nobody — the ladder widens on emptiness
 * only when something asks it to, and the clock half is #25's.
 *
 * Since #214 the form carries the view it was pressed in, and every way out of this action
 * except the sign-in redirect goes back to that view through `back()`, at the date's own row
 * (`#<id>`) whenever that row will be on the page: a member who scrolled to a date is not dropped
 * at the top of the list, and a keyboard's next Tab starts from the date rather than from the
 * first day. A refusal names the row in the query too, and the page shows its sentence inside
 * the row. Where the row will NOT be there (an id that is no date, a date unpublished since the
 * page loaded, a date that has sailed and is outside the default view), the address has no
 * fragment, so the member lands at the top of the list with the sentence above it. The view is
 * read through the allow-list (`boardView`), so a crafted field (a URL, `//host`) is the default
 * view and the redirect is always to /board.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function field(formData: FormData, name: string): string {
  const v = formData.get(name);
  return typeof v === "string" ? v : "";
}

export async function setAvailability(formData: FormData): Promise<void> {
  const raceDateId = field(formData, "race_date_id");
  const available = field(formData, "available") === "true";
  const view = boardView(formData.get("view"));
  const now = new Date();
  // `row` is only ever a race_date_id that passed the UUID check below and names a published date.
  const back = (error?: string, row?: string) => boardHref(view, { error, row });
  if (!UUID.test(raceDateId)) redirect(back("refused"));

  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) redirect(SIGN_IN_URL);

  const [{ data: me }, { data: date }] = await Promise.all([
    client.from("person").select("rating").eq("id", user.id).maybeSingle(),
    client.from("race_date").select("starts_at").eq("id", raceDateId).eq("published", true).maybeSingle(),
  ]);
  // No such published date: there is no row to go back to, in either view.
  if (!date) redirect(back("refused"));
  // The row is on the page the member returns to unless the date has sailed out of the default view.
  const row = showsDate(view, date.starts_at, now) ? raceDateId : undefined;
  if (!me) redirect(back("refused", row));
  const refusal = availabilityRefusal(me, date, now);
  if (refusal) redirect(back(refusal, row));

  if (available) {
    const { error } = await client
      .from("availability")
      .insert({ person_id: user.id, race_date_id: raceDateId });
    // 23505 is the row already being there — the person tapped twice; that is the state they asked for.
    if (error && error.code !== "23505") redirect(back("refused", row));
    // The open posts on this day, as the caller may read them (published dates — which the
    // availability insert already required). Each is re-evaluated with this person in the pool.
    const { data: open } = await client.from("post").select("id").eq("race_date_id", raceDateId).is("closed_at", null);
    for (const p of open ?? []) await notifyRungLive(p.id);
  } else {
    const { error } = await client
      .from("availability")
      .delete()
      .eq("person_id", user.id)
      .eq("race_date_id", raceDateId);
    if (error) redirect(back("refused", row));
  }

  revalidatePath(BOARD_PATH);
  redirect(back(undefined, row));
}
