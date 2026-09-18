import type { PGlite } from "@electric-sql/pglite";
import type { MorningMatch, MorningOfRepo } from "@/engine/morningOf";
import type { ConfirmMatch, ConfirmStore } from "@/notify/confirm";
import { emailDayStart, type LogEntry } from "@/notify/rung";

/**
 * The MorningOfRepo and the ConfirmStore over pglite (story #37) — the adapters the behaviour
 * fixtures in morning-of.test.ts run through, for the same reason test/tick-repo.ts exists: the
 * shipping adapters speak to PostgREST and no test can run them, and a fake in their place is a
 * double written by the same hand as the code under test (cairn:
 * a-fake-cannot-disagree-with-its-author). This is real SQL against the real migrations, so
 * 0021's `grant update (reminded_at)` really decides whether the mark lands, and 0018's select
 * really decides whether the candidates can be read.
 *
 * Bind parameters rather than `as()` from ./pglite, which takes none.
 */

async function svc<T>(db: PGlite, sql: string, params: unknown[] = []): Promise<T[]> {
  await db.exec(`set role service_role;`);
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec(`reset role;`);
  }
}

type CandidateRow = {
  id: string;
  skipper_id: string;
  crew_id: string;
  post_id: string;
  race_date_id: string;
  minimum: 1 | 2 | 3 | 4;
  current_rung: 1 | 2 | 3;
  closed_at: string | null;
  boat_name: string;
  boat_class: string;
  starts_at: string;
  title: string;
};

function postOf(row: CandidateRow) {
  return {
    id: row.post_id,
    raceDateId: row.race_date_id,
    boatClass: row.boat_class,
    boatName: row.boat_name,
    minimum: row.minimum,
    startsAt: new Date(row.starts_at).toISOString(),
    dateTitle: row.title,
    currentRung: row.current_rung,
    closedAt: row.closed_at,
  };
}

const POST_SELECT = `
  p.id as post_id, p.race_date_id, p.minimum, p.current_rung, p.closed_at,
  b.name as boat_name, b.class as boat_class, r.starts_at, r.title
    from public.post p
    join public.boat b on b.id = p.boat_id
    join public.race_date r on r.id = p.race_date_id`;

export function pgliteMorningOfRepo(db: PGlite): MorningOfRepo {
  return {
    async candidates(): Promise<MorningMatch[]> {
      // The same two columns the live adapter filters on, and no time filter — the engine decides.
      const rows = await svc<CandidateRow>(
        db,
        `select m.id, m.skipper_id, m.crew_id, ${POST_SELECT}
           join public.match m on m.post_id = p.id
          where m.status = 'accepted' and m.reminded_at is null
          order by r.starts_at, m.accepted_at`,
      );
      return rows.map((row) => ({ id: row.id, skipperId: row.skipper_id, crewId: row.crew_id, post: postOf(row) }));
    },
  };
}

export function pgliteConfirmStore(db: PGlite): ConfirmStore {
  return {
    async match(matchId): Promise<ConfirmMatch | null> {
      const rows = await svc<{ id: string; post_id: string; skipper_id: string; crew_id: string; status: string }>(
        db,
        `select id, post_id, skipper_id, crew_id, status from public.match where id = $1`,
        [matchId],
      );
      const r = rows[0];
      return r ? { id: r.id, postId: r.post_id, skipperId: r.skipper_id, crewId: r.crew_id, status: r.status } : null;
    },

    async post(postId) {
      const rows = await svc<CandidateRow>(db, `select ${POST_SELECT} where p.id = $1`, [postId]);
      return rows[0] ? postOf(rows[0]) : null;
    },

    async name(personId) {
      const rows = await svc<{ display_name: string }>(db, `select display_name from public.person where id = $1`, [personId]);
      return rows[0]?.display_name ?? null;
    },

    async email(personId) {
      const rows = await svc<{ email: string }>(db, `select email from public.person_contact where person_id = $1`, [personId]);
      return rows[0]?.email ?? null;
    },

    async pushTargets(personId) {
      return svc<{ id: string; endpoint: string; p256dh: string; auth: string }>(
        db,
        `select id, endpoint, p256dh, auth from public.push_subscription where person_id = $1 order by created_at`,
        [personId],
      );
    },

    async deleteSubscription(id) {
      await svc(db, `delete from public.push_subscription where id = $1`, [id]);
    },

    async emailsSentToday(now) {
      const rows = await svc<{ n: number }>(
        db,
        `select count(*)::int as n from public.notification_log where channel = 'email' and sent_at >= $1`,
        [emailDayStart(now).toISOString()],
      );
      return rows[0]?.n ?? 0;
    },

    async log(entry: LogEntry) {
      await svc(
        db,
        `insert into public.notification_log (kind, channel, person_id, to_email, post_id, provider_id, error)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [entry.kind, entry.channel, entry.personId, entry.toEmail, entry.postId, entry.providerId, entry.error],
      );
    },

    async markReminded(matchId, at) {
      // As the service role, so 0021's column grant is what decides — and read back, so a write
      // RLS or a missing grant silently refused cannot pass as a mark (the overlay's rule).
      const rows = await svc<{ id: string }>(db, `update public.match set reminded_at = $2 where id = $1 returning id`, [
        matchId,
        at.toISOString(),
      ]);
      if (rows.length !== 1) throw new Error(`markReminded(${matchId}) updated ${rows.length} rows`);
    },
  };
}
