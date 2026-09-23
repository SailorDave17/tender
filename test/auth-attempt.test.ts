import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PGlite } from "@electric-sql/pglite";
import {
  ATTEMPT_WINDOW_MS,
  EMAIL_ATTEMPT_LIMIT,
  IP_ATTEMPT_LIMIT,
  keyHash,
  withAttemptLimit,
  type AttemptStore,
} from "@/auth/attempt-limit";
import { WRONG_CODE } from "@/auth/join";
import { as, freshDb } from "./pglite";

/**
 * 0032 — auth_attempt, begin_auth_attempt() and settle_auth_attempt() (story #206), and AC 1
 * through them: the Nth failure in the window is refused with a wrong code's own answer, and the
 * next attempt after the window is let through.
 *
 * ## Why AC 1 is proven HERE and not with a fake store
 *
 * The limit is two halves that have to agree: `withAttemptLimit` decides what counts and what a
 * refusal looks like, and 0032 decides the count and the boundary. A fake store would prove the
 * first half against the author's idea of the second. So the store below is 0032's functions run
 * as the service role on the harness, with the real wrapper on top — the same pair the routes use,
 * minus PostgREST.
 *
 * ## What it cannot prove
 *
 * pglite is ONE connection, so two reservations here never overlap and the advisory lock is never
 * contended. The lock is taken (asserted below by reading the function body), and the concurrent
 * half is measured on a real Postgres and recorded on the story, as 0030's was.
 *
 * ## The instants are literals, and every key is fresh
 *
 * `now` is injected, so nothing is relative to the wall clock. Each case uses its own address and
 * email: a limit is a suppression window, and a case that reuses a key reads the previous case's
 * rows as well as its own (cairn: a-suppression-window-makes-every-later-probe-vacuous).
 */

