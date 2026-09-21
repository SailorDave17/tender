# ADR 006 — Vitest for the engine, pglite for RLS, Playwright smoke later; scaffold test = the rung selector

- Status: accepted 2026-08-21
- Phase: 6

## Context
The scaffold must ship one real test proven able to fail (`prove-tests`). The engine is a pure function; the authorization lives in RLS; the UI does not exist yet.

## Options considered
- **Vitest (engine) + pglite harness (RLS) + Playwright smoke once screens exist** — the rung selector (post, pool, clock → rung and candidates) is pure and mutation-provable on day one. The pglite harness is Taskr's, with its documented blindness to platform grants (it grants `all` where Supabase grants less), so `check:live` remains the instrument for the live project.
- **Vitest only, everything mocked** — fastest suite; a suite that constructs the environment it certifies cannot see the live project diverge (cairn, *a-suite-can-only-prove-the-environment-it-builds*).
- **No tests until the first story** — forbidden by the scaffold checklist unless overridden knowingly.

## Decision
The first option. The scaffold's one real test is the rung selector, with its predicted red count written before the mutation.

## Consequences
Every policy gets a failing-then-passing pglite case; every negative assertion states the window it observed (the fourteenth and fifteenth outcomes in cairn's *prove-a-guard-test-can-fail*); CI runs both suites on every PR. The pglite harness's overstatement is recorded in the repo README, not discovered.

**The Playwright smoke shipped 2026-09-21 (story #45).** CI's `smoke` job drives sign-in → availability → post → answer → accept through the machine's Chrome (`playwright-core`) against a local Supabase stack built from `supabase/migrations`, on pull requests only, capped at eight minutes. Sign-in is by password, because #99 removed the magic link the story was filed with. It does **not** discharge the kill condition below: that condition is about the *live* project, and a local stack carries the CLI image's grants, not the hosted project's. README, *The smoke*, lists what it cannot see.

## Kill condition
A class of defect reaching production that the suites were structurally unable to see — reopen toward a live-project integration suite run against a throwaway Supabase project, priced against the 2-project Free limit.
