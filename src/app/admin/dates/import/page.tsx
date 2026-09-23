import Link from "next/link";
import { redirect } from "next/navigation";
import { explainRefusal, localDate } from "@/dates/race-date";
import { supabaseServer } from "@/lib/supabase/server";
import { ImportReview } from "./ImportReview";
import { SIGN_IN_URL } from "@/auth/gate";

export const dynamic = "force-dynamic";

/**
 * /admin/dates/import — seed the season from the club's .ics, with review before anything is
 * published (story #40). Gated the way /admin/dates is: no session was already sent to /join by
 * the proxy, and a signed-in non-admin goes to the board. The forms are in ImportReview; the
 * upload one reads only, the publish one writes through 0004's policies.
 */
export default async function AdminDatesImportPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) redirect(SIGN_IN_URL);
  const { data: me } = await client.from("person").select("is_admin").eq("id", user.id).maybeSingle();
  if (!me?.is_admin) redirect("/board");

  const { error } = await searchParams;

  return (
    <main data-measure="wide">
      <h1>Import the season calendar</h1>
      <p>
        Upload the club&apos;s .ics and check the race days it holds before they go on the board.
        A floating time is read as club local (America/New_York); a repeating event is shown but
        cannot be published from here. <Link href="/admin/dates">Back to race dates</Link>
      </p>
      {error && <p role="alert">{explainRefusal(error)}</p>}
      <ImportReview today={localDate(new Date())} />
    </main>
  );
}
