"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { isHexColour } from "@/brand/contrast";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * The admin's one write on the theme: set the pair (story #41 AC 4). Nothing is decided here —
 * `set_club_theme()` (0028) is a definer that decides who may call it from `person.is_admin`,
 * computes the contrast in SQL and refuses a pair below 3.0 with `'contrast'`, whatever the
 * screen showed. A direct POST to this action with a crew's session, or with a 1.5:1 pair, gets
 * that refusal from Postgres. The only check made here is the SHAPE — six hex digits — so that
 * a mistyped colour is reported as such rather than as a bare refusal; the database refuses the
 * same thing again with `'colour'`, so this is a courtesy and not the wall.
 *
 * The error is mapped from the exception MESSAGE, which 0028's header states is the contract:
 * `'contrast'` and `'colour'` exactly. Anything else is reported as a refusal.
 *
 * `revalidatePath("/", "layout")`: every page reads the pair through the root layout, and the
 * layout reads the row per request, so this is belt and braces — but a cached RSC payload for
 * a page the admin navigates back to would otherwise carry the old pair until its next fetch.
 */

const THEME = "/admin/theme";

export async function setClubTheme(formData: FormData): Promise<void> {
  const disc = String(formData.get("disc") ?? "").trim();
  const mark = String(formData.get("mark") ?? "").trim();
  if (!isHexColour(disc) || !isHexColour(mark)) redirect(`${THEME}?error=colour`);

  const client = await supabaseServer();
  const { error } = await client.rpc("set_club_theme", { disc, mark });
  if (error) {
    const reason = error.message === "contrast" || error.message === "colour" ? error.message : "refused";
    redirect(`${THEME}?error=${reason}`);
  }

  revalidatePath("/", "layout");
  redirect(`${THEME}?saved=1`);
}
