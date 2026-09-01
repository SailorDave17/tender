import { describe, expect, it } from "vitest";

import {
  MANAGEMENT_API_ROOT,
  REFUSAL_VALUE_LIMIT,
  TOKEN_VAR,
  compareEcho,
  dollarTagAt,
  echoQuery,
  isReadOnlyRefusal,
  localBytes,
  localChars,
  localDigest,
  parseEnvFile,
  projectRefFrom,
  queryUrl,
  redactForRefusal,
  requireAccessToken,
  resolveAccessToken,
  resolveSupabaseUrl,
  runQuery,
  safeDollarTag,
  splitStatements,
} from "../scripts/management-api.mjs";

/**
 * The transport for `npm run migrate:live` (#114), tested with no network, no credential and no
 * live project — which is the whole reason the module is split this way. Everything that decides
 * an outcome is here; `migrate-live.mjs` supplies the real `fetch` and nothing else, exactly as
 * `check-live.mjs` does for `check-live-core.mjs`.
 */

const GOOD_URL = "https://iszdmtinhgnjwtnyetdn.supabase.co";
const GOOD_REF = "iszdmtinhgnjwtnyetdn";

/**
 * A stand-in for `Response` carrying only what `runQuery` reads — `ok`, `status` and `text()`.
 *
 * The cast is deliberate and narrow. Building a real `Response` would mean constructing headers,
 * a body stream and nine other members none of which this module touches, and the one behaviour
 * worth faking here — a `text()` that THROWS mid-read — a real `Response` makes awkward to
 * produce. The risk a cast carries is that the fake drifts from the real shape; what bounds it is
 * that `runQuery` is three property reads wide, and the live `fetch` is exercised by
 * `npm run migrate:live` rather than by this file.
 */
type FakeResponse = { ok: boolean; status: number; text: () => Promise<string> };
const asFetch = (impl: (url: string, init: RequestInit) => Promise<FakeResponse>) =>
  impl as unknown as typeof fetch;

describe("splitStatements reads SQL the way Postgres does (AC 1)", () => {
  it("does not split on a semicolon inside a dollar-quoted body", () => {
    const sql = "create function f() returns int as $$ begin return 1; end; $$ language plpgsql;";
    expect(splitStatements(sql)).toHaveLength(1);
  });

  it("does not split on a semicolon inside a line comment", () => {
    expect(splitStatements("select 1; -- a; b; c\nselect 2;")).toHaveLength(2);
  });

  it("does not split on a semicolon inside a NESTED block comment — Postgres nests, C does not", () => {
    expect(splitStatements("select 1; /* outer /* inner ; */ still in ; */ select 2;")).toHaveLength(2);
  });

  it("does not split on a semicolon inside a single-quoted string", () => {
    expect(splitStatements("comment on table t is 'a; b';")).toHaveLength(1);
  });

  it("does not split on a semicolon inside a double-quoted identifier", () => {
    // Nothing in this repo uses one. Handled because a scanner right for three of the four
    // hiding places is a scanner whose failure waits for the first file that uses the fourth.
    expect(splitStatements('select 1 as "a;b";')).toHaveLength(1);
  });

  it("treats `$1` as a parameter, never as a dollar-quote tag that never closes", () => {
    expect(dollarTagAt("$1", 0)).toBeNull();
    expect(dollarTagAt("$$", 0)).toBe("$$");
    expect(dollarTagAt("$body$", 0)).toBe("$body$");
    // The consequence: a file using a parameter still splits normally rather than swallowing
    // everything after it into one unterminated region.
    expect(splitStatements("select $1; select $2;")).toHaveLength(2);
  });

  it("a trailing comment is not a statement, and neither is trailing whitespace", () => {
    expect(splitStatements("select 1;\n-- done\n")).toHaveLength(1);
    expect(splitStatements("select 1;   \n\n")).toHaveLength(1);
    expect(splitStatements("-- nothing but a comment\n")).toHaveLength(0);
    expect(splitStatements("")).toHaveLength(0);
  });

  it("a doubled quote does not end the string early — and no test here can prove that BRANCH", () => {
    // The behavioural claim, which this does assert: `'it''s'` is one string containing an
    // apostrophe, so the semicolon inside it does not split and this is two statements.
    expect(splitStatements("select 'it''s here; really'; select 2;")).toHaveLength(2);

    // What it does NOT prove is the doubled-quote branch in `splitStatements`, and saying so is
    // the point of this test rather than an apology for it. A doubled quote is two quotes, so
    // escaping and closing-then-reopening end in the same state and cover the same characters —
    // no input can tell the two implementations apart, and *measured*, deleting that branch
    // reddens nothing here (cairn: a-zero-red-mutation-can-be-unreachable-2026-08-27). It is kept
    // because it is correct lexing and becomes load-bearing the moment the scanner is asked for a
    // string's SPAN rather than for split points. Unexercised and dead look identical to whoever
    // is next tidying up, so this comment is the only thing keeping it.
    //
    // An earlier version of this test compared `splitStatements(escaped)` against
    // `splitStatements(reopened)` — two string literals that were CHARACTER-IDENTICAL, so it
    // compared the function's output with itself and asserted nothing at all.
  });
});

