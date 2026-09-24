/**
 * The docked navigation's real height, as `--dock` on `<html>` (story #217).
 *
 * On a phone `[data-nav][data-signed-in]` is fixed to the bottom edge (`globals.css`), and two
 * things have to stay clear of it: the page's foot (`body`'s bottom padding) and the install
 * sheet. Both read `--dock`. The stylesheet sets it to 3.5rem, which is the nav's height only when
 * its links fit on one row. *Measured*: 56px for a crew member at 320–412px, but **104px** with
 * the Admin link at 360px or narrower, and **69–129px** for anyone at 125% text. CSS cannot read
 * another element's height, so this does, and writes it inline on `<html>`, where it beats the
 * stylesheet's fallback. Where the nav is not fixed (a wider screen), the inline value is removed
 * and the stylesheet decides again.
 *
 * SELF-CONTAINED ON PURPOSE: no imports and no closure over module state, so
 * `test/install-sheet.test.ts` can hand this exact function to Chrome with `page.evaluate` and
 * measure the page the way a member's browser will. Returns the teardown.
 */
export function watchDock(): () => void {
  const root = document.documentElement;
  const nav = document.querySelector<HTMLElement>("[data-nav][data-signed-in]");
  if (!nav || typeof ResizeObserver === "undefined") return () => {};
  const apply = () => {
    if (getComputedStyle(nav).position === "fixed") root.style.setProperty("--dock", `${nav.getBoundingClientRect().height}px`);
    else root.style.removeProperty("--dock");
  };
  apply();
  // The nav's height moves with the text size and the viewport's width, and crossing the
  // phone breakpoint changes its position — every one of those resizes the nav itself.
  const observer = new ResizeObserver(apply);
  observer.observe(nav);
  return () => {
    observer.disconnect();
    root.style.removeProperty("--dock");
  };
}
