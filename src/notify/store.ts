import "server-only";
import { poolForDate } from "@/board/post-view";
import type { PersonRow } from "@/engine/toCrew";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { KIND_ANSWER, type AnswerPost, type AnswerStore } from "./answer";
import { KIND_RUNG_EMAIL, emailDayStart, type LogEntry, type Pending, type PendingPush, type RungPost, type RungStore } from "./rung";

/**
 * The RungStore over the live database, as the service role — the only role that may write
 * suggestion, notification_log or post.current_rung (0010). Nothing here decides anything:
 * every rule is in notifyRung(), which is unit-tested against an in-memory store, and this file
 * is proven on a running stack (the complete-story overlay's third instrument).
 *
 * Why the service role rather than the caller's cookie-bound client: a crew's suggestion row
 * and the email log are the system's record, not the skipper's — the skipper holds no grant on
 * either table and should not. The reads go the same way for one reason only: the pool must
 * be every available crew on the date, which the caller can already see (0005 reads are
 * authenticated-wide), and the emails must be everyone's, which the caller cannot (0002/0008
 * reveal contact to self and a match's counterparty only).
 */

function fail(what: string, error: { message: string } | null): never {
  throw new Error(`notify store: ${what}: ${error?.message ?? "unknown error"}`);
}

export function supabaseRungStore(): RungStore {
  const admin = supabaseAdmin();
  return {
    async post(postId): Promise<RungPost | null> {
      const { data, error } = await admin
        .from("post")
        .select("id, race_date_id, minimum, current_rung, closed_at, boat:boat_id (name, class), race_date:race_date_id (starts_at, title)")
        .eq("id", postId)
        .maybeSingle();
      if (error) fail("read post", error);
      if (!data) return null;
      // PostgREST embeds a to-one relation as an object; the typing says object-or-array, so narrow.
      const boat = (Array.isArray(data.boat) ? data.boat[0] : data.boat) as { name: string; class: string };
      const date = (Array.isArray(data.race_date) ? data.race_date[0] : data.race_date) as { starts_at: string; title: string };
      return {
        id: data.id,
        raceDateId: data.race_date_id,
        boatClass: boat.class,
        boatName: boat.name,
        minimum: data.minimum,
        startsAt: date.starts_at,
        dateTitle: date.title,
        currentRung: data.current_rung,
        closedAt: data.closed_at,
      };
    },

    async pool(raceDateId) {
      const [people, availability] = await Promise.all([
        admin.from("person").select("id, rating, any_hull, hulls"),
        admin.from("availability").select("person_id, race_date_id").eq("race_date_id", raceDateId),
      ]);
      if (people.error) fail("read people", people.error);
      if (availability.error) fail("read availability", availability.error);
      return poolForDate(people.data as PersonRow[], availability.data, raceDateId);
    },

    async raiseRung(postId, rung) {
      const { error } = await admin.from("post").update({ current_rung: rung }).eq("id", postId);
      if (error) fail("raise rung", error);
    },

    async addSuggestions(rows) {
      const { error } = await admin
        .from("suggestion")
        .upsert(
          rows.map((r) => ({ post_id: r.postId, person_id: r.personId, rung: r.rung })),
          { onConflict: "post_id,person_id", ignoreDuplicates: true },
        );
      if (error) fail("add suggestions", error);
    },

    async pending(postId): Promise<Pending[]> {
      const { data, error } = await admin
        .from("suggestion")
        .select("person_id, rung")
        .eq("post_id", postId)
        .is("notified_at", null)
        .order("rung")
        .order("created_at");
      if (error) fail("read pending", error);
      if (!data?.length) return [];
      const ids = data.map((s) => s.person_id);
      const contacts = await admin.from("person_contact").select("person_id, email").in("person_id", ids);
      if (contacts.error) fail("read contacts", contacts.error);
      const email = new Map(contacts.data.map((c) => [c.person_id, c.email]));
      return data.map((s) => ({ personId: s.person_id, rung: s.rung, email: email.get(s.person_id) ?? null }));
    },

    async emailsSentToday(now) {
      const { count, error } = await admin
        .from("notification_log")
        .select("id", { count: "exact", head: true })
        .eq("channel", "email")
        .eq("kind", KIND_RUNG_EMAIL)
        .gte("sent_at", emailDayStart(now).toISOString());
      if (error) fail("count today's email", error);
      return count ?? 0;
    },

    async log(entry: LogEntry) {
      const { error } = await admin.from("notification_log").insert({
        kind: entry.kind,
        channel: entry.channel,
        person_id: entry.personId,
        to_email: entry.toEmail,
        post_id: entry.postId,
        provider_id: entry.providerId,
        error: entry.error,
      });
      if (error) fail("log", error);
    },

    async markNotified(postId, personId, at) {
      const { error } = await admin
        .from("suggestion")
        .update({ notified_at: at.toISOString() })
        .eq("post_id", postId)
        .eq("person_id", personId);
      if (error) fail("mark notified", error);
    },

    async pendingPush(postId): Promise<PendingPush[]> {
      const { data, error } = await admin
        .from("suggestion")
        .select("person_id, rung")
        .eq("post_id", postId)
        .is("pushed_at", null)
        .order("rung")
        .order("created_at");
      if (error) fail("read pending push", error);
      if (!data?.length) return [];
      // Two round trips rather than an embed, for the same reason `pending` takes two: the
      // relation is person → subscription, not suggestion → subscription, so PostgREST has no
      // foreign key to walk from here (cairn: postgrest-filtering-on-an-embedded-resource).
      const ids = data.map((s) => s.person_id);
      const subs = await admin
        .from("push_subscription")
        .select("id, person_id, endpoint, p256dh, auth")
        .in("person_id", ids);
      if (subs.error) fail("read subscriptions", subs.error);
      const byPerson = new Map<string, PendingPush["targets"]>();
      for (const s of subs.data) {
        const list = byPerson.get(s.person_id) ?? [];
        list.push({ id: s.id, endpoint: s.endpoint, p256dh: s.p256dh, auth: s.auth });
        byPerson.set(s.person_id, list);
      }
      // A person with no subscription is not pending a push at all — they are dropped here
      // rather than returned with an empty list, so the dispatch loop never marks somebody
      // pushed who has no device.
      return data
        .map((s) => ({ personId: s.person_id, rung: s.rung, targets: byPerson.get(s.person_id) ?? [] }))
        .filter((p) => p.targets.length > 0);
    },

    async markPushed(postId, personId, at) {
      const { error } = await admin
        .from("suggestion")
        .update({ pushed_at: at.toISOString() })
        .eq("post_id", postId)
        .eq("person_id", personId);
      if (error) fail("mark pushed", error);
    },

    async deleteSubscription(id) {
      const { error } = await admin.from("push_subscription").delete().eq("id", id);
      if (error) fail("delete subscription", error);
    },
  };
}

