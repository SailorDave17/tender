/**
 * The missing-route page (story #154 AC 6): a route that does not exist, or a `notFound()` from a
 * page that will not show this person the row they asked for — `/post/[id]` and `/admin/dates/[id]`
 * both answer that way, so the sentence covers both readings rather than promising the page is
 * absent. Rendered inside the shell, with the way back.
 */
export default function NotFound() {
  return (
    <main data-not-found>
      <h1>Not here</h1>
      <p>That page does not exist, or it is not one you can see.</p>
      <p>
        <a href="/board">Back to the board</a>
      </p>
    </main>
  );
}
