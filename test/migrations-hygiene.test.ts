import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { EXPECTED_FUNCTIONS, EXPECTED_TABLES } from "../scripts/check-live-expected.mjs";
import { MESSAGE_BODY_MAX } from "../src/post/thread-view";
import { freshDb } from "./pglite";

/** A uuid that matches no match and no person — so an insert reaches the FK and stops there. */
const NIL_MATCH = "00000000-0000-4000-8000-000000000000";

/**
 * Two facts about the migration set that are otherwise held by hand.
 *
 * 1. The migrations record nothing from which a person's years can be inferred (story #14 AC 1).
 *    Read as files rather than through git so the check is the same under CI and locally.
 * 2. `scripts/check-live-expected.mjs`'s EXPECTED_TABLES is the set of tables the migrations
 *    create, and its EXPECTED_FUNCTIONS is the set of functions the client calls by RPC with the
 *    argument names it sends — copies of facts the migrations and src/ already hold, which is the
 *    class that drifts (cairn: a-computable-claim-does-not-belong-in-prose-2026-08-07). They live
 *    in their own module because the runner probes and exits at import.
 */

const MIGRATIONS = join(process.cwd(), "supabase", "migrations");

describe("supabase/migrations — no way to infer how old a person is", () => {
  it("mentions none of the usual spellings", async () => {
    const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
    expect(files.length).toBeGreaterThan(0);
    const hits: string[] = [];
    for (const f of files) {
      const text = await readFile(join(MIGRATIONS, f), "utf8");
      text.split("\n").forEach((line, i) => {
        if (/date_of_birth|birth|\bage\b/i.test(line)) hits.push(`${f}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});

describe("check:live expects exactly the tables the migrations create", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("EXPECTED_TABLES equals public's tables in the harness", async () => {
    const r = await db.query<{ tablename: string }>(
      `select tablename from pg_tables where schemaname = 'public' order by tablename`,
    );
    const created = r.rows.map((x) => x.tablename);
    expect(created.length).toBeGreaterThan(0);
    expect([...EXPECTED_TABLES].sort()).toEqual(created);
  });

  // The message body cap (story #35) is one rule with three enforcement points — the textarea's
  // maxLength, the server action's refusal, and 0020's check constraint, which is the only one a
  // direct POST cannot bypass. They are held equal here because a cap that drifts apart reads as
  // working from every surface a person can see (cairn:
  // a-computable-claim-does-not-belong-in-prose).
  it("MESSAGE_BODY_MAX equals the length 0020's check constraint actually enforces", async () => {
    const ok = "x".repeat(MESSAGE_BODY_MAX);
    const over = "x".repeat(MESSAGE_BODY_MAX + 1);
    // Asked of the constraint itself rather than of the migration's text: a regex over the SQL
    // would pass on a file whose literal was right and whose constraint was never created.
    const check = await db.query<{ def: string }>(
      `select pg_get_constraintdef(oid) as def from pg_constraint
        where conrelid = 'public.message'::regclass and contype = 'c'`,
    );
    expect(check.rows).toHaveLength(1);
    expect(check.rows[0]?.def).toContain(String(MESSAGE_BODY_MAX));

    // And measured, so the number in the definition is the number in force. Run as the table's
    // OWNER (the harness superuser, no `set role`), because the subject here is the CHECK and
    // nothing else: 0020 grants service_role select only — it is a reader, not a writer — so a
    // `set role service_role` insert is refused for a reason that has nothing to do with length.
    // That is not a flaw in the grant; message.test.ts asserts exactly that grant on purpose,
    // and the first draft of this test tripped over it, which is the grant doing its job.
    await expect(
      db.query(`insert into public.message (match_id, author_id, body)
                  values ('${NIL_MATCH}', '${NIL_MATCH}', '${over}')`),
    ).rejects.toThrow(/violates check/i);
    // The at-the-limit control has to fail on the FOREIGN KEY rather than the check, which is
    // what proves the length was accepted: seeding a real match here would duplicate
    // message.test.ts's fixture for no gain. Two different errors is the whole assertion — one
    // shared `rejects.toThrow()` would pass with the check missing.
    await expect(
      db.query(`insert into public.message (match_id, author_id, body)
                  values ('${NIL_MATCH}', '${NIL_MATCH}', '${ok}')`),
    ).rejects.toThrow(/foreign key/i);
  });

  // Every .rpc("name", { args }) in a source text, with the argument NAMES it passes — the keys
  // of the object literal, whether written `post_id: id` or shorthand `{ post_ids }`. The probe
  // must carry exactly the client's set: PostgREST resolves an overload by the set of argument
  // names, so a function present under other names answers PGRST202 — the same as one that is
  // missing (cairn: postgrest-probing-a-live-project-2026-08-16).
  function parseRpcCalls(text: string): Map<string, string[]> {
    const calls = new Map<string, string[]>();
    for (const m of text.matchAll(/\.rpc\(\s*["']([a-z_]+)["']\s*(?:,\s*\{([^}]*)\})?/g)) {
      const names = (m[2] ?? "")
        .split(",")
        .map((part) => part.split(":")[0].trim())
        .filter(Boolean)
        .sort();
      calls.set(m[1], names);
    }
    return calls;
  }

  async function rpcCallsInSrc(): Promise<Map<string, string[]>> {
    const files: string[] = [];
    async function walk(dir: string) {
      for (const e of await readdir(dir, { withFileTypes: true })) {
        const f = join(dir, e.name);
        if (e.isDirectory()) await walk(f);
        else if (/\.(ts|tsx|mjs)$/.test(e.name) && !/\.test\./.test(e.name)) files.push(f);
      }
    }
    await walk(join(process.cwd(), "src"));
    const calls = new Map<string, string[]>();
    for (const f of files) for (const [name, args] of parseRpcCalls(await readFile(f, "utf8"))) calls.set(name, args);
    return calls;
  }

  it("the rpc-call scanner finds a call with arguments, a bare call, and a shorthand property", () => {
    // Proven on a fixture first, because src/ could hold zero rpc calls and an empty scan is
    // not a pass (cairn: a-mutation-certifies-the-corpus-not-the-guard-2026-08-20). The values
    // are deliberately not bare identifiers that could be mistaken for keys.
    const fixture = [
      `await client.rpc("accept_answer", { post_id: id, person_id: personId });`,
      `const r = await client.rpc("current_invite_code");`,
      `await client.rpc("answer_counts", { post_ids })`,
      `client.rpc("f", { a: rows.map((r) => r.id), b })`,
    ].join("\n");
    expect([...parseRpcCalls(fixture)]).toEqual([
      ["accept_answer", ["person_id", "post_id"]],
      ["current_invite_code", []],
      ["answer_counts", ["post_ids"]],
      ["f", ["a", "b"]],
    ]);
  });

  it("EXPECTED_FUNCTIONS is exactly the set of rpc calls in src/, with the argument names they send", async () => {
    const calls = await rpcCallsInSrc();
    expect(calls.size).toBeGreaterThan(0);
    const expected = new Map(EXPECTED_FUNCTIONS.map((f) => [f.name, Object.keys(f.args).sort()]));
    expect([...expected].sort()).toEqual([...calls].sort());
  });

  it("every EXPECTED_FUNCTIONS entry exists in the harness with exactly those INPUT argument names", async () => {
    // The identity arguments, not proargnames: a `returns table (…)` function lists its OUT
    // columns in proargnames too, and PostgREST resolves on the inputs alone.
    const r = await db.query<{ proname: string; args: string }>(
      `select p.proname, pg_get_function_identity_arguments(p.oid) as args
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' order by p.proname`,
    );
    const inHarness = new Map(
      r.rows.map((x) => [x.proname, x.args.split(",").map((a) => a.trim().split(/\s+/)[0]).filter(Boolean).sort()]),
    );
    expect(inHarness.get("answer_counts")).toEqual(["post_ids"]); // the parse, on the one with OUT columns
    for (const f of EXPECTED_FUNCTIONS) {
      expect(inHarness.get(f.name), `${f.name} is not a public function`).toEqual(Object.keys(f.args).sort());
    }
  });
});

/**
 * 3. The contact-on-match rule is pure RLS (story #21 AC 3, ADR 003's kill condition). Two
 *    readings, because each is blind to something: the migration text for the literal the AC
 *    names (`security definer` inside a person_contact policy statement), and the catalog for
 *    what the live policy set actually calls — a policy could reach a definer through a
 *    function it names without the words appearing in the statement.
 */
describe("person_contact's read path has no security definer in it (ADR 003 kill condition)", () => {
  let db: PGlite;
  beforeAll(async () => {
    db = await freshDb();
  });
  afterAll(async () => {
    await db.close();
  });

  it("no `create policy … on public.person_contact` statement mentions security definer", async () => {
    const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql")).sort();
    const statements: string[] = [];
    for (const f of files) {
      const text = await readFile(join(MIGRATIONS, f), "utf8");
      // Anchored on the policy's own name: a lazy `create policy …` would span from some other
      // table's policy to the next person_contact one and sweep a function body in between.
      for (const m of text.matchAll(/create policy\s+\w+\s+on public\.person_contact[\s\S]*?;/g)) statements.push(m[0]);
    }
    expect(statements.length).toBeGreaterThanOrEqual(2); // 0002's self-only and 0008's widening
    expect(statements.filter((s) => /security\s+definer/i.test(s))).toEqual([]);
  });

  // Which functions a policy's expressions reference, from pg_depend — the catalog's own record,
  // written when the policy is created. Not a regex over pg_policies.qual: that deparses
  // `public.f(...)` as `f(...)` whenever public is on the search_path, so a pattern expecting a
  // schema-qualified spelling saw no function at all and let a definer through (measured on
  // this test's own mutation pass, story #21).
  const functionsOf = (table: string) =>
    db.query<{ policy: string; cmd: string; fn: string; prosecdef: boolean }>(
      `select pol.polname as policy, pol.polcmd as cmd, n.nspname || '.' || p.proname as fn, p.prosecdef
         from pg_policy pol
         join pg_depend d on d.classid = 'pg_policy'::regclass and d.objid = pol.oid and d.refclassid = 'pg_proc'::regclass
         join pg_proc p on p.oid = d.refobjid
         join pg_namespace n on n.oid = p.pronamespace
        where pol.polrelid = '${table}'::regclass
        order by pol.polname, fn`,
    );

  it("the live person_contact SELECT policy references exactly auth.uid(), and no policy there references a definer", async () => {
    const names = await db.query<{ policyname: string }>(
      `select policyname from pg_policies where schemaname = 'public' and tablename = 'person_contact' order by policyname`,
    );
    expect(names.rows.map((p) => p.policyname)).toEqual(["person_contact_read_self_or_counterparty", "person_contact_update_self"]);
    const deps = await functionsOf("public.person_contact");
    const select = deps.rows.filter((r) => r.cmd === "r");
    expect(select.map((r) => r.fn)).toEqual(["auth.uid"]); // the read path calls nothing else
    expect(deps.rows.filter((r) => r.prosecdef)).toEqual([]); // and nothing on the table is a definer
  });

  it("positive controls: the same read sees a policy's function dependency, and sees a definer", async () => {
    // answer's policies call can_answer() — the dependency read finds it, security invoker.
    const answer = await functionsOf("public.answer");
    expect(answer.rows.map((r) => `${r.fn}:${r.prosecdef}`)).toContain("public.can_answer:false");
    // and prosecdef is visible where it is true: the schema's definers, by name.
    const definers = await db.query<{ fn: string }>(
      `select n.nspname || '.' || p.proname as fn from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosecdef order by fn`,
    );
    expect(definers.rows.map((r) => r.fn)).toEqual([
      "public.accept_answer",
      "public.admin_from_club", // 0009 — trigger functions, not in any read path
      "public.admin_from_contact",
      "public.answer_counts",
      // 0033 (#201) — the person_blank_log trigger function: blanks a deleted person's addresses in
      // notification_log however the person row goes. Definer because a direct service-role delete
      // would otherwise need update on notification_log, which 0010 grants no one. It writes
      // notification_log only, is in no policy, and so is not in person_contact's read path.
      "public.blank_person_log",
      "public.current_invite_code",
      // 0027 (#42) — the one route to deleting a person. Definer because authenticated holds no
      // delete on person (0002) and must not gain one; refuses anyone but the person themself or
      // an admin with 42501 like the ones above. It deletes person_contact by name and then
      // person, and is in no policy, so person_contact's READ path is untouched and the kill
      // condition above holds: the two assertions before this one still pass.
      "public.delete_person",
      // 0026 (#39) — reads notification_log, which 0010 withheld from every client role (revoke
      // all, RLS, no policy), and returns two COUNTS so the admin can see Resend's day and month
      // against their caps without a single row — no address, no recipient, no subject. Admin-
      // gated by raising 42501 like the ones above, and in no policy, so person_contact's read
      // path is untouched and ADR 003's kill condition is intact. It reads no other table.
      "public.email_usage",
      // 0022 (#31) — reads person_contact, which is self-only to every client role, and returns
      // the subset of the addresses it was GIVEN that are members. It is in no policy, so it is
      // not in person_contact's read path and the kill condition above is untouched: the two
      // assertions before this one are what hold that, and they pass. Execute is revoked from
      // public/anon/authenticated by name and granted to service_role alone, so the only caller is
      // the invite store. The narrowing it buys: the alternative was selecting every contact row
      // and matching in the application, and nothing about a member who was not pasted is
      // learnable through this.
      "public.members_among",
      // 0013 (#29) — reads push_subscription, which is self-only to every client role, and
      // returns a COUNT per person so an admin learns who has notifications on without any
      // caller ever receiving an endpoint. Admin-gated by raising 42501, like the two above.
      "public.push_install_status",
      // 0023 (#36) — the one way a message is removed. Definer because authenticated holds no
      // update on message and must not gain one (an update grant is the author's edit path AC 3
      // forbids); admin-gated by raising 42501 like the ones above. It reads and writes message
      // and message_removal only, is in no policy, and so is not in person_contact's read path.
      "public.remove_message",
      "public.rotate_invite_code",
      // 0028 (#41) — the one way the club's pair changes. Definer because no client role holds
      // update on club (0001) and must not gain one; admin-gated by raising 42501 like the ones
      // above, and it refuses a pair under 3:1 in SQL so a bypass of the screen is refused too.
      // It reads and writes club only, is in no policy, and so is not in person_contact's read
      // path. Its helper contrast_ratio() is invoker's rights and is not in this list.
      "public.set_club_theme",
      // 0021 (#37) — the one client route to a match's status: takes the caller from auth.uid(),
      // refuses the wrong party and the wrong time, and lets the transition trigger decide the rest.
      "public.set_match_status",
    ]);
  });
});
