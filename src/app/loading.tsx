/**
 * What a member sees while a route's data is still on its way (story #154 AC 6) — inside the
 * shell, with a sentence, rather than a blank page. Next renders this in place of the page's
 * `<main>` until the page resolves, so the frame around it is the layout's and stays put.
 */
export default function Loading() {
  return (
    <main>
      <p role="status" data-loading>
        Loading…
      </p>
    </main>
  );
}
