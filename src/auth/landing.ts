import { explainReason } from "./callback";

/**
 * What the landing page does with a query string GoTrue put there (#83).
 *
 * Every other failure in these flows comes back through `/auth/callback`, where `decideCallback`
 * names it and `/join` (or `/profile`, since #74) shows a sentence. One class never reaches that
 * route at all: GoTrue's provider callback runs `loadFlowState` as *middleware*, and when
 * `loadExternalState` fails it redirects to the project's **Site URL** rather than to the flow's
 * own `redirect_to`, with the reason in the query string. Site URL is `/`, so the member lands on
 * the home page — which, until this module, read no `searchParams` at all.
 *
 * *Measured 2026-08-24*, unauthenticated and read-only, against the live project: the landing page
 * was **byte-identical (6440 bytes) with and without those parameters**. The failure was not merely
 * unexplained, it was invisible — they pressed *Continue with Google*, went to Google, came back,
 * and were looking at the ordinary home page.
 *
 * The repair belongs here rather than in `/auth/callback`, because `redirect_to` is ignored on this
 * path by construction. Pointing Site URL at a dedicated page was rejected at filing: Site URL is
 * also where confirmation emails resolve their links. Redirecting `/` to `/join?error=…` was
 * considered and rejected here: AC 1 asks that the page tell them, and a page that never renders
 * cannot, while a bounce off the home page for anyone who arrives with a stray `error` parameter is
 * a surprise the message itself does not need.
 *
 * ## What GoTrue can send this way
 *
 * `error_code` is the contract; `error_description` is prose the project does not control, so the
 * decision keys on the code alone — ONE mechanism per branch, the rule `src/auth/link.ts` states
 * and the shape cairn records as `prove-a-guard-test-can-fail`'s sixteenth outcome.
 *
 * From `supabase/auth` `internal/api/external.go`'s `loadExternalState`, all three verified live on
 * 2026-08-24 where a probe could produce them:
 *
 *   `bad_oauth_state`          "OAuth state parameter is invalid"      *measured*
 *   `bad_oauth_state`          "OAuth state not found or expired"      *measured*
 *   `bad_oauth_state`          "OAuth state has expired"               source only
 *   `bad_oauth_callback`       "OAuth state parameter missing"         *measured*
 *   `flow_state_already_used`  "State has already been used"           source only
 *   `user_not_found`           "Linking target user not found"         source only
 *
 * The issue named three of those. `bad_oauth_callback` was found by probing the same endpoint with
 * no `state` at all, and it is not a new sentence: a callback arriving with its state parameter
 * missing is exactly what `missing-code` already says — "That link was incomplete." The window is
 * **5 minutes** from flow-state creation, so it starts when the member presses the control, not
 * when they reach Google, which is why "took too long" is the honest reading of an expiry here.
 *
 * `bad_oauth_state` covers a mangled state as well as an expired one, and they share a sentence
 * deliberately: separating them would mean matching on the description, and a member who has
 * hand-edited or truncated the URL needs the same instruction as one who was slow.
 */
export type LandingQuery = {
  error?: string | null;
  error_code?: string | null;
  error_description?: string | null;
};

/**
 * The reason key `explainReason` renders, or `null` when GoTrue left nothing here — which is the
 * ordinary visit, and must leave the page exactly as it was.
 */
export function decideLanding(q: LandingQuery): string | null {
  if (!q.error && !q.error_code && !q.error_description) return null;
  switch ((q.error_code ?? q.error ?? "").toLowerCase()) {
    case "bad_oauth_state":
      return "state-expired";
    case "flow_state_already_used":
      return "state-used";
    case "bad_oauth_callback":
      return "missing-code";
    default:
      return "provider-error";
  }
}

/** The sentence to show, or `null` for an ordinary visit. One call for the page to make. */
export function explainLanding(q: LandingQuery): string | null {
  const reason = decideLanding(q);
  return reason === null ? null : explainReason(reason);
}
