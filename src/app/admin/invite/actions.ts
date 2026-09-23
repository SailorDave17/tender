"use server";

import { redirect } from "next/navigation";
import { sendInvitesLive } from "@/notify/live";
import { supabaseServer } from "@/lib/supabase/server";
import { encodeInviteReport } from "@/notify/invite-report";
import { SIGN_IN_URL } from "@/auth/gate";

/**
 * The admin's one write on the invite list: send the pasted addresses their invite (story #31).
 *
 * THE AUTHORIZATION IS THIS FILE'S OWN WORK, unlike every other admin action here, and that is
 * the one thing worth reading twice. `rotateInviteCode` and the race-date actions run through the
 * cookie-bound client, so Postgres decides — 0003's definer raises 42501 for a non-admin and
 * 0004's policies match zero rows, whatever this code believes about the caller. This action
 * cannot delegate that: it reaches the provider and reads every contact row in the club as the
 * SERVICE ROLE, which bypasses RLS by its nature, so a direct POST with a crew's session would be
 * answered by a database that has been told not to check. The `is_admin` read below, on the
 * caller's OWN client, is therefore load-bearing rather than belt-and-braces — it is the only
 * check between a crew's session and fifty emails sent in the club's name.
 *
 * Read as the caller, not as the service role, and deliberately: 0002 reveals `person.is_admin`
 * to the row's own person, so a forged session reads its own row and gets `false`.
 *
 * The report comes back through the URL rather than through a rendered result, keeping the form a
 * plain HTML form like the rest of /admin — no client JavaScript on a screen used twice a season.
 * `encodeInviteReport` is what bounds it; see that module for why a URL is a safe place to put it.
 */

const INVITE = "/admin/invite";

export async function sendInvitesAction(formData: FormData): Promise<void> {
  const raw = formData.get("addresses");
  const text = typeof raw === "string" ? raw : "";

  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) redirect(SIGN_IN_URL);
  const { data: me } = await client.from("person").select("is_admin").eq("id", user.id).maybeSingle();
  // Not a redirect to an error page: a non-admin is told this screen does not exist, the same
  // answer the page itself gives them (AC 2 of #16's pattern).
  if (!me?.is_admin) redirect("/board");

  // The try wraps ONLY the send, never the redirect. `redirect()` works by throwing a
  // NEXT_REDIRECT error, so a catch around it would swallow the success case and report a
  // refusal on a send that worked — the failure would be a plausible-looking error message on
  // a screen whose emails had all gone out.
  let report: string;
  try {
    report = encodeInviteReport(await sendInvitesLive(text));
  } catch (e) {
    // sendInvitesLive does NOT swallow (see its docstring): a store or origin failure lands here
    // and is reported as a refusal rather than as an empty result, because "nothing was sent"
    // and "everybody was already a member" must not look the same to the admin.
    console.error("sendInvites failed:", e instanceof Error ? e.message : e);
    report = "";
  }
  if (!report) redirect(`${INVITE}?error=refused`);

  // No revalidatePath: nothing this action wrote is rendered anywhere. The invite code is
  // unchanged, and notification_log is read by no page (#43's story).
  redirect(`${INVITE}?report=${report}`);
}
