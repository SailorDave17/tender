import "server-only";
import { poolForDate } from "@/board/post-view";
import type { PersonRow } from "@/engine/toCrew";
import { supabaseAdmin } from "@/lib/supabase/admin";
import { KIND_ANSWER, type AnswerPost, type AnswerStore } from "./answer";
import type { ConfirmMatch, ConfirmStore } from "./confirm";
import type { InviteStore } from "./invite";
import { EMAIL_ATTEMPT_KINDS } from "./kinds";
import type { MatchStore } from "./match";
import { KIND_MESSAGE, KIND_MESSAGE_SUPPRESSED, type MessageStore } from "./message";
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

/**
 * The MatchStore over the live database, as the service role (story #33). Same division of
 * labour again: every rule is in notifyMatch(), this only reads and writes. The one read the
 * earlier stores do not make — the match row's two parties — is what 0018's
 * `grant select on public.match to service_role` exists for.
 */
export function supabaseMatchStore(): MatchStore {
  const admin = supabaseAdmin();
  return {
    async post(postId): Promise<RungPost | null> {
      const { data, error } = await admin
        .from("post")
        .select("id, race_date_id, minimum, current_rung, closed_at, boat:boat_id (name, class), race_date:race_date_id (starts_at, title)")
        .eq("id", postId)
        .maybeSingle();
      if (error) fail("read post for match", error);
      if (!data) return null;
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

    async matchByPost(postId) {
      const { data, error } = await admin.from("match").select("skipper_id, crew_id").eq("post_id", postId).maybeSingle();
      if (error) fail("read match", error);
      return data ? { skipperId: data.skipper_id, crewId: data.crew_id } : null;
    },

    async name(personId) {
      const { data, error } = await admin.from("person").select("display_name").eq("id", personId).maybeSingle();
      if (error) fail("read person name", error);
      return data?.display_name ?? null;
    },

    async email(personId) {
      const { data, error } = await admin.from("person_contact").select("email").eq("person_id", personId).maybeSingle();
      if (error) fail("read match contact", error);
      return data?.email ?? null;
    },

    async emailsSentToday(now) {
      // Every attempt kind, from the one list (src/notify/kinds.ts), unlike supabaseRungStore()'s
      // rung_email-only count: the cap is Resend's, which counts every send, so the widest count
      // available is the honest one here. (The rung store's narrower count predates the other
      // kinds and is noted on #33 rather than changed by it; this list stopped at three kinds
      // until #37's fan-out found the three stores disagreeing.)
      const { count, error } = await admin
        .from("notification_log")
        .select("id", { count: "exact", head: true })
        .eq("channel", "email")
        .in("kind", EMAIL_ATTEMPT_KINDS)
        .gte("sent_at", emailDayStart(now).toISOString());
      if (error) fail("count today's email for match", error);
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
  };
}

/**
 * The MessageStore over the live database, as the service role (story #35). Same division of
 * labour as the three above: every rule is in notifyMessage(), this only reads and writes.
 * 0020's `grant select on public.message to service_role` is what the first two reads need —
 * stated in that migration rather than inherited, because the local image grants a new table's
 * service_role no DML at all while the hosted project has been measured granting ALL.
 *
 * Every lookup here is a separate round trip rather than an embed. That is deliberate: a
 * PostgREST filter naming an embedded resource is applied to the EMBED and not to the parent,
 * so the parent row still comes back with the embed set to null — which every schema-derived
 * type says is impossible, and which no SQL harness can reproduce (cairn:
 * postgrest-filtering-on-an-embedded-resource). Two reads that cannot lie beat one that can.
 */
export function supabaseMessageStore(): MessageStore {
  const admin = supabaseAdmin();
  return {
    async message(messageId) {
      const { data, error } = await admin
        .from("message")
        .select("id, match_id, author_id, body")
        .eq("id", messageId)
        .maybeSingle();
      if (error) fail("read message", error);
      if (!data) return null;
      // The post the match sits on — notification_log keys every row by post, and the email's
      // copy needs the boat and the race date. A second read, for the reason in the docstring.
      const { data: m, error: mErr } = await admin
        .from("match")
        .select("post_id")
        .eq("id", data.match_id)
        .maybeSingle();
      if (mErr) fail("read match for message", mErr);
      if (!m) return null;
      return { id: data.id, matchId: data.match_id, authorId: data.author_id, body: data.body, postId: m.post_id };
    },

    async parties(matchId) {
      const { data, error } = await admin.from("match").select("skipper_id, crew_id").eq("id", matchId).maybeSingle();
      if (error) fail("read match parties", error);
      return data ? { skipperId: data.skipper_id, crewId: data.crew_id } : null;
    },

    async post(postId): Promise<RungPost | null> {
      const { data, error } = await admin
        .from("post")
        .select("id, race_date_id, minimum, current_rung, closed_at, boat:boat_id (name, class), race_date:race_date_id (starts_at, title)")
        .eq("id", postId)
        .maybeSingle();
      if (error) fail("read post for message", error);
      if (!data) return null;
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

    async name(personId) {
      const { data, error } = await admin.from("person").select("display_name").eq("id", personId).maybeSingle();
      if (error) fail("read author name", error);
      return data?.display_name ?? null;
    },

    async email(personId) {
      const { data, error } = await admin.from("person_contact").select("email").eq("person_id", personId).maybeSingle();
      if (error) fail("read message contact", error);
      return data?.email ?? null;
    },

    async lastMessageEmailAt(matchId, personId) {
      // Successful sends only (error null): a refused send must not start a quiet window, the
      // same rule supabaseAnswerStore().lastAnswerEmailAt applies for the same reason.
      //
      // Scoped by person AND by the thread's post, because notification_log has no match_id —
      // it keys by post, and a match has exactly one post (0008's unique constraint), so the
      // post id identifies the thread. The caller passes the match id it knows; resolving it to
      // the post here keeps that mapping in one place.
      const postId = await postOfMatch(admin, matchId);
      if (postId === null) return null;
      const { data, error } = await admin
        .from("notification_log")
        .select("sent_at")
        .eq("kind", KIND_MESSAGE)
        .eq("channel", "email")
        .eq("post_id", postId)
        .eq("person_id", personId)
        .is("error", null)
        .order("sent_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) fail("read last message email", error);
      return data ? new Date(data.sent_at) : null;
    },

    async lastMessageAttemptAt(matchId, personId) {
      // Every attempt, successful or refused — no `error` filter, which is the whole difference
      // from lastMessageEmailAt above. KIND_MESSAGE only: a no-address row is not an attempt on
      // the provider and must not defer a retry that could now succeed.
      const postId = await postOfMatch(admin, matchId);
      if (postId === null) return null;
      const { data, error } = await admin
        .from("notification_log")
        .select("sent_at")
        .eq("kind", KIND_MESSAGE)
        .eq("channel", "email")
        .eq("post_id", postId)
        .eq("person_id", personId)
        .order("sent_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) fail("read last message attempt", error);
      return data ? new Date(data.sent_at) : null;
    },

    async suppressedSince(matchId, personId, since) {
      const postId = await postOfMatch(admin, matchId);
      if (postId === null) return 0;
      // `error is null` excludes the cap-skipped rows, which carry error 'daily cap': a send the
      // cap refused is not a suppression the backstop should count toward forcing another send.
      let q = admin
        .from("notification_log")
        .select("id", { count: "exact", head: true })
        .eq("kind", KIND_MESSAGE_SUPPRESSED)
        .eq("channel", "email")
        .eq("post_id", postId)
        .eq("person_id", personId)
        .is("error", null);
      if (since) q = q.gte("sent_at", since.toISOString());
      const { count, error } = await q;
      if (error) fail("count suppressed messages", error);
      return count ?? 0;
    },

    async pushTargets(personId) {
      const { data, error } = await admin
        .from("push_subscription")
        .select("id, endpoint, p256dh, auth")
        .eq("person_id", personId);
      if (error) fail("read message subscriptions", error);
      return data ?? [];
    },

    async deleteSubscription(id) {
      const { error } = await admin.from("push_subscription").delete().eq("id", id);
      if (error) fail("delete subscription", error);
    },

    async emailsSentToday(now) {
      // Every attempt kind, from the one list the match and confirm stores read too.
      const { count, error } = await admin
        .from("notification_log")
        .select("id", { count: "exact", head: true })
        .eq("channel", "email")
        .in("kind", EMAIL_ATTEMPT_KINDS)
        .gte("sent_at", emailDayStart(now).toISOString());
      if (error) fail("count today's email for message", error);
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
  };
}

/**
 * The ConfirmStore over the live database, as the service role (story #37). Same division of
 * labour as the four above: every rule is in remindCrew() / notifyConfirmed(), this only reads
 * and writes. The one write the earlier stores do not make — `match.reminded_at` — is what
 * 0021's `grant update (reminded_at) on public.match to service_role` exists for, and the
 * match read is 0018's.
 */
export function supabaseConfirmStore(): ConfirmStore {
  const admin = supabaseAdmin();
  return {
    async match(matchId): Promise<ConfirmMatch | null> {
      const { data, error } = await admin
        .from("match")
        .select("id, post_id, skipper_id, crew_id, status")
        .eq("id", matchId)
        .maybeSingle();
      if (error) fail("read match for confirm", error);
      return data ? { id: data.id, postId: data.post_id, skipperId: data.skipper_id, crewId: data.crew_id, status: data.status } : null;
    },

    async post(postId): Promise<RungPost | null> {
      const { data, error } = await admin
        .from("post")
        .select("id, race_date_id, minimum, current_rung, closed_at, boat:boat_id (name, class), race_date:race_date_id (starts_at, title)")
        .eq("id", postId)
        .maybeSingle();
      if (error) fail("read post for confirm", error);
      if (!data) return null;
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

    async name(personId) {
      const { data, error } = await admin.from("person").select("display_name").eq("id", personId).maybeSingle();
      if (error) fail("read person name for confirm", error);
      return data?.display_name ?? null;
    },

    async email(personId) {
      const { data, error } = await admin.from("person_contact").select("email").eq("person_id", personId).maybeSingle();
      if (error) fail("read confirm contact", error);
      return data?.email ?? null;
    },

    async pushTargets(personId) {
      const { data, error } = await admin
        .from("push_subscription")
        .select("id, endpoint, p256dh, auth")
        .eq("person_id", personId);
      if (error) fail("read confirm subscriptions", error);
      return data ?? [];
    },

    async deleteSubscription(id) {
      const { error } = await admin.from("push_subscription").delete().eq("id", id);
      if (error) fail("delete subscription", error);
    },

    async emailsSentToday(now) {
      // Every attempt kind, from the one list the match and message stores read too.
      const { count, error } = await admin
        .from("notification_log")
        .select("id", { count: "exact", head: true })
        .eq("channel", "email")
        .in("kind", EMAIL_ATTEMPT_KINDS)
        .gte("sent_at", emailDayStart(now).toISOString());
      if (error) fail("count today's email for confirm", error);
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

    async markReminded(matchId, at) {
      // Read the write back: an update matching zero rows does not throw, and a match reminded
      // in the log but never marked would be reminded again in fifteen minutes.
      const { data, error } = await admin
        .from("match")
        .update({ reminded_at: at.toISOString() })
        .eq("id", matchId)
        .select("id");
      if (error) fail("mark reminded", error);
      if (!data?.length) fail("mark reminded", { message: `no match ${matchId} to mark` });
    },
  };
}

/**
 * The InviteStore over the live database, as the service role (story #31). Same division of labour
 * as the five above: every rule is in sendInvites(), this only reads and writes.
 *
 * Two of its three reads are ones no earlier store makes, and both are why this runs as the
 * service role rather than as the admin's cookie-bound client:
 *
 *   - `club.invite_code` is withheld from every client role (0003) and read through
 *     `current_invite_code()` by the page. Here it is read directly, as /api/join does.
 *   - `person_contact.email` across the WHOLE club (AC 3). 0002 reveals a contact row to its own
 *     person and a match's counterparty only, so no caller — admin included — can ask "which of
 *     these fifty addresses is already a member". The admin's authority to ask is established by
 *     the page (notFound() for a non-admin) and by the action re-checking `is_admin` on the
 *     caller's own client before this store is built; the answer it gets back is a set of
 *     addresses the admin already typed, never a list of the club's members.
 */
export function supabaseInviteStore(): InviteStore {
  const admin = supabaseAdmin();
  return {
    async inviteCode() {
      const { data, error } = await admin.from("club").select("invite_code").limit(1).single();
      if (error || !data) fail("read invite code", error);
      return data.invite_code as string;
    },

    async members(emails) {
      if (emails.length === 0) return new Set<string>();
      // `members_among()` (0022) does the matching in Postgres, against a `lower(email)` index,
      // and returns only the addresses the caller asked about. Two reasons it is a function rather
      // than a filter here:
      //
      //   - PostgREST cannot express `lower(col) in (…)`. An `in` on the lowercased list is
      //     compared against the STORED spelling, so a member who signed up as Dave@Example.org is
      //     silently missed — and a missed skip re-invites somebody who then hits /join's 409.
      //   - The alternative is selecting every contact row and matching in JS, which answers a
      //     question about fifty addresses by reading the whole club's PII.
      //
      // So what comes back is an answer, not a table: nothing about a member who was not pasted is
      // learnable through it.
      const { data, error } = await admin.rpc("members_among", { p_emails: emails });
      if (error) fail("read member addresses", error);
      return new Set((data ?? []).map((e: string) => String(e).toLowerCase()));
    },

    async emailsSentToday(now) {
      // Every attempt kind, from the one list the match, message and confirm stores read too.
      const { count, error } = await admin
        .from("notification_log")
        .select("id", { count: "exact", head: true })
        .eq("channel", "email")
        .in("kind", EMAIL_ATTEMPT_KINDS)
        .gte("sent_at", emailDayStart(now).toISOString());
      if (error) fail("count today's email for invite", error);
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
  };
}

/** The post a match sits on — one per match (0008's unique post_id). Null when the match is gone. */
async function postOfMatch(admin: ReturnType<typeof supabaseAdmin>, matchId: string): Promise<string | null> {
  const { data, error } = await admin.from("match").select("post_id").eq("id", matchId).maybeSingle();
  if (error) fail("read post of match", error);
  return data?.post_id ?? null;
}
