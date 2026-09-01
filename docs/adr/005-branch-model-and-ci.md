# ADR 005 — GitHub Actions CI; `develop` integration, `release` production, feature PRs

- Status: accepted 2026-08-21; one consequence superseded 2026-09-01 — see Consequences
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
- **Superseded 2026-09-01, owner directive.** `main` is not retired and is not an inert pointer: it is the **backup branch** — a known-good working version to fall back to if `release` breaks and cannot be fixed in place. It is promoted **from `release`** by a pull request the owner merges — from the branch production actually ran, never from `develop`, so the backup is by construction a state that has been live rather than one nobody has yet run. Two things follow. It must stay known-good, which is what promoting from `release` buys, so do not take a backup while production is broken — the point is to keep the last good copy, not to record the bad one; and it is still never a base for new work, since a fallback that quietly acquires unreviewed work has stopped being one. The line above is kept rather than rewritten because it was the decision at scaffold and the change of role is the thing worth seeing. *Measured 2026-09-01:* PR #121 promoted `develop` → `release` and PR #122 took `develop` → `main` fifteen seconds later — a `main` that has moved is the backup being taken and not divergence, though the source branch there was `develop`; the rule stated above is `release` → `main`. The directive is workspace-wide; cairn's `branch-off-current-develop-2026-07-30` carries it for every repo.

## Kill condition
The owner promoting without pasting the migration twice in a season — reopen toward a migration step in CI with the service-role key held as a GitHub secret, accepting the authority that gives the pipeline.
