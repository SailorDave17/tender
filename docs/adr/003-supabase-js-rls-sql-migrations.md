# ADR 003 — Supabase Postgres via supabase-js, RLS as authorization, SQL migrations in-repo

- Status: accepted 2026-08-21
- Phase: 6

## Context
Ordinary adult PII with a strict visibility rule (contact details only on match) and a structural adults-only control. Authorization must hold against a bypass of the app, not only inside it.

## Options considered
- **supabase-js + RLS + SQL migrations** — the Taskr pattern: policies are the authorization, migrations are files, a `check:live` proves the live project matches the repo. cairn carries the traps already paid for (parameter shadowing, column grants, overloads resolved by argument names, the pglite stub's blindness to platform grants).
- **Drizzle ORM over Postgres, app-enforced authorization** — typed queries, generated migrations; last release 0.45.2 on 2026-03-27 (*measured*). A bypass of the app is a bypass of the rules — the inverse of the structural-control lesson.
- **Prisma** — mature and typed; heavier on serverless; same app-enforced caveat; no house experience.

## Decision
supabase-js with RLS and hand-written SQL migrations. Chosen because the visibility rule is a property of the data, and the house's hardest-won Supabase knowledge is exactly about making RLS hold.

## Consequences
Every policy gets a failing-then-passing test in the pglite harness, with that harness's documented blindness (it grants `all` where Supabase grants less) stated in the repo. `check:live` ships with the scaffold. Migrations are pasted by the owner — the one externally-gated operation in the deploy path.

## Kill condition
An RLS policy that cannot express the contact-on-match rule without a `security definer` escape the house notes warn against — reopen toward an API layer with app-enforced authorization, with the structural loss recorded.
