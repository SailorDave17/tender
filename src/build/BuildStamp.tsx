import { describeStamp, readStamp, type BuildStamp as Stamp } from "./stamp";

/**
 * The footer every page ends in (#169): `Tender v0.1.0 · 3c7759e · feature/x · built 2026-09-19`.
 *
 * Rendered from the root layout, so it needs no page to remember it. The inline frame matches the
 * pages' own `<main>` styling for now; #154's shell replaces both with one frame.
 *
 * An unstamped build says so in words. Rendering nothing would make "the stamp is missing"
 * indistinguishable from "this page has no footer", and the whole point of the stamp is that the
 * page answers the question rather than leaving it open.
 */
export function BuildStamp({ stamp = readStamp() }: { stamp?: Stamp }) {
  const r = describeStamp(stamp);
  return (
    <footer
      data-build-stamp
      style={{ padding: "0 2rem 2rem", fontFamily: "system-ui, sans-serif", maxWidth: "32rem", color: "#555" }}
    >
      <small>
        {r.version === null ? (
          <span data-build-unstamped>Tender · unstamped build</span>
        ) : (
          <>
            Tender <span data-build-version>v{r.version}</span>
            {r.sha && (
              <>
                {" · "}
                <span data-build-sha>{r.sha}</span>
              </>
            )}
            {r.ref && (
              <>
                {" · "}
                <span data-build-ref>{r.ref}</span>
              </>
            )}
            {r.date && r.builtAt && (
              <>
                {" · built "}
                <time dateTime={r.builtAt}>{r.date}</time>
              </>
            )}
          </>
        )}
      </small>
    </footer>
  );
}
