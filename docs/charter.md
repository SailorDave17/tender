# Tender — charter

## Metadata
- Status: ratified 2026-08-21
- Owner: HSCCo
- Forge-idea provenance: 2026-08-21 (`forged-idea.md` in this repo)
- Forge checks recorded: 2026-08-22 (#52) — the four external checks answered in #8–#11; claim 1's
  kill condition replaced, see *Forge-idea provenance*
- Decision log: was charter-tender-decision-log.md in cairn auto-memory; deleted when this file landed (2026-08-21)

Tags throughout: *measured* (fetched or run this session), *reasoned*, *reported* (the owner said
so). Every mutable fact is dated.

## Problem & vision

The idea, verbatim: **"Help pair skippers with crew."**

At Hoover Sailing Club, crewed boats (Thistles, Flying Scots, Interlakes) go short-handed or stay
on the trailer **most race days** because the skipper and a willing crew never found each other
(*reported* — the owner, the club's coach, can name the boats). Matching today is ad hoc: the dock,
a text from the coach. The club's earlier shared channel died of three things (*reported*): the
people who needed it were never in it, nobody owned it so it went stale, and nobody could see who
was still unmatched. Skippers refusing to post was **not** one of them.

The unmatched supply is the owner's adult Learn-to-Sail graduates — people who learned to sail
at Hoover and have no route onto a race boat (*reported*). "Learn to Sail – 2026 is now open" is
the club home page's headline and *Adult Classes* its first button (*measured* 2026-08-21).

**Success scene, six months in** (the forge announcement): Tender is the board that says who
still needs a crew for Sunday. A skipper posts a need against a race day; the engine proposes crew
and tells them; someone taps *I can*; the skipper accepts; the board shows the match, and when
everyone is sorted it says so. It is open to anyone who has learned to sail at Hoover, member or
not — a link from the class, not a chat you have to be invited into. The sentence a user repeats:
*"You don't need to know someone to get a ride any more."*

**Failure metric:** fewer than **one match made through the board per race day**, averaged over a
season. Known blind spot: matches it caused that closed by text.

## Users & access

- **Skipper** — owns a boat, posts a need against a race date with a crew minimum, sees who
  answered, accepts one.
- **Crew** — graduate, member or not. Keeps a self-rating (competence) and hull willingness, marks
  availability per date, answers posts, confirms the morning of. The competence scale has **four**
  levels, ordered — never raced, can hike and trim, can fly a spinnaker, can helm (owner decision
  2026-08-23, story #69; a spinnaker hand sits between a trimmer and a helm rather than with
  either). It is what a skipper sets a post's minimum on, and what the engine compares. It is not
  the ladder's three rungs below, which are a different scale.
- **Admin** — the owner, a minimal role: adds race dates (or imports them), invites people, sets
  the club theme, rotates the invite code, reads the failure metric.
- **Identity**: email + password or Google (#82, 2026-08-25; **magic link removed entirely by
  #99, 2026-08-26** — returning members sign in with their email and password, or with Google;
  new members sign up with the invite code and finish **on that screen**, choosing a password and
  landing on the board in the same submission, or with Google, which needs no password. There is
  no emailed sign-in link on any path. A password IS now a first way in, and that reverses what
  this bullet said until #99: the person row was created only at `/auth/callback`, so a member who
  set one at sign-up had to open an emailed link once before it worked. The invite gate mints the
  row itself now, on the authority of the same submission that proved this season's code and
  ticked 18+ — which is exactly the authority `ensurePerson` has always acted on. Reversed
  deliberately and recorded here so it does not later read as an erosion somebody restores.
  Forgot my password is the one screen that still emails anything, and it is the way in for a
  member with no password — anyone from before #82, every Google-only account — because resetting
  sets a first one. Supersedes #70's email-alone sign-in, 2026-08-23.)
  Email is required (it is the login); phone is optional and is exchanged only on a
  closed match. **One person is one account, and may carry more than one way into it** (#74,
  2026-08-24): a member whose Google address differs from the one they joined with links it from
  their profile, so both sign-ins resolve to the same `auth.uid()` — the thing every access rule
  in Data is written against. Merging two accounts after the fact is deliberately not offered.
- **Signup**: gated by an invite code the owner hands out (class handout, invite email); rotated
  in one admin action.
- **Visibility**: posts and profiles visible to every signed-in user; contact details only on
  match.
- **Scale** (*reported*): ~10 skippers / ~30 crew on day 1; ~20 / ~80 by the end of year 1.
- **Adults only** — 18+ attested at signup; no under-18 accounts (structural, see Data).
- **Accessibility**: phone, often outdoors, sometimes on the dock — sunlight legibility, one-hand
  use, large targets, works on a three-year-old Android. WCAG AA is the floor and is a correctness
  bar, not polish.
- **Internationalization**: English-only until revisited (recorded default; one Ohio club).

## Scope

### Core workflows
1. The admin seeds a season — imports an `.ics` or adds dates by hand — and invites people by
   email with the invite code.
2. A crew signs up from the invite, sets competence and hull willingness, installs Tender to the
   home screen (for push), and marks the race days they can sail.
3. A skipper posts a need against a race date: boat class and the minimum competence they will
   take, plus a note.
4. **The engine proposes and notifies.** Rung 1: crew whose hull willingness includes the class
   and whose rating meets the minimum. If none is available — or the clock reaches 48 h before the
   race — rung 2 (**amber**): any hull, rating still meets the minimum. If none, or 24 h before —
   rung 3 (**red**): rating below the minimum. Step-down is on *emptiness or clock, whichever
   first*. Each rung's crew get a push and an email; the board shows which rung a post is on.
5. A crew taps *I can*; the skipper accepts one; contact details (and phone if given) are
   exchanged; the crew gets an `.ics` for the race; a match thread opens.
6. The crew confirms on the morning of the race; a no-show is recorded against the match.
7. Skipper and matched crew message in **a thread per match** (in scope, owner decision; with
   message notifications and a moderation story).
8. The board is always current: every race date of the season, every open need with its rung,
   every match; nothing to curate.
9. The admin reads matches per race day.

### Non-goals
- **No payments, fees or dues.**
- **No race management, results or scoring** — Tender knows a race date exists, never who won.
- **No second club, no cross-club matching** in v1 — one tenant; theming code may exist, the
  product does not promise it.

### Integrations
| Integration | Owner | Limit | Failure mode |
|---|---|---|---|
| `.ics` import of the race calendar (one-off) | admin | ClubSpot has no public API found (*measured* 2026-08-21); `.ics` is the realistic form. **ClubSpot is not a competing crew board here**: the club does not use one, or is not willing to (*reported* 2026-08-22, the club's ClubSpot administrator via the owner, #10) | a bad file seeds wrong dates — admin reviews before publish |
| `.ics` export on match | app | none | attachment missing — match still stands |
| Resend (email: password resets, rung notifications) | owner account | **100/day, 3,000/month** on Free (*measured* 2026-08-21) | cap hit → password resets fail; rule: email the current rung only. *Since #99 (2026-08-26) identity mail is resets only — a sign-up sends nothing at all, so the cap is almost entirely the notifications' now.* |
| Browser push services (VAPID web push) | Apple/Google/Mozilla | iOS requires Home Screen install (*measured*, iOS 16.4+) | silent non-delivery; email is the fallback |
| Supabase Cron (pg_cron) for the ladder clock | project | **works on Free** — enabled and fired every minute for nine minutes on the live project (*measured* 2026-08-22, #12; ADR 004 records the kill condition as not fired). The docs still do not state plan availability; the measurement is the source | the named fallback (lazy relaxation on board read + Vercel's daily sweep) stays unbuilt unless the project is ever moved |

## Data

Entities: club (theme), person (role flags; name, email, optional phone, self-rating, hull
willingness, 18+ attestation), boat (class, default minimum), race_date, availability
(person × date), post (boat × date × minimum × note × current rung), suggestion (post × person ×
rung × notified-at), answer, match (accepted → confirmed → sailed | no-show), message (thread per
match), notification_log.

- **Ownership**: a person owns their record; deletion on request removes profile, availability
  and messages; past matches remain as anonymised rows so the season's metric stays countable.
  Export on request is a SQL dump, not a feature.
- **Sensitivity**: ordinary adult PII. **No minors' data by construction** — adults only, 18+
  attested at signup. This excludes 16–17-year-old crew who race at HSC today; admitting them is a
  separate, deliberate decision with safeguarding in it, not a flag.
- **Consistency**: a stale board read is merely stale, never wrong-answer-wrong.
- **Volume**: ~80 people × ~45 race dates a season — trivial (*reasoned*).

## Non-functional

- **Latency**: board attention-held at ~1 s; a post's notifications out within a minute
  (recorded defaults).
- **Availability**: an hour down on Sunday morning costs a race day; otherwise an inconvenience.
- **Offline**: online only (owner decision). The PWA install is for push, not for caching.
- **Observability**: errors emailed to the owner; nothing else. The failure metric is read by hand.
- **Load shape**: **recorded unknown**. Default in use: spiky on the race calendar — Saturday
  evening, Sunday noon, Wednesday afternoon, ~80 people in two windows, near-zero otherwise. Risk:
  a host that sleeps could delay the notification job. Measure in season one.

## Stack

Tender is a **standalone repo on its own stack**, sharing nothing with burgee for the pilot
(owner decision, 2026-08-21): its pilot must not wait on burgee's unshipped foundations. Rejected:
standalone-on-burgee's-choices (pre-decides the research), burgee module (externally gated).

| Decision | Choice | ADR |
|---|---|---|
| Language/runtime | TypeScript on Node LTS | adr/001 |
| Framework | Next.js 16 (v16.3.2, 2026-08-21) | adr/002 |
| Data layer | Supabase Postgres via supabase-js, RLS, SQL migrations in-repo | adr/003 |
| Hosting & scheduler | Vercel Hobby + Supabase Free; ladder clock as pg_cron | adr/004 |
| CI/CD & branch model | GitHub Actions; `develop` (default) + `release` (production) + feature PRs | adr/005 |
| Testing strategy | Vitest (engine), pglite (RLS), Playwright smoke later; scaffold test = rung selector | adr/006 |
| Notification channel — **the bet** | Web push from an installed PWA + email to the current rung via Resend | adr/007 |

## Security & compliance

- **Threat sketch**: nobody targets Tender. Opportunistic scanners, leaked credentials, and a
  leaked invite code are the threats; the code rotates in one admin action. The match thread is
  the one surface where two people who have never met talk — adults only, and contact details are
  exchanged only after a skipper accepts.
- **Secrets**: env vars in Vercel and Supabase; `.env*` gitignored as a family; no secret key in
  the repo or in any live check.
- **Dependencies**: lockfile pinned; Dependabot weekly; the owner merges on green CI.
- **Regulation**: none beyond ordinary adult PII; delete-on-request honoured.

## Cost & operations

- **Budget ceiling: $0/month** (*reported*), against these cliffs, all read from billing or docs
  pages on 2026-08-21 (*measured*):
  - Vercel Hobby: non-commercial personal use only (a club pilot qualifies); cron **once per day,
    ±59 min** — not used for the clock; 1M function invocations, 4 CPU-hrs.
  - Supabase Free: 2 active projects, 500 MB, 50k MAU, **paused after 7 idle days**; Pro $25/mo.
  - Resend Free: **100/day**, 3,000/month; Pro $20/mo.
  - Supabase built-in mailer: 2/hour, team members only — custom SMTP mandatory.
- **Idle pause**: a free GitHub Actions weekly schedule pings the project so it never idles.
  Caveat recorded: GitHub disables scheduled workflows after 60 days of repo inactivity, so the
  ping needs occasional activity or a spring check.
- **Domain**: **tender.madcowsailing.com** (owner decision) — $0 marginal on the existing
  Cloudflare zone; Resend sends from the subdomain.
- **Operations**: the owner — merge PRs, promote `develop` → `release`, paste migrations, read
  the metric monthly. Nobody is on call.

## What must become true

**A stranger can get a ride without knowing anyone.** HSC's racing stops being a closed social
graph. Nothing the club uses today does this: the chat, the sheet and the coach's text all require
being known.

## Signature moment

**Mechanism — no signature moment claimed** for design-bar routing. The moment the bet sits on is
a skipper's post landing on every suggested crew's phone; ADR 007 carries it as the bet, not as an
experience to judge before decomposition.

## Forge-idea provenance

Verdict **Hardened — owner-asserted** (no bet at forge; the bet was minted in Phase 6). Claims:

| # | Claim | Tag | Kill condition |
|---|---|---|---|
| 1 | Pairing fails most race days at HSC; the owner can name the boats | reported — checked 2026-08-22 (#8): **not countable**, see below | **replaced 2026-08-22 (#52)**: the owner's dock tally over the first month of the 2027 season averages fewer than one boat per race day ashore or short-handed for want of crew |
| 2 | Skippers will post a need — they did in the dead chat | reported | a live board gets no skipper posts in a month |
| 3 | The unmatched supply is the owner's class graduates, reachable through the owner | reported — checked 2026-08-22 (#9): **positive**, see below | they wanted to sail, not to race |
| 4 | The channel died of reach, ownership and state — not matching | reported | a board with all three fixed still dies |
| 5 | What must stay true: the owner is the coach with the roster | reasoned | owner stops coaching → channel dies |
| 6 | Cost of being wrong: ~$0, the owner's time, club trust | reasoned | a second dead tool makes a third impossible |

### Forge checks — answered 2026-08-22

The handoff's four external criteria became stories #8–#11 and all four closed on 2026-08-22. The
answers lived only in issue comments until #52 wrote them here. None of the four is *measured* in
this document's sense — each is the owner reporting a conversation — so the tags above stay
*reported*, now with a date and a source.

| Check | Story | Answer | What changed here |
|---|---|---|---|
| Last season's count of boats ashore or short for want of crew | #8, closed 0/2 | **Cannot be taken.** The club keeps no such record — "the data is not saved, but I can tell you it happens often" (owner, 2026-08-22) | Claim 1's kill condition named a results sheet that does not exist, so it could never fire or fail to fire. Replaced by a **prospective** instrument: the owner, as coach at the dock, notes per 2027 race day whether a boat stayed ashore or sailed short for want of crew; kill fires if the first month averages under one boat per race day. Chosen over the live board's post count (owner decision, 2026-08-22) because a quiet board cannot separate *no need* (claim 1) from *skippers won't post* (claim 2), and the two claims need separate instruments. Claim 1 stays *reported* until that tally exists |
| Five class graduates would crew a race boat on a Sunday | #9, closed 2/2 | **Positive** — "we had plenty of positive answers" (owner, 2026-08-22). Kill condition not fired | The per-person race / sail-only / no tally #9's criterion asked for was **not recorded**, so the count behind "plenty" is unknown and claim 3 does not become *measured*. 'Invite people by email with the invite code' (#31) is unblocked on this axis |
| ClubSpot has no crew board at HSC | #10, closed 2/2 | "The club does not use one, or is not willing to" (the club's ClubSpot administrator via the owner, 2026-08-22). Epic does not pause | Integrations row for `.ics` import now carries it. The field check in `forged-idea.md` had found no ClubSpot crew board by search without proving it absent; this closes it for *this* club, which is the only one v1 serves |
| The club accepts its burgee colours in the app | #11, closed 2/2 | **Consent** — "all good here" (HSC leadership via the owner, 2026-08-22) | The Hoover pair `#395FAC` / `#FCCF0B` (`brand/`) is the club row's theme. No migration seeds the club row — `0001_club.sql` creates the table and inserts nothing — so #11's second criterion ("README's runbook seed … changed to the Hoover pair") had no file to change on 2026-08-22. **The seed now lives in README's owner runbook, step 1** (added by #64 on 2026-08-23 after the live project's empty `club` table stopped every sign-in), carrying the Hoover pair and `admin_email`; #41's seed criterion, written before this answer and naming the default green, is a colour check against that statement rather than a new one |

Correction carried from discovery: the forge recorded the ladder as a rating that colours people;
Phase 2 established it is the **engine's relaxation order**, the colours showing how far it
relaxed. `forged-idea.md` is corrected to match.

## Recorded unknowns

| Question | Default in use | Risk | What settles it |
|---|---|---|---|
| Load shape | spiky on the race calendar | a sleeping host delays the notification job | season-one metrics |
| Brevo as an email fallback | not used | none until Resend's cap bites | read its pricing page when needed |

### Resolved

| Question | Was | Resolved | How |
|---|---|---|---|
| pg_cron on Supabase Free | assume available; fallback = lazy relaxation on board read + daily Vercel sweep | **available** (2026-08-22, #12) | enabled on the live project and fired every minute for nine minutes; ADR 004 records the kill condition as not fired and the fallback stays unbuilt |

## Handoff

*Consumed by `groom-backlog` on 2026-08-22 (epic #7, stories #8 onward). Kept verbatim below as
the record of what was handed off — so its four `external_criteria_candidates` still read as open
questions. They became #8–#11 and are answered under **Forge checks** above; the pg_cron candidate
is answered in **Resolved**.*

```yaml
charter_handoff:
  project: Tender
  repo: SailorDave17/tender
  stack:
    language: TypeScript on Node LTS
    framework: Next.js 16
    data: Supabase Postgres via supabase-js, RLS, SQL migrations in-repo
    hosting: Vercel Hobby (production branch release) + Supabase Free; ladder clock as pg_cron
    ci: GitHub Actions; develop default/integration, release = production, feature PRs; house pre-push hook
  constraints:
    - "adults only: 18+ attested at signup; no under-18 accounts anywhere in the data model"
    - "signup requires the current invite code; the admin can rotate it in one action"
    - "contact details (email, phone if given) are revealed only after a skipper accepts a match"
    - "email notifications go to the current rung only, never the whole pool (Resend 100/day)"
    - "push goes to every crew on the current rung; a crew with no PWA install gets email only"
    - "the ladder steps down on emptiness OR on the clock (48 h before: rung 2; 24 h: rung 3), whichever first"
    - "the ladder colours and orders; it never hides a crew from a skipper"
    - "the skipper chooses from those who answered; the engine never assigns"
    - "a deleted person vanishes from profiles, availability and threads; past matches stay as anonymised rows"
    - "online only: no offline writes, no cached-board promise"
    - "one tenant; club theming is two hex values with contrast >= 3.0 enforced at save"
    - "budget $0/month: no paid tier without an owner decision"
    - "merging into develop deploys nothing; promotion develop -> release is the deploy and is the owner's"
  non_goals:
    - "No payments, fees or dues"
    - "No race management, results or scoring"
    - "No second club, no cross-club matching"
  external_criteria_candidates:
    - "last season's count of boats that did not sail for want of crew — needs the club's results sheet or the fleet captain"
    - "five class graduates say they would race, not just sail — needs the owner to ask them"
    - "HSC's ClubSpot has no crew-board feature — needs a question to the club's ClubSpot administrator"
    - "the club does not object to its burgee colours in the app — needs a club conversation"
    - "PWA install rate in the first cohort (bet trigger: < 50% after two weeks) — needs a live cohort"
    - "web push delivered to an installed PWA on a real iPhone — needs an iPhone"
    - "pg_cron enabled on the real Supabase Free project — needs the project to exist"
    - "password-reset email delivered from tender.madcowsailing.com — needs the DNS records in the Cloudflare zone (this read *magic-link email* until #99 removed that mechanism, 2026-08-26; the DNS records and the check are unchanged)"
  signature_moment: "mechanism: none"
  budget_ceiling_monthly: 0 USD
```
