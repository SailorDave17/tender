/**
 * The install sheet's real height, as `--install-sheet` on `<html>` (story #217).
 *
 * While the sheet shows, the page makes room for it at its foot and scrolls a focused control
 * above it (`globals.css`), and both need its height. The stylesheet's 12rem is a fallback, not a
 * fact: the sheet's height is its wording at the member's text size in their fonts, and CI's
 * runner read the iOS wording at **244px** at 125% text on 360px, over that fallback (*measured*,
 * PR #240). So this measures it, the same way `src/shell/dock.ts` measures the docked navigation,
 * and writes it inline on `<html>`, where it beats the stylesheet.
 *
 * SELF-CONTAINED ON PURPOSE, like `watchDock`: no imports and no closure over module state, so
 * `test/install-sheet.test.ts` hands this exact function to Chrome. Returns the teardown, which
 * removes the value — the sheet is gone, and so is the room.
 */
export function watchSheet(sheet: HTMLElement): () => void {
  const root = document.documentElement;
  if (typeof ResizeObserver === "undefined") return () => {};
  const apply = () => root.style.setProperty("--install-sheet", `${sheet.getBoundingClientRect().height}px`);
  apply();
  const observer = new ResizeObserver(apply);
  observer.observe(sheet);
  return () => {
    observer.disconnect();
    root.style.removeProperty("--install-sheet");
  };
}
