"use client";

/**
 * What a member sees when a page throws (story #154 AC 6): the shell, a sentence, and a way to
 * try again. Next mounts this in place of the page's `<main>`, inside the root layout, so the
 * header and the way out are still there.
 *
 * The owner has already been told by the time this renders: `src/instrumentation.ts` emails
 * every server-side throw (story #43), and this component's job is only to say so to the person
 * in front of it. `reset()` re-renders the route; a throw that was transient (a lost connection
 * on the dock) recovers without a full reload.
 */
export default function RouteError({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  return (
    <main data-route-error>
      <h1>Something went wrong</h1>
      <p role="alert">That did not work on our side. The club admin has been told.</p>
      <p>
        <button type="button" onClick={() => reset()}>
          Try again
        </button>
      </p>
      <p>
        <a href="/board">Back to the board</a>
      </p>
    </main>
  );
}