/**
 * The AnswerStore over the live database, as the service role (story #24). Same division of
 * labour as supabaseRungStore() above: every rule is in notifyAnswer(), this only reads and
 * writes. The one read the rung store does not make — counting `answer` rows — is what 0014's
 * `grant select on public.answer to service_role` exists for.
 */
export function supabaseAnswerStore(): AnswerStore {
  const admin = supabaseAdmin();
  return {
    async post(postId): Promise<AnswerPost | null> {
      const { data, error } = await admin
        .from("post")
        .select("id, race_date_id, minimum, current_rung, closed_at, boat:boat_id (name, class, owner_id), race_date:race_date_id (starts_at, title)")
        .eq("id", postId)
        .maybeSingle();
      if (error) fail("read post for answer", error);
      if (!data) return null;
      const boat = (Array.isArray(data.boat) ? data.boat[0] : data.boat) as { name: string; class: string; owner_id: string };
      const date = (Array.isArray(data.race_date) ? data.race_date[0] : data.race_date) as { starts_at: string; title: string };
      return {
        id: data.id,
        raceDateId: data.race_date_id,
        boatClass: boat.class,
        boatName: boat.name,
        minimum: data.minimum,
        startsAt: date.starts_at,
        dateTitle: date.title,
        currentRung: data.current_rung,
        closedAt: data.closed_at,
        skipperId: boat.owner_id,
      };
    },

    async liveAnswers(postId) {
      const { count, error } = await admin
        .from("answer")
        .select("post_id", { count: "exact", head: true })
        .eq("post_id", postId)
        .is("withdrawn_at", null);
      if (error) fail("count answers", error);
      return count ?? 0;
    },

    async lastAnswerEmailAt(postId) {
      // Successful sends only (error null): a refused send must not start a quiet window.
      const { data, error } = await admin
        .from("notification_log")
        .select("sent_at")
        .eq("kind", KIND_ANSWER)
        .eq("channel", "email")
        .eq("post_id", postId)
        .is("error", null)
        .order("sent_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) fail("read last answer email", error);
      return data ? new Date(data.sent_at) : null;
    },

    async email(personId) {
      const { data, error } = await admin.from("person_contact").select("email").eq("person_id", personId).maybeSingle();
      if (error) fail("read skipper contact", error);
      return data?.email ?? null;
    },

    async pushTargets(personId) {
      const { data, error } = await admin
        .from("push_subscription")
        .select("id, endpoint, p256dh, auth")
        .eq("person_id", personId);
      if (error) fail("read skipper subscriptions", error);
      return data ?? [];
    },

    async deleteSubscription(id) {
      const { error } = await admin.from("push_subscription").delete().eq("id", id);
      if (error) fail("delete subscription", error);
    },

    async log(entry: LogEntry) {
      const { error } = await admin.from("notification_log").insert({
        kind: entry.kind,
        channel: entry.channel,
        person_id: entry.personId,
        to_email: entry.toEmail,
        post_id: entry.postId,
        provider_id: entry.providerId,
        error: entry.error,
      });
      if (error) fail("log", error);
    },
  };
}
