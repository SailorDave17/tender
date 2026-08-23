import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { loadBoardData } from "@/board/load";
import { candidateRows, poolForDate, viewPost } from "@/board/post-view";
import { formatStartsAt } from "@/dates/race-date";
import { toCrew } from "@/engine/toCrew";
import { answerState, explainAnswerRefusal } from "@/post/answer-rules";
import { CandidateList, RungBadge } from "@/post/CandidateList";
import { UUID, explainPostRefusal } from "@/post/post-form";
import { ratingLabel } from "@/profile/profile";
import { supabaseServer } from "@/lib/supabase/server";
import { answerPost, closePost } from "../actions";

export const dynamic = "force-dynamic";

/**
 * /post/[id] — one post (story #19 AC 5, AC 6; story #20 AC 2–4). Everyone signed in sees the
 * need: boat, date, minimum, note, its open rung, and how many have answered. The boat's owner
 * also sees every available crew for that date coloured by rung — those who answered first,
 * badged — and the Close button. Anyone else sees their own answer state: I can, Withdraw, or
 * I can disabled with a link to mark the day first (answer-rules.ts decides which). Ownership
 * is decided here from the boat row the viewer can read; the database decides it again on
 * Close (0006's update policy) and on every answer (0007), so a forged form gets zero rows or
 * 42501, never a write it should not have had.
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
  const answered = new Set(data.answers.filter((a) => a.post_id === post.id).map((a) => a.person_id));
  const answeredCount = data.answerCounts.get(post.id) ?? 0;
  // An answerer who has since unmarked the day is still shown to the skipper (post-view.ts).
  const inPool = new Set(pool.map((c) => c.id));
  const answerersGone = [...answered]
    .filter((id) => !inPool.has(id))
    .map((id) => (data.people.has(id) ? toCrew(data.people.get(id)!, false) : null))
    .filter((c): c is NonNullable<typeof c> => c !== null);
  const state = answerState(
    post,
    date,
    { answered: answered.has(user.id), available: data.availability.some((a) => a.person_id === user.id && a.race_date_id === date.id) },
    now,
  );

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
      {error && <p role="alert">{own ? explainPostRefusal(error) : explainAnswerRefusal(error)}</p>}

      {own ? (
        <>
          <h2>Who can sail that day</h2>
          <CandidateList rows={candidateRows(input, [...pool, ...answerersGone], now, answered)} people={data.people} />
          {!closed && (
            <form action={closePost} style={{ marginTop: "1.5rem" }}>
              <input type="hidden" name="id" value={post.id} />
              <button type="submit">Close this need</button>
            </form>
          )}
        </>
      ) : (
        <section data-answer-state={state}>
          <p data-answered-count={answeredCount}>
            {answeredCount === 0 ? "Nobody has answered yet." : answeredCount === 1 ? "1 crew has answered." : `${answeredCount} crew have answered.`}{" "}
            Only the skipper sees who.
          </p>
          {state === "answered" && (
            <form action={answerPost}>
              <input type="hidden" name="post_id" value={post.id} />
              <input type="hidden" name="answer" value="false" />
              <p>
                <strong>You answered.</strong> The skipper can pick you.
              </p>
              <button type="submit">Withdraw</button>
            </form>
          )}
          {state === "can" && (
            <form action={answerPost}>
              <input type="hidden" name="post_id" value={post.id} />
              <input type="hidden" name="answer" value="true" />
              <button type="submit">I can</button>
            </form>
          )}
          {state === "unavailable" && (
            <p>
              <button type="button" disabled>
                I can
              </button>{" "}
              <Link href={`/board#${date.id}`}>Mark yourself available for this day first</Link>.
            </p>
          )}
          {state === "past" && <p data-status="past">This race has started.</p>}
        </section>
      )}
    </main>
  );
}