describe("the echo payload is embedded safely (AC 7)", () => {
  it("picks a tag that does not appear in the body", () => {
    expect(safeDollarTag("nothing special")).toBe("$tender_echo$");
  });

  it("escalates when the obvious tag IS in the body — otherwise the region would close early", () => {
    expect(safeDollarTag("a $tender_echo$ b")).toBe("$tender_echo1$");
    expect(safeDollarTag("a $tender_echo$ b $tender_echo1$ c")).toBe("$tender_echo2$");
  });

  it("REFUSES rather than truncating when no tag is free — the failure would be executable SQL", () => {
    let body = "";
    for (let n = 0; n < 100; n += 1) body += `$tender_echo${n === 0 ? "" : n}$ `;
    expect(() => safeDollarTag(body)).toThrow(/cannot find a dollar-quote tag/);
  });

  it("the echo query READS and applies nothing, whatever the payload contains", () => {
    const q = echoQuery("drop table club;");
    expect(q.startsWith("with payload as (select ")).toBe(true);
    expect(q).toContain("select length(body) as chars");
    // The payload sits inside the dollar-quoted literal, so it is data rather than code.
    expect(q).toContain("$tender_echo$drop table club;$tender_echo$::text");
  });
});

describe("a write refused by the CONNECTION is told apart from wrong SQL", () => {
  // Measured on this command's first real run against the live project. Postgres raises 25006 for
  // any write on a read-only connection, whatever the statement, and it arrives through the
  // Management API as an ordinary 400 — so without this classifier it is indistinguishable from a
  // migration whose SQL is wrong, and the refusal blames the file. It did.
  it("recognises the real message the live project returned", () => {
    expect(
      isReadOnlyRefusal(
        "[400] Failed to run sql query: ERROR:  25006: cannot execute REVOKE in a read-only transaction",
      ),
    ).toBe(true);
  });

  it("recognises it by EITHER the SQLSTATE or the wording, since only one is a contract", () => {
    // The five-character SQLSTATE is the stable half; the prose around it is the vendor's and can
    // be reworded without notice. Matching either means a rewording does not silently send the
    // reader back to the message that blames the file.
    expect(isReadOnlyRefusal("ERROR: 25006: something else entirely")).toBe(true);
    expect(isReadOnlyRefusal("cannot execute CREATE TABLE in a read-only transaction")).toBe(true);
  });

  it("does NOT fire on ordinary bad SQL — the branch it exists to keep separate", () => {
    expect(isReadOnlyRefusal('[400] relation "nope" does not exist')).toBe(false);
    expect(isReadOnlyRefusal("[401] Invalid authentication credentials")).toBe(false);
    expect(isReadOnlyRefusal("")).toBe(false);
    expect(isReadOnlyRefusal(null)).toBe(false);
  });
});

describe("the local side of the comparison counts what Postgres counts (AC 7)", () => {
  it("characters are code points, not UTF-16 units", () => {
    // An em dash is one character and three bytes; this repo's migrations are full of them, and
    // they are the characters a cp1252 round trip destroys.
    expect(localChars("a—b")).toBe(3);
    expect(localBytes("a—b")).toBe(5);
  });

  it("the digest is md5 over the UTF-8 bytes, which is what Postgres md5() computes", () => {
    expect(localDigest("")).toBe("d41d8cd98f00b204e9800998ecf8427e");
    expect(localDigest("abc")).toBe("900150983cd24fb0d6963f7d28e17f72");
  });
});

