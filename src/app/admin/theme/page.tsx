import { notFound, redirect } from "next/navigation";
import { HOOVER_SAILING_CLUB } from "@/brand/theme";
import { supabaseServer } from "@/lib/supabase/server";
import { setClubTheme } from "./actions";
import { ThemeForm } from "./ThemeForm";

export const dynamic = "force-dynamic";

/**
 * /admin/theme — the club's two colours, with the contrast rule in front of Save (story #41 AC 4).
 *
 * The gate is /admin's, for the same reasons: the proxy has sent anyone with no session to /join,
 * and a signed-in non-admin gets a 404 rather than a refusal, because the page exists for one
 * person and to everyone else it does not exist. The action does not re-check it — it does not
 * need to. `set_club_theme()` (0028) is a definer that decides who may call it from
 * `person.is_admin` and raises 42501 otherwise, so a direct POST with a crew's session is refused
 * by Postgres whatever this page showed. Same arrangement as the rotate button one screen up.
 *
 * The pair is read as the signed-in admin through the cookie-bound client: 0002 grants
 * `brand_disc` and `brand_mark` to every member, so this is a plain select and not a service-role
 * read. (The LAYOUT reads the same two columns as the service role, for the signed-out pages'
 * sake — `src/brand/club-theme.ts` says why.)
 *
 * The form is a client component because the preview and the ratio are live: the admin sees the
 * mark in the pair they are typing and the number beside it before anything is saved, and Save
 * is disabled below 3.0. That is the screen's courtesy. The ENFORCEMENT is the database's — the
 * criterion says "enforced at save against a bypass of the screen", and 0028 is that.
 *
 * After a save the whole tree is revalidated (the action does it), so the reload of /board that
 * the criterion names shows the new pair: the layout reads the row per request in any case.
 */
export default async function ThemePage({
  searchParams,
}: {
  searchParams: Promise<{ saved?: string; error?: string }>;
}) {
  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) redirect("/join");
  const { data: me } = await client.from("person").select("is_admin").eq("id", user.id).maybeSingle();
  if (!me?.is_admin) notFound();

  const { data: club } = await client.from("club").select("brand_disc, brand_mark").limit(1).maybeSingle();
  // The row exists or nobody could have signed in (README step 1); the fallback is for the type,
  // and it is the seed pair rather than an invented one so the form never proposes a colour.
  const disc = club?.brand_disc ?? HOOVER_SAILING_CLUB.disc;
  const mark = club?.brand_mark ?? HOOVER_SAILING_CLUB.mark;
  const { saved, error } = await searchParams;

  return (
    <main data-measure="wide">
      <h1>Theme</h1>
      <p>
        <a href="/admin">Back to admin</a> · <a href="/board">The board</a>
      </p>
      <p>
        The app wears two colours: the <strong>disc</strong> behind the mark and the app bar, and
        the <strong>mark</strong> drawn on it. They need to be readable against each other —
        the contrast between them must be at least 3.0, or the badge turns into a solid blob at
        icon sizes. The rule is enforced when you save, not only on this screen.
      </p>

      {saved && (
        <p role="status" data-theme-saved>
          Saved. The new colours are on every screen from the next page load.
        </p>
      )}
      {error === "contrast" && (
        <p role="alert" data-theme-error="contrast">
          Not saved: the database refused the pair because its contrast is below 3.0.
        </p>
      )}
      {error === "colour" && (
        <p role="alert" data-theme-error="colour">
          Not saved: each colour has to be six hex digits after a <code>#</code>, like{" "}
          <code>{HOOVER_SAILING_CLUB.disc}</code>.
        </p>
      )}
      {error === "refused" && (
        <p role="alert" data-theme-error="refused">
          Not saved: the database refused the change.
        </p>
      )}

      <ThemeForm disc={disc} mark={mark} action={setClubTheme} />
    </main>
  );
}
