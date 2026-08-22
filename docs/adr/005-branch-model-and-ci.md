# ADR 005 — GitHub Actions CI; `develop` integration, `release` production, feature PRs

- Status: accepted 2026-08-21
- Phase: 6

## Context
One operator. Vercel deploys whatever its production branch receives, so the branch model decides whether a merge is a deploy. Taskr's 2026-08-09 outage came from merge-is-deploy coupling (cairn, *taskr-refresh*).

## Options considered
- **`develop` (default, integration) + `release` (Vercel production branch) + feature branches and PRs** — merging a PR deploys nothing; promoting `develop` → `release` is the deploy and is the owner's act. The house `githooks/pre-push` refuses both branches (`owner-only` lists `release`). madcowsailing adopted the same shape on 2026-08-21.
- **`main` only, PRs into it, `main` deploys** — simplest; every merge is a production deploy.
- **`develop` + `main`, `main` deploys** — the same protection with conventional names; Taskr kept `release` because `main` held old history, which Tender does not have.

## Decision
`develop` + `release` + feature PRs, with GitHub Actions running the test suites and the consistency checks on every PR. Won on decoupling merge from deploy; the `release` name keeps the house repos' vocabulary aligned.

## Consequences
- Vercel production branch set to `release`; `develop` and feature branches produce gated previews.
- `gh pr create` targets `develop`; `complete-story` step 8's closing-keyword check applies, including the base-branch mirror cairn recorded on 2026-08-21 (a `Closes` is inert when the base is not the default branch — `develop` is the default here, so it fires).
- Migrations are pasted by the owner before promotion, never by CI.
- The existing `main` (one Initial commit) is retired at scaffold: `develop` becomes the default; `main` is deleted by the owner or left as an inert pointer — the scaffold checklist decides.

## Kill condition
The owner promoting without pasting the migration twice in a season — reopen toward a migration step in CI with the service-role key held as a GitHub secret, accepting the authority that gives the pipeline.