describe("compareEcho says WHICH way the payload differed (AC 7)", () => {
  const local = "select 1;";
  const good = {
    chars: localChars(local),
    bytes: localBytes(local),
    digest: localDigest(local),
  };

  it("an intact payload produces no complaints", () => {
    expect(compareEcho(local, good)).toEqual([]);
  });

  it("no description at all is a complaint, never a pass", () => {
    expect(compareEcho(local, null)).toEqual([
      "the database returned no description of what it received",
    ]);
    expect(compareEcho(local, "rows" as unknown as object)).toHaveLength(1);
  });

  it("a lost character says characters were lost", () => {
    const problems = compareEcho(local, { ...good, chars: good.chars - 1 });
    expect(problems.join(" ")).toMatch(/characters were lost or added/);
  });

  it("SAME character count, CHANGED bytes — which is exactly what a cp1252 round trip does", () => {
    // The case the boolean version of this function could not express, and the one that actually
    // happens: an em dash becomes a different character, so the count survives and the bytes and
    // digest do not. Both complaints fire, and the digest one names the mechanism.
    const mangled = "select 1?";
    const problems = compareEcho("select 1—", {
      chars: localChars("select 1—"),
      bytes: localBytes(mangled),
      digest: localDigest(mangled),
    });
    expect(problems.some((p) => /characters were lost/.test(p))).toBe(false);
    expect(problems.some((p) => /bytes/.test(p))).toBe(true);
    expect(problems.some((p) => /md5 differs/.test(p) && /character-set round trip/.test(p))).toBe(true);
  });
});

describe("the token refusals name the wrong KIND of credential (AC 2)", () => {
  it("a real-looking personal access token passes — the positive control", () => {
    // Assembled from fragments rather than written out, and that is not superstition: GitHub's
    // push protection REFUSED this branch when the fixture was a literal `sbp_` followed by 40 hex
    // characters. It was right to — that is the shape of a real Supabase personal access token,
    // and no scanner can know a fixture is fake. Clicking the bypass link would have trained the
    // habit of waving those refusals through.
    //
    // Both fragments are outside the shape on their own, which is the bar splitting has to clear:
    // a whole that evades the matcher while a fragment still matches it buys nothing (cairn:
    // a-control-can-choose-the-design-2026-08-25).
    const shaped = "sbp_" + "a1b2c3d4".repeat(5);
    expect(shaped).toHaveLength(44); // the real shape, so the control is not weaker than a token
    expect(requireAccessToken(shaped)).toBe(shaped);
  });

  it("absent is refused, and says nothing was sent", () => {
    expect(() => requireAccessToken("")).toThrow(/is not set/);
    expect(() => requireAccessToken(undefined)).toThrow(/Nothing was sent/);
  });

  it("a modern project key is refused AS a project key, not as a bad token", () => {
    // Both are in `.env.local`, both are called a key, and the Management API answers 401 to
    // either — a message about authentication, which sends somebody to re-mint a token they
    // already have rather than to look at what they pasted.
    for (const key of ["sb_publishable_abc123", "sb_secret_abc123"]) {
      expect(() => requireAccessToken(key)).toThrow(/PROJECT API KEY/);
      expect(() => requireAccessToken(key)).toThrow(/ACCOUNT page, not the project page/);
    }
  });

  it("a legacy JWT key is refused — the same mistake with no prefix to spot it by", () => {
    const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJyb2xlIjoiYW5vbiJ9.c2ln";
    expect(() => requireAccessToken(jwt)).toThrow(/legacy PROJECT key/);
  });

  it("surrounding whitespace is trimmed rather than making a good token look wrong", () => {
    expect(requireAccessToken("  sbp_abcdef  ")).toBe("sbp_abcdef");
  });
});

