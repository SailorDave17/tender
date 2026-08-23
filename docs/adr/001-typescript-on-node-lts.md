# ADR 001 — TypeScript on Node LTS

- Status: accepted 2026-08-21
- Phase: 6

## Context
A web app with a small pure engine (the ladder), a Postgres database and push/email delivery, run by one person. The house's other web projects (Taskr, burgee, madcowsailing) are TypeScript; the framework decision (ADR 002) assumes Node.

## Options considered
- **TypeScript on Node LTS** — the default for every candidate framework; every Supabase and web-push library is first-party here; highest community and hiring signal. *Reasoned* from the framework research in ADR 002.
- **Python (FastAPI + a JS front end)** — two languages for one person and a 40-user pilot; no house web project uses it.
- **Go** — excellent for the engine, poor for the PWA front end; forces a two-runtime repo.

## Decision
TypeScript on the current Node LTS, one language across engine, API routes and UI. Chosen because every other decision narrows to it and the house already holds its traps.

## Consequences
Node version pinned in the repo (`.nvmrc` + `engines`) and in CI; a local-vs-runner version gap is the third mechanism in cairn's *a-local-gate-can-run-a-different-graph* note and pinning is the guard.

## Kill condition
A framework decision that does not run on Node (none of the three considered), or the engine needing something Node cannot do at $0 — neither in sight.
