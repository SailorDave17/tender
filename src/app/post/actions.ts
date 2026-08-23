"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { answerState } from "@/post/answer-rules";
import { UUID, parsePostForm } from "@/post/post-form";
import { supabaseServer } from "@/lib/supabase/server";
import { notifyRungLive } from "@/notify/live";

/**
 * A skipper's two writes on a post: post a need, close it. Both through the cookie-bound
 * client, so 0006's policies decide — only the boat's owner inserts (against a published date
 * that has not started) or closes, whatever this code believes about the caller. A crafted
 * POST for someone else's boat gets 42501; a close on someone else's post matches zero rows,
 * which is read as a refusal and not a success.
 *
 * And a crew's two: answer a post, withdraw the answer (story #20). The state the page
 * rendered is decided again here from the database's view (answer-rules.ts) before the write,
 * and 0007's policies decide a third time — an answer from someone not available for the date,
 * or on a closed post, is 42501 whatever the form said.
 *
 * And the skipper's third: accept one answer (story #21). Nothing is decided here at all —
 * accept_answer() (0008) is a definer function that takes the skipper from auth.uid(), checks
 * the post is theirs and the answer is live, writes the match and closes the post in one
 * transaction, and raises otherwise. A second acceptance on the same post is 23505 (one match
 * per post, the first stands) and is reported as such.
 *
 * And the one side effect that is not a row the caller owns: once a post is inserted, the
 * open rung's crew are proposed and emailed (story #23, src/notify/rung.ts). That runs after
 * the insert succeeded and as the service role, and a failure in it never undoes the post.
 */

function field(formData: FormData, name: string): string {
  const v = formData.get(name);
  return typeof v === "string" ? v : "";
}

export async function createPost(formData: FormData): Promise<void> {
  const boatId = field(formData, "boat_id");
  // TypeScript narrows after a bare redirect() but not after a helper that calls it, so the
  // helper only builds the URL.
  const back = (reason: string) => `/post/new?${UUID.test(boatId) ? `boat=${boatId}&` : ""}error=${reason}`;

  const parsed = parsePostForm({
    boatId,
    raceDateId: field(formData, "race_date_id"),
    minimum: field(formData, "minimum"),
    note: field(formData, "note"),
  });
  if (!parsed.ok) redirect(back(parsed.reason));

  const client = await supabaseServer();
  const { data: created, error } = await client
    .from("post")
    .insert({
      boat_id: parsed.boatId,
      race_date_id: parsed.raceDateId,
      minimum: parsed.minimum,
      note: parsed.note,
    })
    .select("id")
    .single();
  // 23505 is the unique (boat_id, race_date_id) pair: that boat already has a post for that day.
  if (error || !created) redirect(back(error?.code === "23505" ? "duplicate" : "refused"));

  await notifyRungLive(created.id);

  revalidatePath("/board");
  redirect("/board");
}

export async function closePost(formData: FormData): Promise<void> {
  const id = field(formData, "id");
  if (!UUID.test(id)) redirect("/board?error=refused");

  const client = await supabaseServer();
  const { error, count } = await client
    .from("post")
    .update({ closed_at: new Date().toISOString() }, { count: "exact" })
    .eq("id", id)
    .is("closed_at", null);
  if (error || !count) redirect(`/post/${id}?error=refused`);

  revalidatePath("/board");
  revalidatePath(`/post/${id}`);
  redirect("/board");
}

export async function answerPost(formData: FormData): Promise<void> {
  const id = field(formData, "post_id");
  const answer = field(formData, "answer") === "true";
  if (!UUID.test(id)) redirect("/board?error=refused");
  const back = (reason: string) => `/post/${id}?error=${reason}`;

  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) redirect("/join");

  // The post as the caller may read it (published date), then the three facts the rule needs.
  const { data: post } = await client.from("post").select("id, race_date_id, closed_at").eq("id", id).maybeSingle();
  if (!post) redirect(back("refused"));
  const [{ data: date }, { data: available }, { data: mine }] = await Promise.all([
    client.from("race_date").select("starts_at").eq("id", post.race_date_id).maybeSingle(),
    client.from("availability").select("race_date_id").eq("person_id", user.id).eq("race_date_id", post.race_date_id).maybeSingle(),
    client.from("answer").select("withdrawn_at").eq("post_id", id).eq("person_id", user.id).maybeSingle(),
  ]);
  if (!date) redirect(back("refused"));
  const state = answerState(
    post,
    date,
    { answered: mine !== null && mine.withdrawn_at === null, available: available !== null },
    new Date(),
  );

  if (answer) {
    if (state === "answered") redirect(`/post/${id}`); // a double tap: already the state asked for
    if (state === "unavailable") redirect(back("not-available"));
    if (state !== "can") redirect(back(state));
    if (mine === null) {
      const { error } = await client.from("answer").insert({ post_id: id, person_id: user.id });
      if (error) redirect(back("refused"));
    } else {
      // Answering again after a withdrawal clears withdrawn_at; 0007 holds it to the same rule.
      const { error, count } = await client
        .from("answer")
        .update({ withdrawn_at: null }, { count: "exact" })
        .eq("post_id", id)
        .eq("person_id", user.id);
      if (error || !count) redirect(back("refused"));
    }
  } else {
    if (state !== "answered") redirect(back(state === "can" || state === "unavailable" ? "refused" : state));
    const { error, count } = await client
      .from("answer")
      .update({ withdrawn_at: new Date().toISOString() }, { count: "exact" })
      .eq("post_id", id)
      .eq("person_id", user.id)
      .is("withdrawn_at", null);
    // Zero rows is a refusal (no such answer, or not theirs), not a success.
    if (error || !count) redirect(back("refused"));
  }

  revalidatePath("/board");
  revalidatePath(`/post/${id}`);
  redirect(`/post/${id}`);
}

export async function acceptAnswer(formData: FormData): Promise<void> {
  const id = field(formData, "post_id");
  const personId = field(formData, "person_id");
  if (!UUID.test(id)) redirect("/board?error=refused");
  if (!UUID.test(personId)) redirect(`/post/${id}?error=refused`);

  const client = await supabaseServer();
  const { error } = await client.rpc("accept_answer", { post_id: id, person_id: personId });
  if (error) redirect(`/post/${id}?error=${error.code === "23505" ? "matched" : "refused"}`);

  revalidatePath("/board");
  revalidatePath(`/post/${id}`);
  redirect(`/post/${id}`);
}
