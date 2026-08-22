"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { UUID, parsePostForm } from "@/post/post-form";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * A skipper's two writes on a post: post a need, close it. Both through the cookie-bound
 * client, so 0006's policies decide — only the boat's owner inserts (against a published date
 * that has not started) or closes, whatever this code believes about the caller. A crafted
 * POST for someone else's boat gets 42501; a close on someone else's post matches zero rows,
 * which is read as a refusal and not a success.
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
  const { error } = await client.from("post").insert({
    boat_id: parsed.boatId,
    race_date_id: parsed.raceDateId,
    minimum: parsed.minimum,
    note: parsed.note,
  });
  // 23505 is the unique (boat_id, race_date_id) pair: that boat already has a post for that day.
  if (error) redirect(back(error.code === "23505" ? "duplicate" : "refused"));

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
