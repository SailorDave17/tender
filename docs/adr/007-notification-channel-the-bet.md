# ADR 007 — Web push from an installed PWA + email to the current rung via Resend (the deliberate bet)

- Status: accepted 2026-08-21
- Phase: 3 (channel), 6 (provider, bet)

## Context
The forge pre-mortem made the notification the product: a two-sided board at ~10 crewed boats dies of cold start unless a skipper's post reaches crew's phones. Identity is an email magic link (phase 2), so email exists anyway; the question is what reaches a phone on Saturday night. SMS was rejected at phase 3: US A2P 10DLC registration is an external gate measured in weeks, plus per-message cost.

## Options considered (*measured* 2026-08-21 unless noted)
- **Web push from an installed PWA + email** — push is free (VAPID, browser push services); iOS delivers web push only to Home Screen web apps, since 16.4 (webkit.org). Email via **Resend Free**: 3,000/month, **100/day**, 3 domains. At 80 crew, a post emailed to the whole pool burns the day in two posts.
- **SMS via a provider** — reaches any phone; A2P 10DLC gate and per-message cost (*reasoned*; rejected at phase 3, not priced).
- **Email only** — zero cost, zero gate; Saturday-night posts die in inboxes; the cold-start mitigation is unmet.
- Providers rejected: Amazon SES (AWS account, IAM, sandbox exit — days), Brevo (pricing page did not render this session — unverified).

## Decision
Push to every crew on the current rung; **email to the current rung only, never the whole pool**. Resend Free as the SMTP for both magic links and notifications, sending from tender.madcowsailing.com.

## Consequences
- PWA install is an onboarding step the invite walks a crew through; a crew who never installs gets email only.
- The engine's rung membership bounds the daily email count; the admin view shows the day's send count against 100.
- Supabase's built-in mailer is never used in production (2/hour, team members only).

## Kill condition — and the named fallback, because this is the bet
**Trigger**: fewer than half the first cohort has installed the PWA two weeks after invitation. **Fallback**: push becomes best-effort and the email rule tightens to *every rung change emails its rung immediately*; if Resend's 100/day then bites, the decision is Resend Pro at $20/month — which breaks the $0 ceiling and is therefore an owner decision, not a setting. A second, independent kill: iOS web push measured undelivered on a real iPhone at scaffold — same fallback.
