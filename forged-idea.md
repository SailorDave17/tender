# Tender — forged idea

Written by `forge-idea`, 2026-08-21. Handoff for `charter-project`. Tags: *measured* (ran it, read
the output), *reasoned* (follows from something measured), *reported* (the owner said so).

## The idea, verbatim

> Help pair skippers with crew

Owner's words (repo README). Session goal was *sharpen something half-decided*; the owner was open
to refinement.

## What survived

A **race-day board for Hoover Sailing Club** that is always true, that people outside the club's
chat can find, and that needs nobody to curate it — with the notification as the product and the
board as the record. First crew pool: the owner's adult Learn-to-Sail graduates. A **match ladder**
that is the engine's relaxation order — strict (hull + competence) → amber (any hull) → red (below
the stated minimum), stepping down when a rung is empty or the clock runs — whose colours show how
far it relaxed; it never hides anyone. *(Corrected 2026-08-21 in charter-project Phase 2: this file
first described the ladder as a self-rating that colours people, which is the consequence, not the
mechanism — the owner's words were "uses logic to suggest pairs... laddering that logic down to less
selective criteria as matches can't be made".)*

Multi-club theming and cross-club matching are **deferred, not dead**. They were in the Claude
Desktop brand notes and not in the owner's sentence.

## Verdict

**Hardened — owner-asserted.** Claims 1 and 3 below are *reported*, not *measured*; the owner is the
club's coach and sees the whole fleet, which is a legitimate source of one. If either is wrong, this
is where it was decided. The two checks that would convert them to *measured* are listed under
*Still unchecked* and cost a week.

*2026-08-22 (#52): all four checks ran as stories #8–#11 and none converted a claim to* measured.
*Claim 1's count **cannot be taken** — the club keeps no such record — so its kill condition was
replaced with a prospective dock tally; claim 3's answer was positive but the per-person tally was
not kept. The record is `docs/charter.md` § Forge checks; the tables below are left as the forge
wrote them.*

## Load-bearing claims

| # | Claim | Tag | Kill condition | How to check |
|---|---|---|---|---|
| 1 | Pairing fails most race days at HSC; the owner can name the boats | reported | Last season's results show few boats missing for want of crew | results sheet (ClubSpot regatta module) or the fleet captain |
| 2 | Skippers will post a need — they did in the dead chat | reported | A live board gets no skipper posts in a month | the pilot itself |
| 3 | The unmatched supply is the owner's class graduates, reachable through the owner | reported | They wanted to *sail*, not to *race* | ask five graduates |
| 4 | The cheap version died of reach, ownership and state — not of matching | reported | A board with all three fixed still dies | only the build tests it |
| 5 | What must stay true: the owner is the coach with the roster | reasoned | Owner stops coaching → channel dies → ownership failure one level up | name a successor channel in the charter |
| 6 | Cost of being wrong: ~$0 money, owner's time, **club trust** | reasoned | A second dead tool makes a third impossible | — |

The problem, in the owner's account: matching happens ad hoc; it fails **most race days**; the club
tried a shared channel and it died because (a) the people who needed it were not in it, (b) nobody
owned it so it went stale, (c) nobody could see who was still unmatched. *Skippers would not post*
was explicitly **not** one of the causes.

## Checked in session (measured)

- **HSC's site runs on ClubSpot** (`theclubspot.com` assets, `membership_directory`, `boats_map`).
  Club racing: Sundays April–October, Wednesdays May–August, ~45 race days a season. Crewed fleets:
  Thistles, Flying Scots, Interlakes; Lasers, MC Scows and most non-fleet boats do not need crew.
  "Learn to Sail – 2026 is now open for enrollment" is the home-page headline and *Adult Classes* is
  the first button — the reach channel is the club's front door.
- **ClubSpot has no crew board that a search finds.** *Not proven absent.* One question to HSC's
  ClubSpot administrator settles it, and it is the cheapest possible "already solved".
- **Already solved, both directions.** The cross-club marketplace exists many times over (Find a
  Crew, Coboaters, Crewseekers, SailingClubManager's Crew Finder, per-club Crew Finder pages at
  Chicago YC and Constitution YC). Every one read is a **standing-profile directory**, not a
  per-race-day board showing current unmatched state. *Reasoned* from overview pages: argues
  against building the marketplace and for the board being open ground.
- **cairn has no prior record of this idea**; the only "crew" hits are RegattaHub's crew-list
  feature in the burgee landscape note and pro-companion's crew briefing.

## The announcement (Phase 2)

> Tender is the board that says who still needs a crew for Sunday. A skipper taps *need one*
> against a race day; someone who wants to sail taps *I can*; the board shows the match, and when
> everyone is sorted it says so. It is open to anyone who has learned to sail at Hoover, member or
> not — a link from the class, not a chat you have to be invited into.
>
> For a skipper it means the boat goes out. For the person who finished the adult class in June and
> has not been on the water since, it means a way onto a race boat without having to know anyone.
> The sentence they repeat: *"You don't need to know someone to get a ride any more."*

Read on experience-vs-mechanism for `design-bar`: **mechanism**, with one signature moment — a
skipper's post landing on every graduate's phone. The board itself is a record, not an experience.

Sceptical-user questions and the honest answers:

1. *What is on the board the week nobody posts?* The schedule — 45 race dates exist before anyone
   posts, so the board is never blank, only unclaimed.
2. *Why would a skipper take a stranger rather than text a friend?* They would not, first. The board
   is the fallback when the friend is busy, so the app serves **residual** demand — claim 1's count
   must be of boats that *did not sail*, not boats whose first-choice crew was out.
3. *Who keeps it current?* Nobody. Dates expire posts; a match closes one. If it needs a curator it
   dies as the sheet did.

## Attack (Phase 4)

Pre-mortem, a year on: *Tender has fourteen accounts. Skippers posted in April, took a stranger
twice, one never showed at the ramp, and they went back to texting. The graduates joined in June,
opened a board with nothing posted for Wednesday, and never opened it again.*

Two causes, both now requirements rather than notes:

- **Cold start on a two-sided board at one club.** Skippers post only when desperate; graduates
  look only when hopeful; at ~10 crewed boats the moments rarely coincide. Mitigation (*reasoned*):
  a skipper's post goes straight to every graduate's phone. Without that the board is the sheet
  with a login.
- **The no-show.** A match between strangers has no cost to break. Exchange phone numbers on
  match; crew confirms the morning of.

Externally gated: nothing on the critical path of a private pilot. Beside it: using HSC's burgee
colours in an app the club has not sanctioned, and the ClubSpot question above — one conversation
each.

Steelman of *do nothing*: a Saturday-night text from the coach matches more boats than any board
will in its first season. True — and it is claim 5. The app's honest purpose is to make the
matching survive without the coach.

## Rejected, and why

- **Coach-set competence rungs** — recommended in session, rejected by the owner: work the coach
  does forever, and it covers only people the coach taught.
- **Weight against the boat's target** — people will not post it; a blank field reads as refusal.
- **Multi-club from day one** — deferred: it trades the one reach channel the owner controls for a
  club committee's yes, and makes the claims uncheckable without another club.
- **The ladder as a filter** — a wrong self-rating would then exclude rather than warn. It colours.
- **Availability-only with no ladder** — the owner's first answer, reversed at the narrowing gate:
  the engine must suggest pairs, relaxing its criteria when nobody strict is available.

## Still unchecked — all four answered 2026-08-22

1. Count last season's boats that did not sail for want of crew (claim 1 → *measured*). **#8:
   not countable** — no record is kept; "it happens often" (owner). Claim 1 stays *reported*; its
   kill condition is now a prospective dock tally (`docs/charter.md` § Forge checks).
2. Ask five graduates whether they would *race* (claim 3 → *measured*). **#9: positive** —
   "plenty of positive answers"; the per-person tally was not recorded, so still *reported*.
3. Does HSC's ClubSpot have a crew feature? (ask the administrator) **#10: the club does not use
   one, or is not willing to.** The "not proven absent" above is closed for this club.
4. Does the club mind its burgee colours in the app? (one conversation) **#11: consent.** The
   Hoover pair is the club row's theme; the seed itself lands with #41.

## For charter-project

- Stack decision to make with evidence: **standalone repo vs a `burgee` module** — burgee is club
  management on Next.js + Supabase + Vercel, and RegattaHub already lists "crew management".
- The notification channel is load-bearing (cold start) — SMS, push, or email, priced against the
  free tiers this workspace already uses.
- Name the successor channel for claim 5.
- The Claude Desktop brand output (mark set, `TenderMark.jsx`, contrast policy, club theming) is in
  the owner's Downloads folder, not yet in this repo. It encodes multi-club theming and a match
  ladder whose "below your minimum" is now defined as self-rated competence + hull willingness.
