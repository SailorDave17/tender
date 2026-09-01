/**
 * verify:migrations — the half that decides things, with no network in it. Story #117.
 *
 * WHAT QUESTION THIS ANSWERS, AND WHY IT IS NOT `check:live`'s
 *
 * `check:live` asks *what can the public anon key reach* — a client's question, over PostgREST,
 * with the anon key. It sees tables and functions because those are the only things a client can
 * name. That leaves it structurally blind to four kinds of migration, and this repo's recent
 * history is mostly those four: `0011` re-points three check constraints, `0014` is one grant,
 * `0015` is revokes and default privileges, `0009` adds two triggers. `check:live` reads the same
 * number either side of each of those pastes.
 *
 * This asks *is the database in the state the files describe* — read from `pg_catalog` with a
 * management token, which can see a grant, a constraint, a trigger and an index.
 *
 * WHY THE EXPECTATIONS ARE PARSED RATHER THAN LISTED
 *
 * The tempting shape is a table of what should exist. It is the wrong one, and the reason is not
 * maintenance effort: a hand-written expectation has the same author as the migration, on the same
 * day, from the same understanding — so it certifies AGREEMENT rather than PRESENCE, and it agrees
 * with itself in exactly the case this command exists for, which is the migration somebody wrote
 * and forgot to paste. Everything below is derived from `supabase/migrations/*.sql`. Adding a
 * migration requires no edit here; adding a *kind of statement* nobody has written before does,
 * and `test/verify-migrations.test.ts` refuses a corpus containing a statement this file cannot
 * classify rather than skipping it silently.
 *
 * WHY COMMENTS ARE STRIPPED FIRST, AND WHY THAT IS NOT FUSSINESS
 *
 * The migrations here carry long headers that quote their own SQL. `0015`'s header contains
 *
 *     alter default privileges in schema public grant all on tables to postgres, anon, ...
 *
 * as prose — it is describing the platform default the file exists to REVOKE. Parsed without
 * stripping, that line produces an expectation that is the exact opposite of what the file
 * asserts, and the command would then report the live project broken for being correct. So the
 * stripper is load-bearing and is a lexer rather than a regex: a `--` inside a string literal is
 * not a comment, a `/*` inside a dollar-quoted body is not a comment, and Postgres block comments
 * NEST. (cairn: a-guard-preprocesses-its-evidence-before-it-looks-2026-08-25 — the guard that
 * mangles its own input before a correct matcher ever sees it.)
 *
 * WHY `pg_catalog` AND `has_*_privilege()` AND NEVER `information_schema`
 *
 * `information_schema` views are FILTERED to what the current role can see. The token used here
 * connects as `supabase_read_only_user`, which is neither grantor nor grantee of anything these
 * migrations grant — so those views come back EMPTY, and empty reads as *no grants are held*
 * rather than as *you cannot see the grants*. *Measured 2026-08-31*: an assertion phrased
 * "`authenticated` holds only SELECT on `club`" passed against `role_table_grants` while
 * `has_column_privilege()` confirmed five live column grants on that very table (cairn:
 * supabase-management-api-tokens-2026-08-31). The catalog and the `has_*` functions answer about
 * the OBJECT rather than about the asker, so they are the only instruments used below.
 *
 * WHAT A GREEN RUN DOES NOT MEAN
 *
 * It does not mean a file was executed. A `revoke` whose privilege was never granted, an `update`
 * that matches no rows, an `alter default privileges` on a project that never had the default —
 * each leaves the database in the state the file asserts without the file ever having run. So
 * every verdict here is about STATE, and the report says so in as many words. What it can prove
 * is the useful direction: a migration whose artefacts are absent has not been applied.
 */

import { splitStatements } from "./management-api.mjs";

/** Verdicts a single expectation can come back with. */
export const HOLDS = "HOLDS";
export const MISSING = "MISSING";
/** The object an expectation is *about* is absent, so the expectation itself cannot be read. */
export const INDETERMINATE = "INDETERMINATE";

/** Every role these migrations name. Checked to exist before anything else is read. */
export const ROLE_PATTERN = /^[a-z_][a-z0-9_]*$/;

/** How many expectations go into one round trip. */
export const BATCH_SIZE = 60;

// -------------------------------------------------------------------------------------------
// 1. Stripping comments — a lexer, because a regex is wrong here in three separate ways
// -------------------------------------------------------------------------------------------

/**
 * Replace every SQL comment with a single space, leaving everything else byte-identical.
 *
 * Shares its scanning rules with `splitStatements` in management-api.mjs, deliberately and with a
 * test that binds them: stripping comments must not change how many statements the file has, on
 * every real migration in this repo. Two independently written scanners agreeing on that over
 * fifteen files is a real property; it is not the two of them checking each other's homework,
 * because one answers *where do statements end* and this one answers *what is prose*.
 *
 * Four things hide a comment marker and all four are present in this repo's files:
 *
 *   - single-quoted strings, where a quote is escaped by DOUBLING it and never by a backslash;
 *   - double-quoted identifiers, which nothing here uses and which a scanner right for three of
 *     the four would fail on the first day something did;
 *   - dollar-quoted bodies, inside which nothing at all is special — every `plpgsql` function
 *     here is one, and several contain `--` lines of their own;
 *   - block comments, which NEST in Postgres unlike in C.
 *
 * A comment becomes a SPACE rather than nothing, so `create/**\/table` cannot be glued into a
 * token that was never written.
 */
export function stripComments(sql) {
  const text = String(sql ?? "");
  let out = "";
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (ch === "-" && text[i + 1] === "-") {
      const newline = text.indexOf("\n", i);
      // The newline is KEPT. Line structure survives, so a statement's text still reads the way
      // it was written and a reported statement is findable in the file.
      i = newline === -1 ? text.length : newline;
      out += " ";
      continue;
    }

    if (ch === "/" && text[i + 1] === "*") {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text[i] === "/" && text[i + 1] === "*") {
          depth += 1;
          i += 2;
        } else if (text[i] === "*" && text[i + 1] === "/") {
          depth -= 1;
          i += 2;
        } else {
          i += 1;
        }
      }
      out += " ";
      continue;
    }

    if (ch === "'" || ch === '"') {
      const quote = ch;
      const start = i;
      i += 1;
      while (i < text.length) {
        if (text[i] === quote) {
          if (text[i + 1] === quote) {
            i += 2;
            continue;
          }
          i += 1;
          break;
        }
        i += 1;
      }
      out += text.slice(start, i);
      continue;
    }

    if (ch === "$") {
      const tag = dollarTag(text, i);
      if (tag) {
        const end = text.indexOf(tag, i + tag.length);
        const stop = end === -1 ? text.length : end + tag.length;
        out += text.slice(i, stop);
        i = stop;
        continue;
      }
    }

    out += ch;
    i += 1;
  }

  return out;
}

