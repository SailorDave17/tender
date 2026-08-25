import type { PGlite } from "@electric-sql/pglite";
import { poolForDate } from "@/board/post-view";
import type { Crew } from "@/engine/ladder";
import type { PersonRow } from "@/engine/toCrew";
import type { NewSuggestion, Suggested, TickPost, TickRepo } from "@/engine/tick";
import { emailDayStart, type DispatchStore, type LogEntry, type Pending } from "@/notify/rung";

/**
 * The TickRepo over pglite — AC 1's first adapter, and the one the behaviour fixtures run
 * through, plus the DispatchStore the same fixtures need to count emails.
 *
 * WHY A SECOND ADAPTER AT ALL. `src/engine/tick-store.ts` is the one that ships, and no test can
 * run it: it speaks to PostgREST. A fake in its place would be a test double written by the same
 * hand as the code under test, so it could not disagree with me about anything (cairn:
 * a-fake-cannot-disagree-with-its-author-2026-08-24). This one is not a fake — it is real SQL
 * against a real Postgres carrying the real migrations, so 0010's primary key really refuses a
 * duplicate suggestion, 0010's trigger really refuses a narrowed rung, and 0012's grants really
 * decide what the service role may write. The claims those enforce are the ones a hand-written
 * store would have quietly granted itself.
 *
 * What it is still blind to is what the harness is always blind to: how PostgREST spells a join,
 * and any grant the live project has that no migration makes. That half is `npm run check:live`
 * and the local-stack run in the story's verification.
 *
 * Bind parameters rather than `as()` from ./pglite, which takes none. An adapter that
 * interpolated ids into SQL would be the one piece of this story written to a lower standard
 * than the code it stands in for.
 */

async function svc<T>(db: PGlite, sql: string, params: unknown[] = []): Promise<T[]> {
  await db.exec(`set role service_role;`);
  try {
    return (await db.query<T>(sql, params)).rows;
  } finally {
    await db.exec(`reset role;`);
  }
}

type PostRow = {
  id: string;
  race_date_id: string;
  minimum: 1 | 2 | 3 | 4;
  current_rung: 1 | 2 | 3;
  closed_at: string | null;
  boat_name: string;
  boat_class: string;
  starts_at: string;
  title: string;
};

export function pgliteTickRepo(db: PGlite): TickRepo {
  return {
    async openPosts(now: Date): Promise<TickPost[]> {
      // One clause covers closed AND matched: accept_answer() (0008) sets closed_at in the same
      // transaction as the match, and test/tick.test.ts asserts that invariant so this stays
      // honest. `starts_at > $1` is what `now` is for.
      const rows = await svc<PostRow>(
        db,
        `select p.id, p.race_date_id, p.minimum, p.current_rung, p.closed_at,
                b.name as boat_name, b.class as boat_class, r.starts_at, r.title
           from public.post p
           join public.boat b on b.id = p.boat_id
           join public.race_date r on r.id = p.race_date_id
          where p.closed_at is null
            and r.starts_at > $1
          order by p.created_at`,
        [now.toISOString()],
      );
      return rows.map((row) => ({
        id: row.id,
        raceDateId: row.race_date_id,
        boatClass: row.boat_class,
        boatName: row.boat_name,
        minimum: row.minimum,
        startsAt: new Date(row.starts_at).toISOString(),
        dateTitle: row.title,
        currentRung: row.current_rung,
        closedAt: row.closed_at,
      }));
    },

    async poolFor(raceDateId: string): Promise<Crew[]> {
      const people = await svc<PersonRow>(db, `select id, rating, any_hull, hulls from public.person`);
      const availability = await svc<{ person_id: string; race_date_id: string }>(
        db,
        `select person_id, race_date_id from public.availability where race_date_id = $1`,
        [raceDateId],
      );
      return poolForDate(people, availability, raceDateId);
    },

    async suggestionsFor(postId: string): Promise<Suggested[]> {
      const rows = await svc<{ person_id: string; rung: 1 | 2 | 3 }>(
        db,
        `select person_id, rung from public.suggestion where post_id = $1`,
        [postId],
      );
      return rows.map((r) => ({ personId: r.person_id, rung: r.rung }));
    },

    async setRung(postId: string, rung: 1 | 2 | 3): Promise<void> {
      await svc(db, `update public.post set current_rung = $2 where id = $1`, [postId, rung]);
    },

    async insertSuggestions(rows: NewSuggestion[]): Promise<void> {
      if (rows.length === 0) return;
      const values = rows.map((_, i) => `($${i * 3 + 1}::uuid, $${i * 3 + 2}::uuid, $${i * 3 + 3}::smallint)`).join(", ");
      await svc(
        db,
        `insert into public.suggestion (post_id, person_id, rung) values ${values}
           on conflict (post_id, person_id) do nothing`,
        rows.flatMap((r) => [r.postId, r.personId, r.rung]),
      );
    },
  };
}

/**
 * The sending half's store, over the same database — so a fixture can assert who was emailed and
 * that a second pass emails nobody, against the real `suggestion.notified_at` and the real
 * `notification_log` rather than against an in-memory count.
 */
export function pgliteDispatchStore(db: PGlite): DispatchStore {
  return {
    async pending(postId: string): Promise<Pending[]> {
      const rows = await svc<{ person_id: string; rung: 1 | 2 | 3; email: string | null }>(
        db,
        `select s.person_id, s.rung, c.email
           from public.suggestion s
           left join public.person_contact c on c.person_id = s.person_id
          where s.post_id = $1 and s.notified_at is null
          order by s.rung, s.created_at`,
        [postId],
      );
      return rows.map((r) => ({ personId: r.person_id, rung: r.rung, email: r.email }));
    },

    async emailsSentToday(now: Date): Promise<number> {
      const rows = await svc<{ n: number }>(
        db,
        `select count(*)::int as n from public.notification_log
          where channel = 'email' and kind = 'rung_email' and sent_at >= $1`,
        [emailDayStart(now).toISOString()],
      );
      return rows[0]?.n ?? 0;
    },

    async log(entry: LogEntry): Promise<void> {
      await svc(
        db,
        `insert into public.notification_log (kind, channel, person_id, to_email, post_id, provider_id, error)
         values ($1, $2, $3, $4, $5, $6, $7)`,
        [entry.kind, entry.channel, entry.personId, entry.toEmail, entry.postId, entry.providerId, entry.error],
      );
    },

    async markNotified(postId: string, personId: string, at: Date): Promise<void> {
      await svc(db, `update public.suggestion set notified_at = $3 where post_id = $1 and person_id = $2`, [
        postId,
        personId,
        at.toISOString(),
      ]);
    },
  };
}
