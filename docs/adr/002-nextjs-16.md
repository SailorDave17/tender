# ADR 002 — Next.js 16 as the framework

- Status: accepted 2026-08-21
- Phase: 6

## Context
A phone-first PWA with server-side routes for magic-link auth, Supabase access and push dispatch, deployed to Vercel Hobby (ADR 004). Novelty is spent on the engine and the bet (ADR 007), not here.

## Options considered
- **Next.js 16** — v16.3.2 released 2026-08-21 (*measured*, GitHub releases API). Vercel-native; Taskr and burgee run on it, so the house knows its traps. PWA + web push is a manifest and a service worker, framework-agnostic.
- **SvelteKit 2** — 2.70.3, 2026-08-18 (*measured*). Smaller bundles and a clean PWA story, fast on an old Android. Zero house notes; a second framework to hold in one head; Supabase's SSR docs are React-first.
- **React Router 8 (framework mode)** — 8.3.0, 2026-07-22 (*measured*). Lighter than Next; React knowledge carries. Vercel support via adapter rather than first-party; fewer worked Supabase-auth examples.

## Decision
Next.js 16. Won on house knowledge and Vercel-native deployment; the research read both directions and found the boring option dominant for this shape, which is evidence for it.

## Consequences
Bundle size is watched on the old-Android target (an accessibility bar, not polish). Upgrades follow Dependabot (charter §Security). Any Next-specific caching or server-action behaviour is verified against the deployed artefact, not the dev server — the house rule from *verify-the-artefact-not-its-ingredients*.

## Kill condition
Lighthouse mobile performance on the board page below 80 on a mid-range Android after the first three stories, unrecoverable by ordinary optimisation — reopen toward SvelteKit.
