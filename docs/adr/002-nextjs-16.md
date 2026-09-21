# ADR 002 — Next.js 16 as the framework

- Status: accepted 2026-08-21
- Phase: 6

## Context
A phone-first PWA with server-side routes for magic-link auth, Supabase access and push dispatch, deployed to Vercel Hobby (ADR 004). Novelty is spent on the engine and the bet (ADR 007), not here.

*2026-08-26 (#99): the magic link is gone — sign-up finishes in a session and the only identity mail left is a password reset. The wording above is kept as written because it records what was decided in phase 6 on the information of the day; server-side auth routes are still what the framework was chosen for, so the decision is untouched by the change.*

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

### Measured 2026-09-21 (#44): the local antecedent is met; the ADR's own condition is NOT yet established

**`/board` reads 72** (72 / 78 / 72) against a floor of 80, on a production build served locally.
`/post/[id]` reads 83 (90 / 78 / 83) — a median that passes with one run below the floor.
Accessibility is 96 on both and CLS is within its floor on both. Full method, fixture, control arms
and the measured-viewer caveat: [`../performance-floor.md`](../performance-floor.md).

The second half of the condition — *unrecoverable by ordinary optimisation* — was tested rather
than assumed, with three app-level levers each priced as its own arm:

| lever | effect on `/board` |
|---|---|
| `prefetch={false}` on every board link (kept; 27 requests → 13) | ~3 points |
| document cut by 71% (10 dates instead of 45) | **none** |
| both client components removed entirely | **none** |
| framework JS blocked — a bound, not a shippable fix | **96** |

The binding constraint is the **455 KB React/Next client runtime**, which Next ships to every route
regardless of whether the route uses a single client component, and which Lighthouse's simulator
prices onto the slow-4G critical path because it lands before the observed first paint. That is the
thing this ADR chose, which is why the reading routes here and not to a board story.

**The condition has not fired, because this instrument cannot fire it.** The ADR says *below 80 on
a mid-range Android*; what was measured is below 80 on **localhost**, and for this page shape those
two differ in a known direction. cairn's
`lighthouse-simulated-scores-race-the-font-files-2026-09-04` records a page of the same shape — one
where every resource finishes before the observed first paint locally — reading **79 locally and
87 / 88 / 86 on production**, because localhost has no latency, so everything lands before the paint
and everything is priced as render-blocking. If that ~8 points carries, `/board` reads about 80 on
`release` and the condition is not met at all.

So, precisely:

- **Below 80 locally: established** (72, three runs, none near the floor).
- **Unrecoverable by ordinary optimisation: supported** (three levers priced, two at zero).
- **Below 80 on a mid-range Android: NOT established**, and not establishable from a local serve.

**What settles it, in order.** Run the same command against the deployed `release` build; that is
one measurement and it decides whether this section becomes a framework decision or a footnote. Only
if it confirms sub-80 does the second question arise — what the board costs under a framework that
ships no client runtime by default, which is the comparison this ADR's option list already names.

One fact that cuts against a framework verdict either way: `/post/[id]` reads 83 carrying the
identical runtime, so the runtime does not sink a page on its own — it sinks a page that also pays
a long render.

*Status stays `accepted`. This records a measurement and the one run that would make it decisive,
not a decision.*
