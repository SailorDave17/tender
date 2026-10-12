import type { ReactNode } from "react";

/**
 * A region that scrolls sideways on purpose (story #251): the admin screens' data tables, which
 * are wider than a phone at any text size once they carry more than two columns. The page itself
 * must never scroll sideways (WCAG 1.4.10), and a table is the one thing 1.4.10 exempts, because
 * its two dimensions are the content: squeezing seven columns into 320px breaks every word in it.
 *
 * It is a Tab stop with a name (`role="region"` and the label) so a keyboard can scroll it with the
 * arrow keys and a screen reader says what it is. Chrome makes a scroller focusable by itself only
 * when nothing inside it is, and every table here has links, so without `tabIndex` the columns past
 * the last link could not be reached from the keyboard at all.
 *
 * `data-scroll-x` is also what `test/reflow.test.ts` reads as "scrolls on purpose", so a table
 * outside one of these still reddens the sweep.
 */
export function ScrollX({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div data-scroll-x role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}
