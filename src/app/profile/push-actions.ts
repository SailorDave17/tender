"use server";

import { revalidatePath } from "next/cache";
import { parseSubscription, type SubscriptionInput } from "@/push/subscribe";
import { supabaseServer } from "@/lib/supabase/server";

/**
 * Store or remove one device's push subscription for the signed-in person (story #29 AC 1).
 *
 * Both writes go through the cookie-bound client, so `0013`'s policies decide whose rows change:
 * the insert's `with check (person_id = auth.uid())` refuses a crafted call naming somebody
 * else's id, and the delete's `using` clause means an endpoint that is not the caller's matches
 * zero rows. The `person_id` below comes from the session and never from the request — the
 * database checking it a second time is the point, not belt and braces.
 *
 * These return a result rather than redirecting, because the caller is a client component in the
 * middle of a browser permission flow: it has already asked for permission and made the
 * subscription, and it needs to know whether the row landed so it can undo the browser half if
 * not. A redirect would lose that.
 */

export type PushActionResult = { ok: true } | { ok: false; reason: string };

export async function savePushSubscription(input: SubscriptionInput): Promise<PushActionResult> {
  const parsed = parseSubscription(input);
  if (!parsed.ok) return { ok: false, reason: parsed.reason };

  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) return { ok: false, reason: "signed-out" };

  const { error } = await client.from("push_subscription").insert({
    person_id: user.id,
    endpoint: parsed.endpoint,
    p256dh: parsed.p256dh,
    auth: parsed.auth,
  });
  // 23505 is the endpoint already being stored — the same device subscribing twice, which is
  // the state the person asked for. Anything else is a refusal.
  if (error && error.code !== "23505") return { ok: false, reason: "refused" };

  revalidatePath("/profile");
  return { ok: true };
}

export async function deletePushSubscription(endpoint: string): Promise<PushActionResult> {
  const client = await supabaseServer();
  const {
    data: { user },
  } = await client.auth.getUser();
  if (!user) return { ok: false, reason: "signed-out" };

  // No person_id filter here on purpose: 0013's delete policy is `person_id = auth.uid()`, so
  // this can only ever reach the caller's own row. Adding the filter would hide a policy that
  // had been widened by mistake — the whole point of letting the database decide.
  const { error } = await client.from("push_subscription").delete().eq("endpoint", endpoint);
  if (error) return { ok: false, reason: "refused" };

  revalidatePath("/profile");
  return { ok: true };
}