const T0 = new Date("2026-09-23T14:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms);

let db: PGlite;
beforeAll(async () => {
  db = await freshDb();
});
afterAll(async () => {
  await db.close();
});

const lit = (v: string | null) => (v === null ? "null" : `'${v}'`);

/** 0032's two functions, as the service role, behind the interface the routes use. */
const harnessStore: AttemptStore = {
  async begin(a) {
    const r = await as(
      db,
      "service_role",
      `select public.begin_auth_attempt(${lit(a.gate)}, array[${a.gates.map(lit).join(",")}]::text[],
         ${lit(a.ipHash)}, ${lit(a.emailHash)}, '${a.at.toISOString()}'::timestamptz,
         '${a.since.toISOString()}'::timestamptz, ${a.ipLimit}, ${a.emailLimit}) as id`,
    );
    return (r.rows[0] as { id: string | null }).id;
  },
  async settle(id) {
    await as(db, "service_role", `select public.settle_auth_attempt('${id}')`);
  },
};

/** The join gate's shape: a wrong code is the failure, and WRONG_CODE the refusal. */
function tryJoin(ip: string, email: string, outcome: "wrong" | "ok", now: Date) {
  let ran = false;
  const answer = withAttemptLimit({
    gate: "join",
    ip,
    email,
    store: harnessStore,
    now: () => now,
    refusal: WRONG_CODE as { status: number; body: { message: string } },
    isFailure: (r) => r.status === WRONG_CODE.status,
    attempt: async () => {
      ran = true;
      return outcome === "wrong" ? WRONG_CODE : { status: 200, body: { message: "welcome" } };
    },
  });
  return answer.then((result) => ({ result, ran }));
}

async function rows(where: string): Promise<number> {
  const r = await db.query<{ n: number }>(`select count(*)::int as n from public.auth_attempt where ${where}`);
  return r.rows[0].n;
}

describe("0032 — shape and grants", () => {
  it("both functions are invoker's rights, volatile, with search_path pinned", async () => {
    const r = await db.query<{ proname: string; prosecdef: boolean; proconfig: string[]; provolatile: string }>(
      `select proname, prosecdef, proconfig, provolatile from pg_proc
        where proname in ('begin_auth_attempt', 'settle_auth_attempt') order by proname`,
    );
    expect(r.rows).toEqual([
      { proname: "begin_auth_attempt", prosecdef: false, proconfig: ['search_path=""'], provolatile: "v" },
      { proname: "settle_auth_attempt", prosecdef: false, proconfig: ['search_path=""'], provolatile: "v" },
    ]);
  });

  it("begin takes both keys' advisory locks, address first, before it counts anything", async () => {
    const r = await db.query<{ src: string }>(`select prosrc as src from pg_proc where proname = 'begin_auth_attempt'`);
    const src = r.rows[0].src;
    const ip = src.indexOf("auth_attempt:ip:");
    const email = src.indexOf("auth_attempt:email:");
    expect(ip).toBeGreaterThan(-1);
    expect(email).toBeGreaterThan(ip);
    expect(src.indexOf("count(*)")).toBeGreaterThan(email);
    expect(src).toMatch(/pg_advisory_xact_lock/);
  });

  it("anon and authenticated may call neither function; the service role may", async () => {
    const begin = `select public.begin_auth_attempt('forgot', array['forgot'], '${keyHash("grants")}', null, now(), now() - interval '15 minutes', 1, 1)`;
    for (const role of ["anon", "authenticated"] as const) {
      await expect(as(db, role, begin, "11111111-1111-4111-8111-111111111111")).rejects.toThrow(
        /permission denied for function begin_auth_attempt/,
      );
      await expect(
        as(db, role, `select public.settle_auth_attempt('00000000-0000-0000-0000-000000000000')`),
      ).rejects.toThrow(/permission denied for function settle_auth_attempt/);
    }
    // Positive control on the same call: the refusals are the grant, not a broken query.
    const r = await as(db, "service_role", begin + " as id");
    expect((r.rows[0] as { id: string | null }).id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("no client role reads or writes the table; the service role reads it", async () => {
    for (const role of ["anon", "authenticated"] as const) {
      await expect(as(db, role, `select count(*) from public.auth_attempt`)).rejects.toThrow(
        /permission denied for table auth_attempt/,
      );
      await expect(
        as(db, role, `insert into public.auth_attempt (gate, ip_hash, at) values ('join', '${keyHash("x")}', now())`),
      ).rejects.toThrow(/permission denied for table auth_attempt/);
    }
    const r = await as(db, "service_role", `select count(*)::int as n from public.auth_attempt where ip_hash = '${keyHash("grants")}'`);
    expect((r.rows[0] as { n: number }).n).toBe(1);
  });

  it("row level security is on, with no policy", async () => {
    const r = await db.query<{ rls: boolean; policies: number }>(
      `select c.relrowsecurity as rls, (select count(*)::int from pg_policies p where p.tablename = 'auth_attempt') as policies
         from pg_class c where c.oid = 'public.auth_attempt'::regclass`,
    );
    expect(r.rows).toEqual([{ rls: true, policies: 0 }]);
  });

  it("stores digests only: a raw address or email is refused by the table", async () => {
    await expect(
      as(db, "service_role", `insert into public.auth_attempt (gate, ip_hash, at) values ('join', '203.0.113.9', now())`),
    ).rejects.toThrow(/auth_attempt_ip_hash_check/);
    await expect(
      as(db, "service_role", `insert into public.auth_attempt (gate, ip_hash, email_hash, at)
                                values ('join', '${keyHash("x")}', 'jamie@example.com', now())`),
    ).rejects.toThrow(/auth_attempt_email_hash_check/);
  });

  it("creates no sequence, so 0015's sweep still has nothing to sweep", async () => {
    const r = await db.query<{ n: number }>(`select count(*)::int as n from pg_class where relkind = 'S' and relnamespace = 'public'::regnamespace`);
    expect(r.rows[0].n).toBe(0);
  });
});

describe("AC 1 — the Nth failure is refused as a wrong code, and the window lets the next one through", () => {
  it(`per source address: ${IP_ATTEMPT_LIMIT} wrong codes are answered by the gate, the next is refused without it`, async () => {
    const ip = "198.51.100.1";
    for (let i = 0; i < IP_ATTEMPT_LIMIT; i++) {
      // A fresh email each time, so only the address key can be what refuses.
      const { result, ran } = await tryJoin(ip, `guess${i}@example.com`, "wrong", at(i * 1000));
      expect(ran, `attempt ${i + 1} reached the gate`).toBe(true);
      expect(result).toEqual(WRONG_CODE);
    }
    const refused = await tryJoin(ip, "fresh@example.com", "ok", at(IP_ATTEMPT_LIMIT * 1000));
    expect(refused.ran, "the limited attempt never reached the gate").toBe(false);
    // Status and body both: the refusal must be indistinguishable from a wrong code.
    expect(refused.result).toEqual(WRONG_CODE);
  });

  it("...and at exactly one window after the FIRST failure, that failure has lapsed and the next attempt is let through", async () => {
    const ip = "198.51.100.1";
    // The first failure was at T0; `since` is now - window, and a row at or before `since` has lapsed.
    const back = await tryJoin(ip, "back@example.com", "ok", at(ATTEMPT_WINDOW_MS));
    expect(back.ran).toBe(true);
    expect(back.result.status).toBe(200);
  });

  it("one millisecond short of that, it is still refused", async () => {
    const ip = "198.51.100.2";
    for (let i = 0; i < IP_ATTEMPT_LIMIT; i++) await tryJoin(ip, `g${i}@example.com`, "wrong", T0);
    const early = await tryJoin(ip, "early@example.com", "ok", at(ATTEMPT_WINDOW_MS - 1));
    expect(early.ran).toBe(false);
    expect(early.result).toEqual(WRONG_CODE);
  });

  it(`per email address: ${EMAIL_ATTEMPT_LIMIT} failures from rotating addresses, then refused from a new one`, async () => {
    const email = "target@example.com";
    for (let i = 0; i < EMAIL_ATTEMPT_LIMIT; i++) {
      const { ran } = await tryJoin(`203.0.113.${i + 1}`, email, "wrong", at(i));
      expect(ran).toBe(true);
    }
    const refused = await tryJoin("203.0.113.200", email, "ok", at(EMAIL_ATTEMPT_LIMIT));
    expect(refused.ran).toBe(false);
    expect(refused.result).toEqual(WRONG_CODE);
    // The email key is normalised the way join() normalises it, so case and spaces do not reset it.
    const shouted = await tryJoin("203.0.113.201", "  TARGET@Example.com ", "ok", at(EMAIL_ATTEMPT_LIMIT + 1));
    expect(shouted.ran).toBe(false);
  });

  it("a success is settled and does not count: a member's good attempts never add up to a lockout", async () => {
    const ip = "198.51.100.3";
    for (let i = 0; i < IP_ATTEMPT_LIMIT * 2; i++) {
      const { ran, result } = await tryJoin(ip, `member${i}@example.com`, "ok", at(i));
      expect(ran).toBe(true);
      expect(result.status).toBe(200);
    }
    expect(await rows(`ip_hash = '${keyHash(ip)}'`)).toBe(0);
  });

  it("a refused attempt writes nothing, so members retrying do not keep a limited address locked", async () => {
    const ip = "198.51.100.2";
    const before = await rows(`ip_hash = '${keyHash(ip)}'`);
    await tryJoin(ip, "again@example.com", "ok", at(ATTEMPT_WINDOW_MS - 2));
    expect(await rows(`ip_hash = '${keyHash(ip)}'`)).toBe(before);
  });

  it("the forgot screen has a budget of its own and does not spend the guessing gates'", async () => {
    const ip = "198.51.100.4";
    const forgot = (n: number) =>
      withAttemptLimit({
        gate: "forgot",
        ip,
        store: harnessStore,
        now: () => at(n),
        refusal: "limited" as string,
        isFailure: () => true,
        attempt: async () => "sent",
      });
    for (let i = 0; i < IP_ATTEMPT_LIMIT; i++) expect(await forgot(i)).toBe("sent");
    expect(await forgot(IP_ATTEMPT_LIMIT)).toBe("limited");
    // The same address can still try an invite code: forgot's rows are not the gates' rows.
    const join = await tryJoin(ip, "someone@example.com", "ok", at(IP_ATTEMPT_LIMIT + 1));
    expect(join.ran).toBe(true);
  });

  it("stores neither the address nor the email, and prunes lapsed rows on the next begin", async () => {
    const all = await db.query<{ ip_hash: string; email_hash: string | null }>(`select ip_hash, email_hash from public.auth_attempt`);
    const text = JSON.stringify(all.rows);
    expect(all.rows.length, "the table is non-empty, so the absence below is not vacuous").toBeGreaterThan(0);
    expect(text).not.toMatch(/198\.51\.100|203\.0\.113|example\.com/);
    // Everything above is inside one window of T0; a begin two windows later deletes all of it.
    await tryJoin("192.0.2.1", "later@example.com", "ok", at(ATTEMPT_WINDOW_MS * 2 + 1));
    expect(await rows(`at <= '${at(ATTEMPT_WINDOW_MS + 1).toISOString()}'::timestamptz`)).toBe(0);
  });
});