/**
 * The dollar-quote tag opening at `index`, or null. `$$` and `$name$` open one; `$1` does not.
 *
 * A local copy of management-api.mjs's `dollarTagAt` rather than an import, because that module's
 * copy belongs to statement splitting and this one belongs to comment stripping — and the day one
 * of them needs to change, the other should not have to.
 */
function dollarTag(text, index) {
  if (text[index] !== "$") return null;
  if (text[index + 1] === "$") return "$$";
  const match = /^\$[A-Za-z_][A-Za-z0-9_]*\$/.exec(text.slice(index));
  return match ? match[0] : null;
}

// -------------------------------------------------------------------------------------------
// 2. Parsing one migration into operations
// -------------------------------------------------------------------------------------------

/** Collapse whitespace so a statement spanning six lines matches the same pattern as one line. */
function flatten(statement) {
  return String(statement).replace(/\s+/g, " ").trim();
}

/**
 * An identifier this file is willing to put into generated SQL.
 *
 * A QUOTED identifier is REFUSED rather than unquoted. Postgres folds an unquoted name to lower
 * case and does not fold a quoted one, so `"Weird"` and `weird` are different objects — and an
 * earlier version of this function stripped the quotes and lower-cased what was inside, which
 * would have generated a read about a table that does not exist and reported it MISSING. Nothing
 * in this repo uses one; refusing is the honest handling until something does, and the corpus
 * test proves nothing legitimate is being turned away.
 */
function identifier(raw) {
  const text = String(raw ?? "").trim();
  if (text.startsWith('"')) {
    throw new Error(
      `quoted identifiers are not verified: ${text} — an unquoted name folds to lower case and a ` +
        "quoted one does not, so treating them alike would generate a read about the wrong object",
    );
  }
  const name = text.toLowerCase();
  if (!ROLE_PATTERN.test(name)) {
    throw new Error(`not an identifier this command can verify: ${JSON.stringify(raw)}`);
  }
  return name;
}

/** `public.club` from `public.club`, `club` or `"club"`. Schema defaults to public. */
function qualified(raw) {
  const parts = String(raw ?? "").trim().split(".");
  if (parts.length === 1) return `public.${identifier(parts[0])}`;
  if (parts.length === 2) return `${identifier(parts[0])}.${identifier(parts[1])}`;
  throw new Error(`not a table name this command can verify: ${JSON.stringify(raw)}`);
}

/** A single-quoted SQL literal. Everything interpolated below goes through this or `identifier`. */
export function literal(value) {
  return `'${String(value).split("'").join("''")}'`;
}

/** The privileges named in a `grant`/`revoke`, upper-cased, or the string `ALL`. */
function privileges(list) {
  const text = flatten(list).toLowerCase();
  if (/^all( privileges)?$/.test(text)) return "ALL";
  return text
    .split(",")
    .map((p) => p.trim().toUpperCase())
    .filter(Boolean);
}

/** The roles named after `to` or `from`. `public` is kept as-is; it is PUBLIC, not a role. */
function roles(list) {
  return flatten(list)
    .split(",")
    .map((r) => r.trim())
    .filter(Boolean)
    .map((r) => (r.toLowerCase() === "public" ? "public" : identifier(r)));
}

/**
 * The whole-number tokens in a check expression, as written.
 *
 * This is what lets a re-pointed constraint be told from the one it replaced. `0011` drops
 * `person_rating_check` and adds a constraint of THE SAME NAME with a fourth level in it, so
 * existence alone cannot distinguish an applied `0011` from an unapplied one — which is the exact
 * blindness this story is about. Comparing the definition text is not available either, because
 * Postgres rewrites `rating in (1, 2, 3, 4)` as `rating = ANY (ARRAY[1, 2, 3, 4])`; what survives
 * that rewrite is the set of literals, so that is what is compared.
 *
 * Matched with word boundaries on BOTH sides, so `4` is not found inside `14` and a constraint on
 * a column named `col2` does not contribute a `2` (cairn:
 * a-substring-match-is-satisfied-by-a-longer-neighbour-2026-08-25). The same boundaries are used
 * on the catalog side, in Postgres's own `\m…\M` spelling.
 */
export function integerLiterals(expression) {
  const found = String(expression ?? "").match(/(?<![\w.])\d+(?![\w.])/g) ?? [];
  return [...new Set(found)].sort((a, b) => Number(a) - Number(b));
}

/**
 * Turn one statement into the operations it performs.
 *
 * Returns `{ ops, note }`. A `note` and no ops means the statement was recognised and has nothing
 * a catalog read can testify to — a data backfill, a seed insert. `ops` empty and `note` null
 * means the statement was NOT recognised, which the corpus test treats as a failure rather than as
 * silence: an unrecognised statement is an expectation this command would quietly not check.
 */
