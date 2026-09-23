import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { loadBoardData } from "@/board/load";
import { candidateRows, poolForDate, viewPost } from "@/board/post-view";
import { formatStartsAt } from "@/dates/race-date";
import { toCrew } from "@/engine/toCrew";
import { answerState, explainAnswerRefusal } from "@/post/answer-rules";
import { CandidateList, RungBadge } from "@/post/CandidateList";
import { MatchPanel, type Contact, type StatusForm } from "@/post/MatchPanel";
import { FORMER_MEMBER, counterpartyOf, explainAcceptRefusal, explainStatusRefusal, matchControls } from "@/post/match-view";
import { UUID, explainPostRefusal } from "@/post/post-form";
import { ratingLabel, type Skill } from "@/profile/profile";
import { supabaseServer } from "@/lib/supabase/server";
import { acceptAnswer, answerPost, closePost, setMatchStatus } from "../actions";
import { SIGN_IN_URL } from "@/auth/gate";

export const dynamic = "force-dynamic";

/**
 * /post/[id] — one post (story #19 AC 5, AC 6; story #20 AC 2–4; story #21 AC 5). Everyone
 * signed in sees the need: boat, date, minimum, note, its open rung, and how many have
 * answered. The boat's owner also sees every available crew for that date coloured by rung —
 * those who answered first, badged, each with an Accept button — and the Close button. Anyone
 * else sees their own answer state: I can, Withdraw, or I can disabled with a link to mark the
 * day first (answer-rules.ts decides which).
 *
 * Once the skipper accepts, the post is matched: the skipper and the accepted crew each see
 * 'Matched' with the other's name, email and phone, read through RLS as themselves (0008's
 * person_contact policy hands a party the counterparty's row and anyone else nothing), and
 * MatchPanel renders contact only to a party whatever it is handed. Everyone else sees the boat
 * crewed, with both names.
 *
 * Ownership is decided here from the boat row the viewer can read; the database decides it
 * again on Close (0006's update policy), on every answer (0007) and inside accept_answer()
 * (0008), so a forged form gets zero rows or 42501, never a write it should not have had.
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
  if (!user) redirect(SIGN_IN_URL);

  const data = await loadBoardData(client);
  // 0024's list, for the candidate rows' competence text. Read here rather than in loadBoardData
  // because /board shows no competence label and should not pay for the round trip.
  const { data: skillRows } = await client.from("skill").select("code, label, level, sort").order("sort");
  const post = data.posts.find((p) => p.id === id);
  if (!post) notFound();
  const boat = data.boats.get(post.boat_id);
  const date = data.dates.find((d) => d.id === post.race_date_id);
  if (!boat || !date) notFound();
  const { error } = await searchParams;

  const now = new Date();
  const input = { starts_at: date.starts_at, boatClass: boat.class, minimum: post.minimum, current_rung: post.current_rung };
  const pool = poolForDate([...data.people.values()], data.availability, date.id);
  const view = viewPost(input, pool, now);
  const own = boat.owner_id === user.id;
  const f = formatStartsAt(date.starts_at);
  const closed = post.closed_at !== null;
  const match = data.matches.get(post.id) ?? null;
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

  // The counterparty's contact, read as the viewer: RLS returns the row to a party and nothing
  // to anyone else — and the read is only made for a party at all.
  const counterparty = match ? counterpartyOf(match, user.id) : null;
  let contact: Contact | null = null;
  if (counterparty) {
    const { data: row } = await client.from("person_contact").select("email, phone").eq("person_id", counterparty).maybeSingle();
    contact = row ?? null;
  }
  const names = new Map([...data.people.values()].map((p) => [p.id, p.display_name]));

  // The status buttons (story #37): decided here from the clock, decided again by 0021's
  // definer on the tap. The forms are built here because the action needs a request.
  const controls = match ? matchControls(match, date.starts_at, user.id, now) : undefined;
  const statusForm: StatusForm = (status, label) => (
    <form action={setMatchStatus} data-inline>
      <input type="hidden" name="match_id" value={match!.id} />
      <input type="hidden" name="post_id" value={post.id} />
      <input type="hidden" name="status" value={status} />
      <button type="submit" data-set-status={status}>
        {label}
      </button>
    </form>
  );

  const explain = (reason: string) =>
    reason === "status-refused"
      ? explainStatusRefusal(reason)
      : own
        ? reason === "matched" || reason === "refused"
          ? explainAcceptRefusal(reason)
          : explainPostRefusal(reason)
        : explainAnswerRefusal(reason);

  return (
    <main>
      <p>
        <Link href="/board">Back to the board</Link>
      </p>
      <h1>
        {boat.name} needs crew — {f.date}
      </h1>
      <p data-post={post.id} data-closed={closed} data-matched={match !== null}>
        {boat.class}, {f.time}, {date.title}. Skipper:{" "}
        {boat.owner_id ? (
          <Link href={`/profile/${boat.owner_id}`}>{data.people.get(boat.owner_id)?.display_name ?? "someone"}</Link>
        ) : (
          // The owner deleted their account (0027): the boat stays as the name on its posts.
          <span data-former-member>{FORMER_MEMBER}</span>
        )}
        .
        Minimum: {ratingLabel(post.minimum).toLowerCase()}.
      </p>
      {post.note && <blockquote>{post.note}</blockquote>}
      {match ? (
        <MatchPanel match={match} viewerId={user.id} names={names} contact={contact} controls={controls} statusForm={statusForm} />
      ) : closed ? (
        <p data-status="closed">
          <strong>Closed.</strong> This need is no longer on the board.
        </p>
      ) : (
        <p>
          Open at <RungBadge rung={view.rung} colour={view.colour} /> — {view.candidateCount}{" "}
          {view.candidateCount === 1 ? "crew" : "crew"} on or above it.
        </p>
      )}
      {error && <p role="alert">{explain(error)}</p>}

      {match ? null : own ? (
        <>
          <h2>Who can sail that day</h2>
          <CandidateList
            rows={candidateRows(input, [...pool, ...answerersGone], now, answered)}
            people={data.people}
            skills={(skillRows ?? []) as Skill[]}
            accept={(personId) => (
              <form action={acceptAnswer} data-inline>
                <input type="hidden" name="post_id" value={post.id} />
                <input type="hidden" name="person_id" value={personId} />
                <button type="submit" data-accept={personId}>
                  Accept
                </button>
              </form>
            )}
          />
          {!closed && (
            <form action={closePost} data-gap-top>
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
