# ADR 008 — jsdom + Testing Library, per test file, for claims that only exist after a click

- Status: accepted 2026-08-26
- Phase: 6
- Extends [ADR 006](006-testing-strategy.md), which is unchanged: this adds a fourth instrument
  inside vitest rather than reversing anything it decided.

## Context
Until #100 this repo had one component-test idiom: `renderToStaticMarkup`, asserting the HTML a
member is served. It is the right instrument for anything decided at render time and it is what
every other `.test.tsx` file uses — `src/install/InstallBanner.test.tsx` says in band why
(*"its whole decision is in a `useEffect`, which does not run under `renderToStaticMarkup`"*).

#100 asked for two claims that instrument structurally cannot reach, because both are about what
happens **after an event**: that a visibility toggle flips *one* password box and not the other, and
that pressing a toggle inside a form submits nothing. *Measured 2026-08-25*: `environment: "node"`,
no jsdom, no happy-dom, no testing-library in `package.json`, and a grep of `src/` and `test/` for
`fireEvent`, `userEvent`, `.click()`, `dispatchEvent` or `@vitest-environment` returned nothing.

The reassuring artefact was the directory: a shelf of `.test.tsx` files makes *component test* read
as a solved genre. A file extension names what a test is **about** and says nothing about what it
can **observe**.

*(An earlier draft of this ADR said there were five such files three times over. There were six:
the count came from #100's grounding pass on 2026-08-25 and `sign-in-screens.test.tsx` landed
with #99 later the same day. It is not restated as a number here, because the count is
load-bearing nowhere and the next `.test.tsx` would falsify it again — which is this ADR's own
subject matter. Caught by review-fanout, 2026-08-26.)*

## Options considered
- **jsdom + `@testing-library/react`, opted into per file** — the two event-shaped claims become
  ordinary tests. Costs three devDependencies and a second idiom in a repo that deliberately had one.
- **A pure reducer plus static renders of the four visibility states** — no new dependency, and it is
  what the existing files would suggest. Rejected by the owner at filing: a reducer test proves
  the state transition and says nothing about whether either button is *wired* to it, and the claims
  are about interaction.
- **A separate story for the harness** — keeps #100 small at the cost of leaving the click untested
  for as long as that story sits. Rejected for the same reason.
- **Playwright** — ADR 006 already parks this as *smoke, later*. A browser for two component claims
  is the wrong weight, and it would not have run in CI on this story's timeline.

## Decision
jsdom + `@testing-library/react` + `@testing-library/dom`, opted into with a
`// @vitest-environment` docblock on the **first line of each interactive test file**, never
through a config key.

Per file because the declaration belongs beside the tests that need it: a reader of an
interactive file sees on line 1 why `render` works there, and adding a jsdom file needs no config
change and no second place to look. `vitest.config.ts` stays `environment: "node"`, which is
what every other test file wants and what `test/harness-budget.test.ts` asserts as its positive
control.

*(An earlier draft justified this with a mechanism that does not exist: it claimed an
`environmentMatchGlobs` entry would defeat `harness-budget.test.ts`'s comment stripper. It would
not — #78's own repair replaced that block-comment pass with a line-by-line strip, and
`environmentMatchGlobs` is not one of the pool keys that file forbids, so a config-level opt-in
would redden nothing there. The preference above is a preference, and is now recorded as one
rather than dressed as a constraint. Caught by review-fanout, 2026-08-26.)*

`vitest.config.ts` therefore stays `environment: "node"` and is unchanged by this ADR.

## Consequences
- Two files use this today: `src/auth/PasswordFields.test.tsx` and `src/app/join/JoinForm.test.tsx`.
  Everything else stays on `renderToStaticMarkup`, which remains the default; reach for jsdom only
  when the claim is about an event.
- Testing Library's automatic cleanup never registers here, because this repo runs vitest with
  `globals: false`. Every interactive file calls `cleanup` in its own `afterEach` by hand.
- **Each interactive file must declare the environment exactly once, and that is load-bearing.**
  *Measured on #100*: vitest matches that directive **anywhere in a file, comments included**, so a
  docblock quoting it in full declares the environment a second time — after which deleting the real
  line reddens nothing. Three arms: quote present and line 1 deleted → **0 of 8** red; both gone → 8
  of 8; line 1 restored and the quote neutralised → 8 pass. `PasswordFields.test.tsx` holds the count
  at one, with its needles built from fragments so the guard cannot arm what it is checking for.
- **jsdom has no layout engine**, so geometry cannot be asserted here — every box measures 0×0. A
  claim about rendered size is a proxy in this harness (both toggles carrying one short label and one
  width floor) with the real numbers measured in a browser and recorded on the PR. #100's AC 11 is
  the worked example.
- CI gains no new step: `npm test` already runs it.

## Kill condition
A third interactive file needing the harness, or any need to assert rendered geometry. Either means
this has outgrown a per-file docblock and should be reopened toward ADR 006's parked Playwright smoke
suite, where a real browser makes both the environment and the layout ordinary rather than proxied.