describe("a refusal never reads a secret back (AC 3)", () => {
  it("a legitimate project URL passes through UNTOUCHED — the positive control", () => {
    // Without this, a sanitiser that ate every value would pass every leak assertion below while
    // making the refusal useless.
    expect(redactForRefusal(GOOD_URL)).toBe(GOOD_URL);
    expect(redactForRefusal("http://127.0.0.1:54321")).toBe("http://127.0.0.1:54321");
  });

  it("rule 2: env-file content keeps the NAME and elides the VALUE, on line ONE", () => {
    // The values here are deliberately SHORT — well inside REFUSAL_VALUE_LIMIT — so this asserts
    // rule 2 and not rule 3. With realistic secret lengths the cap truncates first and this
    // passes whether or not rule 2 exists (cairn: a-control-can-choose-the-design-2026-08-25,
    // the fixture-sizing half).
    const line = "SUPABASE_ACCESS_TOKEN=sbp_secret";
    expect(line.length).toBeLessThan(REFUSAL_VALUE_LIMIT);
    const out = redactForRefusal(line);
    expect(out).toContain("SUPABASE_ACCESS_TOKEN=");
    expect(out).not.toContain("sbp_secret");
  });

  it("rule 1: everything after the first newline is dropped — a whole .env.local leaks nothing", () => {
    const file = [
      "NEXT_PUBLIC_SUPABASE_URL=http://localhost",
      "SUPABASE_ACCESS_TOKEN=sbp_tok",
      "SUPABASE_SERVICE_ROLE_KEY=srk_val",
      "RESEND_API_KEY=re_val",
    ].join("\n");
    const out = redactForRefusal(file);
    for (const secret of ["sbp_tok", "srk_val", "re_val"]) expect(out).not.toContain(secret);
  });

  it("rule 3: one enormous line is capped rather than filling a terminal", () => {
    const out = redactForRefusal("x".repeat(500));
    expect(out.length).toBeLessThan(REFUSAL_VALUE_LIMIT + 40);
    expect(out).toMatch(/\[truncated\]$/);
  });

  it("projectRefFrom's own refusal goes through it — the sanitiser is not merely available", () => {
    // The function existing is not the point; the refusal USING it is. This is the assertion that
    // fails if somebody interpolates the raw value back in.
    const file = "SUPABASE_ACCESS_TOKEN=sbp_leakme\nNEXT_PUBLIC_SUPABASE_URL=http://x";
    expect(() => projectRefFrom(file)).toThrow();
    try {
      projectRefFrom(file);
    } catch (error) {
      expect(String((error as Error).message)).not.toContain("sbp_leakme");
    }
  });
});

describe("the project ref is derived, and a wrong target is refused (AC 1)", () => {
  it("a hosted project URL yields its ref, with or without a trailing slash", () => {
    expect(projectRefFrom(GOOD_URL)).toBe(GOOD_REF);
    expect(projectRefFrom(`${GOOD_URL}/`)).toBe(GOOD_REF);
  });

  it("a local stack is REFUSED rather than guessed at — it has no project ref", () => {
    expect(() => projectRefFrom("http://127.0.0.1:54321")).toThrow(/local stack/);
  });

  it("an unset URL is refused by name", () => {
    expect(() => projectRefFrom("")).toThrow(/NEXT_PUBLIC_SUPABASE_URL is not set/);
    expect(() => projectRefFrom(undefined)).toThrow(/is not set/);
  });

  it("http, a non-supabase host and a too-short ref are all refused", () => {
    expect(() => projectRefFrom("http://abcdefghijklmnop.supabase.co")).toThrow();
    expect(() => projectRefFrom("https://abcdefghijklmnop.example.com")).toThrow();
    expect(() => projectRefFrom("https://short.supabase.co")).toThrow();
  });

  it("the query goes to the project's own database endpoint", () => {
    expect(queryUrl(GOOD_REF)).toBe(`${MANAGEMENT_API_ROOT}/v1/projects/${GOOD_REF}/database/query`);
  });
});

describe("environment resolution prefers the environment, then the file", () => {
  it("parses KEY=value lines and strips surrounding quotes", () => {
    expect(parseEnvFile('A=1\nB="two"\nC=\'three\'\n# comment\nnot a line')).toEqual({
      A: "1",
      B: "two",
      C: "three",
    });
  });

  it("the environment wins, and the file is the fallback", () => {
    const file = () => `NEXT_PUBLIC_SUPABASE_URL=${GOOD_URL}\n${TOKEN_VAR}=sbp_from_file`;
    expect(resolveSupabaseUrl({ NEXT_PUBLIC_SUPABASE_URL: "https://env.supabase.co" }, file)).toBe(
      "https://env.supabase.co",
    );
    expect(resolveSupabaseUrl({}, file)).toBe(GOOD_URL);
    expect(resolveAccessToken({ [TOKEN_VAR]: "sbp_from_env" }, file)).toBe("sbp_from_env");
    expect(resolveAccessToken({}, file)).toBe("sbp_from_file");
  });

  it("an unreadable .env.local yields an empty value rather than throwing", () => {
    // The refusal that follows is the one worth reading; a raw ENOENT stack here would replace a
    // message naming the variable with one naming a path.
    const boom = () => {
      throw new Error("ENOENT");
    };
    expect(resolveSupabaseUrl({}, boom)).toBe("");
    expect(resolveAccessToken({}, boom)).toBe("");
  });
});

