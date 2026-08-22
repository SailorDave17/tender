import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { loadBoardData } from "@/board/load";
import { candidateRows, poolForDate, viewPost } from "@/board/post-view";
import { formatStartsAt } from "@/dates/race-date";
import { CandidateList, RungBadge } from "@/post/CandidateList";
import { UUID, explainPostRefusal } from "@/post/post-form";
import { ratingLabel } from "@/profile/profile";
import { supabaseServer } from "@/lib/supabase/server";
import { closePost } from "../actions";

export const dynamic = "force-dynamic";

/**
 * /post/[id] — one post (story #19 AC 5, AC 6). Everyone signed in sees the need: boat, date,
 * minimum, note, and its open rung. The boat's owner also sees every available crew for that
 * date coloured by rung, and the Close button. Ownership is decided here from the boat row
 * the viewer can read; the database decides it again on Close (0006's update policy), so a
 * forged form gets zero rows, not a closed post.
 */
export default async function PostPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ error?: string }>;
}) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) redirect("/join");

  const data = await loadBoardData(client);
  const post = data.posts.find((p) => p.id === id);
  if (!post) notFound();
  const boat = data.boats.get(post.boat_id);
  const date = data.dates.find((d) => d.id === post.race_date_id);
  if (!boat || !date) notFound();
  const { error } = await searchParams;

  const now = new Date();
  const input = { starts_at: date.starts_at, boatClass: boat.class, minimum: post.minimum };
  const pool = poolForDate([...data.people.values()], data.availability, date.id);
  const view = viewPost(input, pool, now);
  const own = boat.owner_id === user.id;
  const f = formatStartsAt(date.starts_at);
  const closed = post.closed_at !== null;

  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif", maxWidth: "32rem" }}>
      <p>
        <Link href="/board">Back to the board</Link>
      </p>
      <h1>
        {boat.name} needs crew — {f.date}
      </h1>
      <p data-post={post.id} data-closed={closed}>
        {boat.class}, {f.time}, {date.title}. Skipper:{" "}
        <Link href={`/profile/${boat.owner_id}`}>{data.people.get(boat.owner_id)?.display_name ?? "someone"}</Link>.
        Minimum: {ratingLabel(post.minimum).toLowerCase()}.
      </p>
      {post.note && <blockquote>{post.note}</blockquote>}
      {closed ? (
        <p data-status="closed">
          <strong>Closed.</strong> This need is no longer on the board.
        </p>
      ) : (
        <p>
          Open at <RungBadge rung={view.rung} colour={view.colour} /> — {view.candidateCount}{" "}
          {view.candidateCount === 1 ? "crew" : "crew"} on or above it.
        </p>
      )}
      {error && <p role="alert">{explainPostRefusal(error)}</p>}

      {own ? (
        <>
          <h2>Who can sail that day</h2>
          <CandidateList rows={candidateRows(input, pool, now)} people={data.people} />
          {!closed && (
            <form action={closePost} style={{ marginTop: "1.5rem" }}>
              <input type="hidden" name="id" value={post.id} />
              <button type="submit">Close this need</button>
            </form>
          )}
        </>
      ) : (
        <p data-not-owner>Only the skipper sees who is available. Posts and answers arrive with the next story.</p>
      )}
    </main>
  );
}
