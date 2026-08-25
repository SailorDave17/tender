import { explainLanding } from "@/auth/landing";

// *Measured 2026-08-24*: this line is INERT today — awaiting `searchParams` already opts the page
// into dynamic rendering, and `next build` marks `/` as `ƒ` with the line deleted. It is kept as a
// defence rather than as a load-bearing setting: if a later change moves the message-reading into a
// child component, the page could go back to being prerendered and the message would silently stop
// appearing, which is exactly the defect #83 exists to remove. Said out loud because an unexercised
// defence is indistinguishable from dead code to whoever is tidying up.
export const dynamic = "force-dynamic";

/**
 * The landing page — and, since #83, the one place a whole class of sign-in failure can be seen.
 *
 * GoTrue's provider callback sends `loadFlowState` failures to the project's **Site URL**, which is
 * `/`, rather than to the flow's own `redirect_to`. So a member whose OAuth state expired or had
 * already been used arrives HERE with the reason on the query string, and until this page read it
 * they saw the ordinary home page: no message, no error, nothing to distinguish it from having
 * simply visited the site. `src/auth/landing.ts` holds the decision and the reasoning.
 *
 * With no such parameters the page renders exactly as it did before — `explainLanding` answers
 * `null`, and an ordinary visit is the overwhelming majority of them.
 */
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<{ error?: string; error_code?: string; error_description?: string }>;
}) {
  const { error, error_code, error_description } = await searchParams;
  const message = explainLanding({ error, error_code, error_description });

  return (
    <main style={{ padding: "2rem", fontFamily: "system-ui, sans-serif", maxWidth: "32rem" }}>
      <h1>Tender</h1>
      {message && (
        <p role="alert" data-landing-error>
          {message} <a href="/join">Back to sign in</a>
        </p>
      )}
      <p>The board that says who still needs a crew for Sunday.</p>
      <p>
        <a href="/join">Sign in with this season&apos;s invite code</a> — the board itself arrives
        with the next stories.
      </p>
    </main>
  );
}