export function parseStatement(statement) {
  const text = flatten(statement);
  const lower = text.toLowerCase();
  const ops = [];

  // ---- create table -----------------------------------------------------------------------
  let m = /^create table (?:if not exists )?([\w".]+)\s*\(/i.exec(text);
  if (m) {
    ops.push({ op: "table", table: qualified(m[1]) });
    return { ops, note: null };
  }

  // ---- create function --------------------------------------------------------------------
  m = /^create (?:or replace )?function ([\w".]+)\s*\(([^)]*)\)/i.exec(text);
  if (m) {
    const args = m[2].trim();
    // Argument COUNT rather than argument TYPES. A type list means parsing modes, defaults and
    // array suffixes for a discrimination nothing in this schema needs — no function here is
    // overloaded — and the check below asserts the match is UNIQUE, so an overload added later is
    // reported as ambiguous rather than silently resolved to whichever row came first.
    const nargs = args === "" ? 0 : args.split(",").length;
    ops.push({ op: "function", fn: qualified(m[1]), nargs });
    return { ops, note: null };
  }

  // ---- create index -----------------------------------------------------------------------
  m = /^create (?:unique )?index (?:concurrently )?(?:if not exists )?([\w"]+) on ([\w".]+)/i.exec(text);
  if (m) {
    ops.push({ op: "index", index: `${qualified(m[2]).split(".")[0]}.${identifier(m[1])}` });
    return { ops, note: null };
  }

  // ---- create trigger ---------------------------------------------------------------------
  m = /^create (?:or replace )?trigger ([\w"]+) .* on ([\w".]+)/i.exec(text);
  if (m) {
    ops.push({ op: "trigger", name: identifier(m[1]), table: qualified(m[2]) });
    return { ops, note: null };
  }

  // ---- create / drop policy ---------------------------------------------------------------
  m = /^create policy ([\w"]+) on ([\w".]+)/i.exec(text);
  if (m) {
    ops.push({ op: "policy", name: identifier(m[1]), table: qualified(m[2]), present: true });
    return { ops, note: null };
  }
  m = /^drop policy (?:if exists )?([\w"]+) on ([\w".]+)/i.exec(text);
  if (m) {
    ops.push({ op: "policy", name: identifier(m[1]), table: qualified(m[2]), present: false });
    return { ops, note: null };
  }

  // ---- alter table ------------------------------------------------------------------------
  //
  // Read CLAUSE BY CLAUSE, and refuse the whole statement if any clause is one this parser does
  // not know. The first version scanned the body for the clause kinds it recognised and accepted
  // the statement if it found any — which meant an `alter table` carrying one known clause and one
  // unknown one was silently half-read.
  //
  // *Measured* by the mutation pass: with the `add constraint` reader disabled, `0011`'s
  // "drop constraint X, add constraint X check (...)" still produced the DROP, so the statement
  // counted as classified and the corpus guard stayed green while the whole point of `0011` — the
  // widened constraint — went unchecked. An `alter column … set default` or an `add primary key`
  // would have gone the same way, with nothing to notice.
  m = /^alter table (?:only )?([\w".]+) ([\s\S]+)$/i.exec(text);
  if (m) {
    const table = qualified(m[1]);
    const body = m[2].trim();

    // `enable row level security` is a whole-body form rather than one of a comma-separated list.
    if (/^enable row level security$/i.test(body)) {
      return { ops: [{ op: "rls", table }], note: null };
    }

    for (const clause of splitTopLevel(body)) {
      const column = /^add column (?:if not exists )?([\w"]+)\b/i.exec(clause);
      if (column) {
        ops.push({ op: "column", table, column: identifier(column[1]) });
        continue;
      }
      const dropped = /^drop constraint (?:if exists )?([\w"]+)$/i.exec(clause);
      if (dropped) {
        ops.push({ op: "constraint", table, name: identifier(dropped[1]), present: false });
        continue;
      }
      const added = /^add constraint ([\w"]+) check \(([\s\S]*)\)$/i.exec(clause);
      if (added) {
        ops.push({
          op: "constraint",
          table,
          name: identifier(added[1]),
          present: true,
          literals: integerLiterals(added[2]),
        });
        continue;
      }
      // One unreadable clause makes the whole statement unreadable. Returning the clauses that
      // WERE understood would be worse than returning nothing: it reads as a classified statement.
      return { ops: [], note: null };
    }
    return { ops, note: null };
  }

  // ---- grant ------------------------------------------------------------------------------
  m = /^grant execute on function ([\s\S]+?) to ([\s\S]+)$/i.exec(text);
  if (m) {
    for (const fn of functionList(m[1])) {
      for (const role of roles(m[2])) ops.push({ op: "grant-function", role, ...fn });
    }
    return { ops, note: null };
  }
  m = /^grant ([\s\S]+?) on ([\s\S]+?) to ([\s\S]+)$/i.exec(text);
  if (m) {
    for (const op of tableGrantOps("grant", m[1], m[2], m[3])) ops.push(op);
    return { ops, note: null };
  }

  // ---- revoke -----------------------------------------------------------------------------
  m = /^revoke ([\s\S]+?) on all (tables|sequences|functions) in schema ([\w",\s]+?) from ([\s\S]+)$/i.exec(text);
  if (m) {
    for (const role of roles(m[4])) {
      ops.push({
        op: "revoke-all-in-schema",
        role,
        objects: m[2].toLowerCase(),
        schema: identifier(m[3].trim()),
      });
    }
    return { ops, note: null };
  }
  m = /^revoke ([\s\S]+?) on function ([\s\S]+?) from ([\s\S]+)$/i.exec(text);
  if (m) {
    const privs = privileges(m[1]);
    for (const fn of functionList(m[2])) {
      for (const role of roles(m[3])) {
        ops.push({ op: "revoke-function", role, privileges: privs, ...fn });
      }
    }
    return { ops, note: null };
  }
  m = /^revoke ([\s\S]+?) on ([\s\S]+?) from ([\s\S]+)$/i.exec(text);
  if (m) {
    for (const op of tableGrantOps("revoke", m[1], m[2], m[3])) ops.push(op);
    return { ops, note: null };
  }

  // ---- alter default privileges -----------------------------------------------------------
  m = /^alter default privileges in schema ([\w"]+) revoke ([\s\S]+?) on (tables|sequences|functions) from ([\s\S]+)$/i.exec(text);
  if (m) {
    for (const role of roles(m[4])) {
      ops.push({
        op: "default-privileges",
        schema: identifier(m[1]),
        objects: m[3].toLowerCase(),
        role,
      });
    }
    return { ops, note: null };
  }

  // ---- recognised, and nothing a catalog read can testify to -------------------------------
  if (/^insert into\b/i.test(lower)) {
    return {
      ops: [],
      note: "seed rows — a row can be edited or deleted afterwards, so its presence is not evidence about this file",
    };
  }
  if (/^update\b/i.test(lower)) {
    return {
      ops: [],
      note: "data backfill — it is a no-op on a project with no matching rows, so neither outcome distinguishes an applied file from an unapplied one",
    };
  }
  if (/^alter default privileges .* grant /i.test(lower)) {
    return { ops: [], note: "grants a default privilege — not verified; nothing here writes one" };
  }

  return { ops: [], note: null };
}

/** `public.is_admin()` / `public.owns_boat(uuid)` in a comma-separated list. */
function functionList(list) {
  return splitTopLevel(list).map((entry) => {
    const m = /^([\w".]+)\s*\(([^)]*)\)$/.exec(entry.trim());
    if (!m) throw new Error(`not a function signature this command can verify: ${entry}`);
    const args = m[2].trim();
    return { fn: qualified(m[1]), nargs: args === "" ? 0 : args.split(",").length };
  });
}

/**
 * Split on commas that are not inside brackets.
 *
 * `grant select (id, name) on public.club` has commas that belong to the COLUMN LIST, and
 * `grant select on public.post, public.boat` has one that separates OBJECTS. A plain `split(",")`
 * cannot tell them apart, and both forms are in this repo.
 */
export function splitTopLevel(text) {
  const out = [];
  let depth = 0;
  let current = "";
  for (const ch of String(text ?? "")) {
    if (ch === "(") depth += 1;
    if (ch === ")") depth -= 1;
    if (ch === "," && depth === 0) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) out.push(current);
  return out.map((s) => s.trim()).filter(Boolean);
}

/** Both `grant` and `revoke` on tables, including the column-list form. */
function tableGrantOps(direction, privList, objectList, roleList) {
  const ops = [];
  const targetRoles = roles(roleList);
  // `select (a, b), update (c)` — one clause per privilege, each with its own column list.
  const clauses = splitTopLevel(privList);
  const columnClauses = [];
  const plain = [];
  for (const clause of clauses) {
    const m = /^([a-z ]+?)\s*\(([^)]*)\)$/i.exec(clause.trim());
    if (m) columnClauses.push({ privilege: m[1].trim().toUpperCase(), columns: splitTopLevel(m[2]) });
    else plain.push(clause.trim());
  }

  for (const object of splitTopLevel(objectList)) {
    const table = qualified(object);
    for (const role of targetRoles) {
      for (const { privilege, columns } of columnClauses) {
        for (const column of columns) {
          ops.push({
            op: direction === "grant" ? "grant-column" : "revoke-column",
            role,
            table,
            column: identifier(column),
            privilege,
          });
        }
      }
      if (plain.length) {
        const privs = privileges(plain.join(", "));
        ops.push({
          op: direction === "grant" ? "grant-table" : "revoke-table",
          role,
          table,
          privileges: privs,
        });
      }
    }
  }
  return ops;
}

/** Parse one migration file into its statements and their operations. */
export function parseMigration({ file, sql }) {
  const stripped = stripComments(sql);
  const statements = splitStatements(stripped).map((text) => {
    // A statement this file cannot safely read becomes UNRECOGNISED rather than an exception. The
    // two are the same refusal — `runVerify` stops the run either way — but one arrives as a
    // named statement in a report and the other as a stack trace, and only the first tells the
    // reader which line of which migration to look at.
    try {
      const { ops, note } = parseStatement(text);
      return { text: flatten(text), ops, note };
    } catch (error) {
      return { text: flatten(text), ops: [], note: null, error: error?.message ?? String(error) };
    }
  });
  return { file, statements };
}

// -------------------------------------------------------------------------------------------
// 3. Folding the whole corpus into a final expected state
// -------------------------------------------------------------------------------------------

/**
 * Resolve the migrations, in order, into the state they jointly assert.
 *
 * This is a fold rather than a per-file list because a later file can undo an earlier one and
 * this repo does it four ways: `0008` drops a policy `0002` created; `0011` drops and re-adds
 * three constraints; `0013` revokes every privilege on a table and then grants one back; `0015`
 * sweeps `anon` off every table in the schema, superseding thirteen earlier per-table revokes.
 * Checking each file against the catalog in isolation would report all four as broken.
 *
 * A statement whose effect a later file replaced is reported as SUPERSEDED rather than dropped —
 * it is the honest answer to "did 0002's revoke hold?", which is "0015 is what decides that now".
 *
 * PRIVILEGES ARE FOLDED TWO WAYS, and the difference is what can be claimed:
 *
 *   - after a `revoke all on <table> from <role>` the set is KNOWN, so what the role holds at
 *     table level afterwards is exactly what was granted back. That is asserted as an equality
 *     against `relacl`, which catches a privilege nobody granted as well as one nobody applied.
 *   - with no such baseline only a LOWER BOUND is known — this file granted P, and the role may
 *     hold others for reasons no file here records. That is asserted as `has_*_privilege` = true
 *     and nothing more.
 *
 * The distinction is not pedantry: Supabase grants every new object to all four roles by
 * platform default, so "the role holds nothing else" is a claim only a file that revoked can make.
 */
export function foldExpectations(parsed) {
  const facts = new Map();
  const superseded = [];
  const unobservable = [];
  const unrecognised = [];

  /** (role, table) -> { baseline, set, file } for table-level privileges. */
  const tableAcl = new Map();
  /** (role, function) -> { baseline, set, file } */
  const functionAcl = new Map();
  const knownTables = [];
  const knownFunctions = [];

  const put = (key, fact) => {
    const existing = facts.get(key);
    if (existing) superseded.push({ ...existing, supersededBy: fact.file });
    facts.set(key, { ...fact, key });
  };

  for (const migration of parsed) {
    for (const statement of migration.statements) {
      const where = { file: migration.file, statement: statement.text };
      if (!statement.ops.length) {
        if (statement.note) unobservable.push({ ...where, note: statement.note });
        else unrecognised.push({ ...where, error: statement.error ?? null });
        continue;
      }
      for (const op of statement.ops) applyOp(op, where);
    }
  }

  /**
   * The running privilege state for one (role, object) pair.
   *
   * `identity` is carried on the VALUE rather than encoded in the key and parsed back out. That
   * is not tidiness: the first version joined the two with a separator and split them apart at the
   * end, which is a second parser nobody tests, over data that comes from a migration file. It
   * survived a corrupted separator — the join and the split agreed on a character neither of them
   * should have contained — with every test green, because both halves were wrong in the same
   * direction (cairn: a-conformance-check-can-break-its-subject-2026-08-10, in miniature).
   */
  function aclState(map, key, identity, file) {
    if (!map.has(key)) map.set(key, { ...identity, baseline: false, set: new Set(), file });
    const state = map.get(key);
    state.file = file;
    return state;
  }

  /**
   * A map key that cannot be confused with the values it is built from.
   *
   * A DECLARATION rather than a const arrow, so it is hoisted: the fold loop above calls
   * `applyOp` before this point in the file, and a const would be in its temporal dead zone.
   */
  function aclKey(role, object) {
    return JSON.stringify([role, object]);
  }

  function applyOp(op, where) {
    switch (op.op) {
      case "table":
        knownTables.push(op.table);
        put(`table:${op.table}`, { ...where, kind: "table", subject: `table ${op.table}`, present: true, table: op.table });
        return;
      case "column":
        put(`column:${op.table}.${op.column}`, {
          ...where,
          kind: "column",
          subject: `column ${op.table}.${op.column}`,
          table: op.table,
          column: op.column,
        });
        return;
      case "function":
        knownFunctions.push({ fn: op.fn, nargs: op.nargs });
        put(`function:${op.fn}/${op.nargs}`, {
          ...where,
          kind: "function",
          subject: `function ${op.fn} (${op.nargs} argument${op.nargs === 1 ? "" : "s"})`,
          fn: op.fn,
          nargs: op.nargs,
        });
        return;
      case "index":
        put(`index:${op.index}`, { ...where, kind: "index", subject: `index ${op.index}`, index: op.index });
        return;
      case "trigger":
        put(`trigger:${op.table}.${op.name}`, {
          ...where,
          kind: "trigger",
          subject: `trigger ${op.name} on ${op.table}`,
          table: op.table,
          name: op.name,
        });
        return;
      case "policy":
        put(`policy:${op.table}.${op.name}`, {
          ...where,
          kind: "policy",
          subject: `policy ${op.name} on ${op.table}`,
          table: op.table,
          name: op.name,
          present: op.present,
        });
        return;
      case "rls":
        put(`rls:${op.table}`, { ...where, kind: "rls", subject: `row level security on ${op.table}`, table: op.table });
        return;
      case "constraint":
        put(`constraint:${op.table}.${op.name}`, {
          ...where,
          kind: "constraint",
          subject: `constraint ${op.name} on ${op.table}`,
          table: op.table,
          name: op.name,
          present: op.present,
          literals: op.literals ?? [],
        });
        return;
      case "grant-table": {
        const state = aclState(tableAcl, aclKey(op.role, op.table), { role: op.role, table: op.table }, where.file);
        if (op.privileges === "ALL") {
          // Nothing here grants ALL on a table; if something ever does, the exact-set claim
          // becomes unknowable and a lower bound is the honest fallback.
          state.baseline = false;
          state.set.clear();
          return;
        }
        for (const privilege of op.privileges) {
          if (state.baseline) state.set.add(privilege);
          else
            put(`tablepriv:${op.role}:${op.table}:${privilege}`, {
              ...where,
              kind: "table-privilege",
              subject: `${op.role} holds ${privilege} on ${op.table}`,
              role: op.role,
              table: op.table,
              privilege,
              expected: true,
            });
        }
        return;
      }
      case "revoke-table": {
        const state = aclState(tableAcl, aclKey(op.role, op.table), { role: op.role, table: op.table }, where.file);
        if (op.privileges === "ALL") {
          state.baseline = true;
          state.set.clear();
          return;
        }
        for (const privilege of op.privileges) {
          if (state.baseline) state.set.delete(privilege);
          else
            put(`tablepriv:${op.role}:${op.table}:${privilege}`, {
              ...where,
              kind: "table-privilege",
              subject: `${op.role} does not hold ${privilege} on ${op.table}`,
              role: op.role,
              table: op.table,
              privilege,
              expected: false,
            });
        }
        return;
      }
      case "grant-column":
        put(`colpriv:${op.role}:${op.table}.${op.column}:${op.privilege}`, {
          ...where,
          kind: "column-privilege",
          subject: `${op.role} holds ${op.privilege} on ${op.table}.${op.column}`,
          role: op.role,
          table: op.table,
          column: op.column,
          privilege: op.privilege,
          expected: true,
        });
        return;
      case "revoke-column":
        put(`colpriv:${op.role}:${op.table}.${op.column}:${op.privilege}`, {
          ...where,
          kind: "column-privilege",
          subject: `${op.role} does not hold ${op.privilege} on ${op.table}.${op.column}`,
          role: op.role,
          table: op.table,
          column: op.column,
          privilege: op.privilege,
          expected: false,
        });
        return;
      case "grant-function": {
        const state = aclState(
          functionAcl,
          aclKey(op.role, `${op.fn}/${op.nargs}`),
          { role: op.role, fn: op.fn, nargs: op.nargs },
          where.file,
        );
        if (state.baseline) state.set.add("EXECUTE");
        else
          put(`fnpriv:${op.role}:${op.fn}/${op.nargs}`, {
            ...where,
            kind: "function-privilege",
            subject: `${op.role} may execute ${op.fn}`,
            role: op.role,
            fn: op.fn,
            nargs: op.nargs,
            expected: true,
          });
        return;
      }
      case "revoke-function": {
        const state = aclState(
          functionAcl,
          aclKey(op.role, `${op.fn}/${op.nargs}`),
          { role: op.role, fn: op.fn, nargs: op.nargs },
          where.file,
        );
        state.baseline = true;
        state.set.clear();
        return;
      }
      case "revoke-all-in-schema": {
        if (op.objects === "tables") {
          for (const table of knownTables) {
            const state = aclState(tableAcl, aclKey(op.role, table), { role: op.role, table }, where.file);
            state.baseline = true;
            state.set.clear();
          }
          if (!knownTables.length)
            unobservable.push({ ...where, note: `no table in ${op.schema} is created by these files, so this sweep has nothing to check` });
        } else if (op.objects === "functions") {
          for (const { fn, nargs } of knownFunctions) {
            const state = aclState(
              functionAcl,
              aclKey(op.role, `${fn}/${nargs}`),
              { role: op.role, fn, nargs },
              where.file,
            );
            state.baseline = true;
            state.set.clear();
          }
          if (!knownFunctions.length)
            unobservable.push({ ...where, note: `no function in ${op.schema} is created by these files, so this sweep has nothing to check` });
        } else {
          // Sequences. No file here creates one — no `serial`, no identity column, no
          // `create sequence` — so there is nothing for this statement to have acted on and
          // saying so is more useful than an expectation that would pass vacuously.
          unobservable.push({
            ...where,
            note: `no sequence in ${op.schema} is created by these files, so this sweep has nothing to check`,
          });
        }
        return;
      }
      case "default-privileges": {
        // WHICH default privileges — measured 2026-09-01, and the first run of this command got
        // it wrong. `alter default privileges` with no `for role` alters the CURRENT role's
        // defaults and nothing else, and a Supabase project carries two owners of default ACLs on
        // `public`: `postgres`, which owns everything these migrations create, and
        // `supabase_admin`, which a migration pasted as `postgres` cannot touch. Aggregating over
        // both reported `0015` as unapplied when it had applied perfectly — `postgres`'s entries
        // had lost `anon` for tables and functions, exactly as the file says.
        //
        // The role to scope by is DERIVED rather than named: it is whoever owns the objects these
        // files created, read from `pg_class.relowner`. That is the same role a later migration
        // will create its table as, which is the population this statement exists to protect. A
        // literal `postgres` here would be a hand-written expectation of exactly the kind this
        // command is built to avoid — and would go quietly wrong on a project set up differently.
        const reference = knownTables[0];
        if (!reference) {
          unobservable.push({
            ...where,
            note: "these files create no table, so there is no object owner to read the governing default privileges from",
          });
          return;
        }
        put(`defacl:${op.role}:${op.objects}:${op.schema}`, {
          ...where,
          kind: "default-privilege",
          subject: `${op.role} is in no default privilege for ${op.objects} in ${op.schema} owned by the role that owns ${reference}`,
          role: op.role,
          objects: op.objects,
          schema: op.schema,
          reference,
        });
        return;
      }
      default:
        throw new Error(`unhandled operation: ${op.op}`);
    }
  }

  for (const state of tableAcl.values()) {
    if (!state.baseline) continue;
    const { role, table } = state;
    const expected = [...state.set].sort();
    put(`tableacl:${role}:${table}`, {
      file: state.file,
      statement: `(net effect of every grant and revoke on ${table} for ${role})`,
      kind: "table-acl",
      subject:
        expected.length === 0
          ? `${role} holds no table-level privilege on ${table}`
          : `${role} holds exactly ${expected.join(", ")} on ${table}`,
      role,
      table,
      expected,
    });
  }

  for (const state of functionAcl.values()) {
    if (!state.baseline) continue;
    const { role, fn, nargs } = state;
    const expected = [...state.set].sort();
    put(`fnacl:${role}:${fn}/${nargs}`, {
      file: state.file,
      statement: `(net effect of every grant and revoke on ${fn} for ${role})`,
      kind: "function-acl",
      subject:
        expected.length === 0
          ? `${role} may not execute ${fn}`
          : `${role} holds exactly ${expected.join(", ")} on ${fn}`,
      role,
      fn,
      nargs,
      expected,
    });
  }

  const rolesNamed = new Set();
  for (const fact of facts.values()) if (fact.role && fact.role !== "public") rolesNamed.add(fact.role);

  return {
    facts: [...facts.values()],
    superseded,
    unobservable,
    unrecognised,
    roles: [...rolesNamed].sort(),
  };
}

// -------------------------------------------------------------------------------------------
// 4. Turning an expectation into a catalog read
// -------------------------------------------------------------------------------------------

/** The role's oid, or PUBLIC's grantee sentinel. */
function granteeSql(role) {
  return role === "public" ? "0" : `(select oid from pg_roles where rolname = ${literal(role)})`;
}

/**
 * The privileges a role holds at TABLE level, as a sorted array, PUBLIC's included.
 *
 * PUBLIC is folded in because a privilege granted to PUBLIC is one the role holds — the whole
 * reason `0015` says `from public, anon` rather than `from anon` is that revoking one leaves the
 * other, and a reader that looked only at the named role would report that fixed when it was not.
 */
function tableAclSql(role, table) {
  return `(
    select coalesce(array_agg(distinct a.privilege_type order by a.privilege_type), array[]::text[])
      from pg_class c, aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a
     where c.oid = to_regclass(${literal(table)})
       and (a.grantee = 0 or a.grantee = ${granteeSql(role)})
  )`;
}

function functionAclSql(role, fn, nargs) {
  return `(
    select coalesce(array_agg(distinct a.privilege_type order by a.privilege_type), array[]::text[])
      from pg_proc p
      join pg_namespace n on n.oid = p.pronamespace,
           aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
     where n.nspname = ${literal(fn.split(".")[0])}
       and p.proname = ${literal(fn.split(".")[1])}
       and p.pronargs = ${Number(nargs)}
       and (a.grantee = 0 or a.grantee = ${granteeSql(role)})
  )`;
}

/** Does this column exist? Guards every `has_column_privilege`, which THROWS on a missing column. */
function columnExistsSql(table, column) {
  return `exists (select 1 from pg_attribute a
                   where a.attrelid = to_regclass(${literal(table)})
                     and a.attname = ${literal(column)} and not a.attisdropped and a.attnum > 0)`;
}

/**
 * The `{ ok, detail }` SQL for one expectation.
 *
 * Every privilege read is guarded by the existence of the object it is about, because
 * `has_table_privilege` on a missing relation raises rather than returning false — and one raise
 * takes the whole batch down, turning "this migration was never applied" into "the query is
 * broken". A guarded read returns NULL instead, which the report calls INDETERMINATE and explains.
 */
export function factSql(fact) {
  switch (fact.kind) {
    case "table":
      return { ok: `(to_regclass(${literal(fact.table)}) is not null)`, detail: "null::text" };
    case "column":
      return { ok: columnExistsSql(fact.table, fact.column), detail: "null::text" };
    case "function":
      return {
        ok: `((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
               where n.nspname = ${literal(fact.fn.split(".")[0])}
                 and p.proname = ${literal(fact.fn.split(".")[1])}
                 and p.pronargs = ${Number(fact.nargs)}) = 1)`,
        detail: "null::text",
      };
    case "index":
      return {
        ok: `exists (select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
                      where n.nspname = ${literal(fact.index.split(".")[0])}
                        and c.relname = ${literal(fact.index.split(".")[1])}
                        and c.relkind in ('i', 'I'))`,
        detail: "null::text",
      };
    case "trigger":
      return {
        ok: `exists (select 1 from pg_trigger t
                      where t.tgrelid = to_regclass(${literal(fact.table)})
                        and t.tgname = ${literal(fact.name)} and not t.tgisinternal)`,
        detail: "null::text",
      };
    case "policy": {
      const present = `exists (select 1 from pg_policy p
                                where p.polrelid = to_regclass(${literal(fact.table)})
                                  and p.polname = ${literal(fact.name)})`;
      return { ok: fact.present ? present : `(not ${present})`, detail: "null::text" };
    }
    case "rls":
      return {
        ok: `coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass(${literal(fact.table)})), false)`,
        detail: "null::text",
      };
    case "constraint": {
      const def = `(select pg_get_constraintdef(c.oid) from pg_constraint c
                     where c.conrelid = to_regclass(${literal(fact.table)})
                       and c.conname = ${literal(fact.name)})`;
      if (!fact.present) return { ok: `(${def} is null)`, detail: "null::text" };
      if (!fact.literals.length) return { ok: `(${def} is not null)`, detail: `${def}::text` };
      // `\m` and `\M` are Postgres's word-start and word-end assertions, which is what stops `4`
      // being found inside `14` — the same boundary the parser applied on the file's side.
      const wanted = `array[${fact.literals.map((n) => literal(n)).join(", ")}]::text[]`;
      return {
        ok: `coalesce((select ${wanted} <@ array(select m[1] from regexp_matches(${def}, '\\m([0-9]+)\\M', 'g') m)), false)`,
        detail: `${def}::text`,
      };
    }
    case "table-privilege":
      return {
        ok: `(case when to_regclass(${literal(fact.table)}) is null then null
                   else has_table_privilege(${literal(fact.role)}, ${literal(fact.table)}, ${literal(fact.privilege)}) = ${fact.expected}
              end)`,
        detail: "null::text",
      };
    case "column-privilege":
      return {
        ok: `(case when not ${columnExistsSql(fact.table, fact.column)} then null
                   else has_column_privilege(${literal(fact.role)}, ${literal(fact.table)}, ${literal(fact.column)}, ${literal(fact.privilege)}) = ${fact.expected}
              end)`,
        detail: "null::text",
      };
    case "function-privilege":
      return {
        ok: `(select bool_and(has_function_privilege(${literal(fact.role)}, p.oid, 'EXECUTE') = ${fact.expected})
               from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = ${literal(fact.fn.split(".")[0])}
                and p.proname = ${literal(fact.fn.split(".")[1])}
                and p.pronargs = ${Number(fact.nargs)})`,
        detail: "null::text",
      };
    case "table-acl": {
      const actual = tableAclSql(fact.role, fact.table);
      const wanted = `array[${fact.expected.map((p) => literal(p)).join(", ")}]::text[]`;
      return {
        ok: `(case when to_regclass(${literal(fact.table)}) is null then null else ${actual} = ${wanted} end)`,
        detail: `array_to_string(${actual}, ', ')`,
      };
    }
    case "function-acl": {
      const actual = functionAclSql(fact.role, fact.fn, fact.nargs);
      const wanted = `array[${fact.expected.map((p) => literal(p)).join(", ")}]::text[]`;
      return {
        ok: `(case when not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                     where n.nspname = ${literal(fact.fn.split(".")[0])}
                                       and p.proname = ${literal(fact.fn.split(".")[1])}
                                       and p.pronargs = ${Number(fact.nargs)})
                   then null else ${actual} = ${wanted} end)`,
        detail: `array_to_string(${actual}, ', ')`,
      };
    }
    case "default-privilege": {
      const objtype = { tables: "r", sequences: "S", functions: "f" }[fact.objects];
      // The grantee is the part of an aclitem BEFORE the `=`, so it is compared whole rather than
      // searched for: `like 'anon%'` would be satisfied by a role called `anonymous`
      // (cairn: a-substring-match-is-satisfied-by-a-longer-neighbour-2026-08-25).
      const owner = `(select c.relowner from pg_class c where c.oid = to_regclass(${literal(fact.reference)}))`;
      const rows = `from pg_default_acl d
                    join pg_namespace n on n.oid = d.defaclnamespace,
                         unnest(d.defaclacl) acl
                   where n.nspname = ${literal(fact.schema)}
                     and d.defaclobjtype = ${literal(objtype)}
                     and d.defaclrole = ${owner}`;
      return {
        ok: `(case when ${owner} is null then null
                   else not exists (select 1 ${rows} and split_part(acl::text, '=', 1) = ${literal(fact.role)})
              end)`,
        detail: `(select coalesce(string_agg(distinct split_part(acl::text, '=', 1), ', '), '(no default privilege set)') ${rows})`,
      };
    }
    default:
      throw new Error(`no catalog read for expectation kind: ${fact.kind}`);
  }
}

// -------------------------------------------------------------------------------------------
// 5. Controls — proving the instrument can produce BOTH answers before any of them is believed
// -------------------------------------------------------------------------------------------

/**
 * Four readings taken before anything about this schema is reported, and every one is about
 * `pg_catalog` rather than about the migrations — so a control cannot be satisfied by the same
 * accident that would satisfy a subject.
 *
 * They come in pairs on purpose. A control that only ever proves the instrument can say TRUE
 * leaves "everything holds" indistinguishable from a reader stuck on true, and a control that only
 * proves it can say FALSE leaves the opposite. Each reader used below — object existence and
 * `has_*_privilege` — has to demonstrate both directions before a single subject is read
 * (check-live-core.mjs takes the same position for the same reason).
 *
 * `has_function_privilege('anon', 'pg_catalog.upper(text)', 'execute')` is the one that answers
 * the criterion this story wrote down: a grant KNOWN to exist, read back as true. `upper(text)` is
 * executable by PUBLIC on every Postgres there has ever been, and it belongs to no migration here,
 * so it cannot be broken by the thing being measured.
 */
export const CONTROLS = [
  {
    key: "control:object-present",
    expect: true,
    sql: "(to_regclass('pg_catalog.pg_class') is not null)",
    describes: "the catalog reader can report an object that IS there",
  },
  {
    key: "control:object-absent",
    expect: false,
    sql: "(to_regclass('public.__tender_verify_absent_probe') is not null)",
    describes: "the catalog reader can report an object that is NOT there",
  },
  {
    key: "control:privilege-held",
    expect: true,
    sql: "has_function_privilege('anon', 'pg_catalog.upper(text)', 'EXECUTE')",
    describes: "the privilege reader can report a grant that IS held",
  },
  {
    key: "control:privilege-not-held",
    expect: false,
    sql: "has_table_privilege('anon', 'pg_catalog.pg_authid', 'SELECT')",
    describes: "the privilege reader can report a grant that is NOT held",
  },
];

/** One statement asking whether each named role exists. A missing role is a finding, not a crash. */
export function rolesQuery(roleNames) {
  const rows = roleNames.map(
    (role) => `select ${literal(role)} as key, exists (select 1 from pg_roles where rolname = ${literal(role)}) as ok`,
  );
  return rows.join("\nunion all\n");
}

/** The controls, as one read-only statement. */
export function controlsQuery() {
  return CONTROLS.map(
    (c, i) => `select ${literal(c.key)} as key, (${c.sql}) as ok${i === 0 ? ", null::text as detail" : ", null::text"}`,
  ).join("\nunion all\n");
}

/**
 * The expectations, as read-only statements in batches.
 *
 * Batched rather than sent as one enormous union so that a defect in one generated expression
 * takes down sixty readings instead of four hundred, and so the failure names a bounded set.
 */
export function expectationQueries(facts, size = BATCH_SIZE) {
  const batches = [];
  for (let i = 0; i < facts.length; i += size) batches.push(facts.slice(i, i + size));
  return batches.map((batch) =>
    batch
      .map((fact, index) => {
        const { ok, detail } = factSql(fact);
        // Only the first branch of a UNION ALL names the columns; the rest inherit them.
        const alias = (name) => (index === 0 ? ` as ${name}` : "");
        return `select ${literal(fact.key)}${alias("key")}, (${ok})${alias("ok")}, (${detail})${alias("detail")}`;
      })
      .join("\nunion all\n"),
  );
}

// -------------------------------------------------------------------------------------------
// 6. Reading the answers back
// -------------------------------------------------------------------------------------------

/** Postgres may hand a boolean back as a boolean or as `t`/`f` depending on the transport. */
function truth(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "boolean") return value;
  const text = String(value).toLowerCase();
  if (text === "t" || text === "true") return true;
  if (text === "f" || text === "false") return false;
  return null;
}

/** Verdict for one expectation, given the row that came back for its key. */
export function verdictFor(fact, row) {
  if (!row) return { verdict: MISSING, detail: "no row came back for this expectation" };
  const ok = truth(row.ok);
  if (ok === null) {
    return {
      verdict: INDETERMINATE,
      detail: row.detail ? String(row.detail) : "the object this is about is absent, so it could not be read",
    };
  }
  return { verdict: ok ? HOLDS : MISSING, detail: row.detail ? String(row.detail) : "" };
}

/**
 * The whole report.
 *
 * Per file: how many of its expectations hold, then a line for each that does not, then the
 * statements it carries that no catalog read can testify to. The last of those is the part this
 * command must be honest about — see `SUMMARY_FOOTER`.
 */
export function report({ files, facts, results, superseded, unobservable }) {
  const lines = [];
  const byKey = new Map(results.map((row) => [row.key, row]));
  const byFile = new Map(files.map((f) => [f, []]));
  for (const fact of facts) {
    if (!byFile.has(fact.file)) byFile.set(fact.file, []);
    byFile.get(fact.file).push({ fact, ...verdictFor(fact, byKey.get(fact.key)) });
  }

  let holds = 0;
  let missing = 0;
  let indeterminate = 0;

  for (const file of files) {
    const entries = byFile.get(file) ?? [];
    const bad = entries.filter((e) => e.verdict !== HOLDS);
    holds += entries.length - bad.length;
    missing += bad.filter((e) => e.verdict === MISSING).length;
    indeterminate += bad.filter((e) => e.verdict === INDETERMINATE).length;

    const quiet = unobservable.filter((u) => u.file === file);
    // Only a supersession by a LATER file is worth reporting. `0011` drops and re-adds three
    // constraints inside single statements, which supersedes itself three times and says nothing
    // a reader needs.
    const later = superseded.filter((s) => s.file === file && s.supersededBy !== file);
    const tail = [
      quiet.length ? `${quiet.length} statement${quiet.length === 1 ? "" : "s"} nothing can testify to` : "",
      later.length ? `${later.length} superseded later` : "",
    ]
      .filter(Boolean)
      .join(", ");

    lines.push(
      `${bad.length ? "FAIL" : "ok  "}  ${file.padEnd(32)} ${entries.length - bad.length} of ${entries.length} hold` +
        (tail ? `   (${tail})` : ""),
    );
    for (const entry of bad) {
      lines.push(`        ${entry.verdict}  ${entry.fact.subject}${entry.detail ? `  — reads: ${entry.detail}` : ""}`);
    }
  }

  const total = holds + missing + indeterminate;
  lines.push("");
  lines.push(
    `verify:migrations: ${files.length} files, ${holds} of ${total} expectations hold` +
      (missing ? `, ${missing} MISSING` : "") +
      (indeterminate ? `, ${indeterminate} indeterminate` : "") +
      `, ${unobservable.length} statements unobservable`,
  );
  for (const line of SUMMARY_FOOTER) lines.push(line);

  return { code: missing + indeterminate ? 1 : 0, lines, holds, missing, indeterminate };
}

// -------------------------------------------------------------------------------------------
// 7. The whole run, with the transport injected
// -------------------------------------------------------------------------------------------

/**
 * Parse, fold, read the catalog, report.
 *
 * `runSql` is injected so every decision below is exercised by `test/verify-migrations.test.ts`
 * against the pglite harness and against fixture answers, with no live project and no credential.
 * It must return `{ ok, rows, error }` and must never turn a transport failure into an empty
 * result set — an absent answer that reads as a clean one is the failure this whole file is a
 * defence against (cairn: an-absent-result-reads-as-a-clean-one-2026-08-11).
 *
 * The order is fixed and each stage refuses before the next runs:
 *
 *   1. the corpus must parse, with every statement classified;
 *   2. every role the migrations name must exist;
 *   3. both readers must demonstrate both answers;
 *   4. only then is a single expectation about this schema believed.
 */
export async function runVerify({ migrations, runSql }) {
  const lines = [];

  // Every exit carries the same shape. A refusal counts 0/0/0 because nothing was READ — not
  // because nothing was wrong — and `code: 2` is what says so. A caller that had to know which
  // shape it was handed would eventually read a count off a run that never happened, which is the
  // absent-result-reads-as-clean failure this whole command is built against.
  const refuse = () => ({ code: 2, lines, holds: 0, missing: 0, indeterminate: 0 });

  if (!migrations.length) {
    lines.push("verify:migrations: no migration files found — refusing a vacuous pass");
    return refuse();
  }

  const parsed = migrations.map(parseMigration);
  const { facts, superseded, unobservable, unrecognised, roles: named } = foldExpectations(parsed);

  if (unrecognised.length) {
    lines.push("verify:migrations: this command cannot classify every statement in the migrations,");
    lines.push("so it cannot say what it would be failing to check. Nothing was read.");
    for (const item of unrecognised) {
      lines.push(`      ${item.file}: ${item.statement.slice(0, 120)}`);
      if (item.error) lines.push(`        ${item.error}`);
    }
    return refuse();
  }

  if (!facts.length) {
    lines.push("verify:migrations: the migrations yielded no observable expectation — refusing a vacuous pass");
    return refuse();
  }

  const roleAnswer = await runSql(rolesQuery(named));
  if (!roleAnswer.ok) {
    lines.push(`verify:migrations: could not read the role list — ${roleAnswer.error}`);
    return refuse();
  }
  const absentRoles = named.filter((role) => !truth(roleAnswer.rows.find((r) => r.key === role)?.ok));
  if (absentRoles.length) {
    lines.push(`verify:migrations: these roles do not exist on this project: ${absentRoles.join(", ")}`);
    lines.push("Every privilege reading below is about a role, so none of them could be believed.");
    return refuse();
  }

  const controlAnswer = await runSql(controlsQuery());
  if (!controlAnswer.ok) {
    lines.push(`verify:migrations: the controls could not be read — ${controlAnswer.error}`);
    return refuse();
  }
  for (const control of CONTROLS) {
    const got = truth(controlAnswer.rows.find((r) => r.key === control.key)?.ok);
    if (got !== control.expect) {
      lines.push(`verify:migrations: control ${control.key} read ${got}, expected ${control.expect}`);
      lines.push(`This control exists to show that ${control.describes}. It did not, so nothing`);
      lines.push("it would have said about the migrations is worth reading. Nothing was reported.");
      return refuse();
    }
    lines.push(`ok    ${control.key}: ${control.expect} — ${control.describes}`);
  }
  lines.push("");

  const results = [];
  for (const sql of expectationQueries(facts)) {
    const answer = await runSql(sql);
    if (!answer.ok) {
      lines.push(`verify:migrations: a batch of expectations could not be read — ${answer.error}`);
      return refuse();
    }
    results.push(...answer.rows);
  }

  const returned = new Set(results.map((r) => r.key));
  const lost = facts.filter((f) => !returned.has(f.key));
  if (lost.length) {
    lines.push(`verify:migrations: ${lost.length} expectations came back with no row at all — refusing to report a partial read`);
    for (const fact of lost.slice(0, 10)) lines.push(`      ${fact.key}`);
    return refuse();
  }

  const files = migrations.map((m) => m.file);
  const outcome = report({ files, facts, results, superseded, unobservable });
  return { ...outcome, lines: [...lines, ...outcome.lines] };
}

/**
 * The claim this command is allowed to make, printed on every run including a clean one.
 *
 * It is here rather than in the README because the place a wrong reading gets made is in front of
 * the output. A report that says "15 of 15 files verified" and stops would be read as "every
 * migration has been applied", which a catalog read cannot establish and this one does not claim.
 */
export const SUMMARY_FOOTER = [
  "",
  "What that means: every line above was read from pg_catalog on the live project, and each",
  "says whether the state a migration ASSERTS is the state the database is in.",
  "",
  "What it does not mean: that a given file was executed. A revoke of a privilege nobody held,",
  "an update matching no rows, a default privilege that was never granted — each leaves the",
  "database in the asserted state without the file ever having run. The useful direction is the",
  "other one: an artefact that is MISSING has not been applied.",
];
