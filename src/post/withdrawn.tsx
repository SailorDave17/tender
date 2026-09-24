import Link from "next/link";
import { formatStartsAt } from "@/dates/race-date";
import type { supabaseServer } from "@/lib/supabase/server";

/**
 * A post whose race day the club unpublished (story #199). 0006's read policy hides such a post
 * from everyone, its own skipper included, and with it the answers, the match, contact details
 * and the thread — so /post/<id> and /post/<id>/thread find nothing, and a push already on a
 * phone for that post would land on "Not here".
 *
 * Before either page calls notFound(), it asks withdrawn_post_day() (0034). The function answers
 * the post's day only to the post's own people — the boat's owner and anyone who answered it,
 * which between them are both parties to any match — and NULL to everyone else, including for a post that does not exist. So a
 * member with no part in the post still gets "Not here", exactly as before, and cannot tell a
 * withdrawn post from a missing one; the skipper and their crew are told what happened instead.
 * Nothing the policies hide is read here: the page shows the day, which the viewer already knew.
 */

type Client = Awaited<ReturnType<typeof supabaseServer>>;

/** The withdrawn post's day, for one of its own people; null for anyone else or anything else. */
export async function readWithdrawnDay(client: Client, postId: string): Promise<string | null> {
  const { data, error } = await client.rpc("withdrawn_post_day", { p_post: postId });
  // A failed read falls back to the page's own notFound(): "Not here" is the answer the page
  // gave before this story, so an error can do no worse than that.
  if (error || typeof data !== "string") return null;
  return data;
}

export function WithdrawnPost({ startsAt }: { startsAt: string }) {
  const f = formatStartsAt(startsAt);
  return (
    <main data-withdrawn>
      <h1>This race day was withdrawn</h1>
      <p>
        The club has taken {f.date} off the board, so this crew need, and everything on it, is not
        shown for now. If the day comes back, so does the need.
      </p>
      <p>
        <Link href="/board">Back to the board</Link>
      </p>
    </main>
  );
}