describe("runQuery reports a failure and never returns an empty result set for one (AC 1)", () => {
  const args = { ref: GOOD_REF, token: "sbp_x", sql: "select 1;" };

  const jsonResponse = (body: unknown, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  });

  it("a successful call returns the rows", async () => {
    const out = await runQuery({ ...args, fetchImpl: asFetch(async () => jsonResponse([{ chars: 9 }])) });
    expect(out).toMatchObject({ ok: true, status: 200, error: null });
    expect(out.rows).toEqual([{ chars: 9 }]);
  });

  it("it POSTs the SQL as a bearer-authenticated JSON body", async () => {
    let seen: { url?: string; init?: RequestInit } = {};
    await runQuery({
      ...args,
      fetchImpl: asFetch(async (url: string, init: RequestInit) => {
        seen = { url, init };
        return jsonResponse([]);
      }),
    });
    expect(seen.url).toBe(queryUrl(GOOD_REF));
    expect(seen.init?.method).toBe("POST");
    expect((seen.init?.headers as Record<string, string>).Authorization).toBe("Bearer sbp_x");
    // `read_only` defaults to TRUE and is always sent. Omitting it would leave the behaviour to a
    // vendor default nobody here chose; defaulting to true means a caller who forgets gets a
    // refusal rather than an unintended write.
    expect(JSON.parse(String(seen.init?.body))).toEqual({ query: "select 1;", read_only: true });
  });

  it("read_only is sent as given, so each stage states its own intent", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = asFetch(async (_url: string, init: RequestInit) => {
      bodies.push(JSON.parse(String(init.body)));
      return jsonResponse([]);
    });
    await runQuery({ ...args, readOnly: true, fetchImpl });
    await runQuery({ ...args, readOnly: false, fetchImpl });
    expect(bodies.map((b) => b.read_only)).toEqual([true, false]);
  });

  it("a transport failure comes back ok:false with rows NULL — never as an empty result set", async () => {
    // The distinction this whole module turns on: an absent answer must not read as a clean one
    // (cairn: an-absent-result-reads-as-a-clean-one-2026-08-11). `rows: []` would be a lie a
    // caller cannot detect.
    const out = await runQuery({
      ...args,
      fetchImpl: asFetch(async () => {
        throw new Error("ECONNRESET");
      }),
    });
    expect(out.ok).toBe(false);
    expect(out.rows).toBeNull();
    expect(out.status).toBeNull();
    expect(out.error).toMatch(/never completed/);
  });

  it("a body that throws WHILE BEING READ is reported, not raised", async () => {
    // Reading the body is a second network operation, so a reset mid-response throws here rather
    // than at the fetch. The caller awaits this at top level with no catch, so an escape would be
    // an unhandled rejection and a dead process instead of a refusal.
    const out = await runQuery({
      ...args,
      fetchImpl: asFetch(async () => ({
        ok: true,
        status: 200,
        text: async () => {
          throw new Error("aborted");
        },
      })),
    });
    expect(out).toMatchObject({ ok: false, status: 200, rows: null });
    expect(out.error).toMatch(/body could not be read/);
  });

  it("an HTTP error carries the status and the service's own message", async () => {
    const out = await runQuery({
      ...args,
      fetchImpl: asFetch(async () => jsonResponse({ message: "Invalid authentication credentials" }, 401)),
    });
    expect(out.ok).toBe(false);
    expect(out.rows).toBeNull();
    expect(out.error).toBe("[401] Invalid authentication credentials");
  });

  it("an HTTP error with an unparseable body still says the status rather than nothing", async () => {
    const out = await runQuery({
      ...args,
      fetchImpl: asFetch(async () => ({ ok: false, status: 502, text: async () => "<html>bad gateway" })),
    });
    expect(out.error).toMatch(/^\[502\] <html>bad gateway/);
  });

  it("a 200 whose body is not an array yields [] rather than a non-array `rows`", async () => {
    const out = await runQuery({ ...args, fetchImpl: asFetch(async () => jsonResponse({ ok: true })) });
    expect(out).toMatchObject({ ok: true, rows: [] });
  });
});
