import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Story #28 AC 2 — the service worker stays online-only.
 *
 * This is a guard on source text, and the hazard with those in this workspace is that they fire
 * on the very documentation that explains them (cairn:
 * `a-guard-that-reads-source-must-survive-its-own-docs`). `public/sw.js` carries a long comment
 * about why there is no network-request listener, and that comment contains the word this guard
 * is about several times over.
 *
 * So the guard matches the SHAPE OF THE CALL and never the word. `hasRequestListener` looks for
 * a registration whose event name is the network one, or the corresponding handler property —
 * both of which are code, neither of which appears in a sentence. The comment in `sw.js` is
 * written to avoid reproducing that shape, which is a real constraint on how it may be phrased
 * and is stated there.
 *
 * It also does NOT strip comments before matching. Stripping is where this class of guard goes
 * wrong most quietly (cairn: `a-guard-preprocesses-its-evidence-before-it-looks`): the stripper
 * is written by the same hand, tested by nothing, and a naive one that eats the wrong span
 * leaves every assertion passing on a file it never really read. Matching precisely enough to
 * need no stripping removes that whole step.
 */

const SW_PATH = fileURLToPath(new URL("../public/sw.js", import.meta.url));
const source = readFileSync(SW_PATH, "utf8");

/**
 * True when the source registers for network requests. Both spellings, either quote style, and
 * tolerant of whitespace — a guard a reformat can defeat is not a guard.
 */
export function hasRequestListener(js: string): boolean {
  const listener = /addEventListener\s*\(\s*['"`]fetch['"`]/;
  // A dot is deliberately NOT excluded before the name: `self.onfetch =` is the commonest
  // spelling of the thing being forbidden, and an earlier version of this pattern ruled it out
  // by treating `.` as an identifier character. The positive control below is what caught that.
  // `(?!=)` keeps a comparison (`onfetch == null`) from reading as an assignment.
  const handler = /(^|[^A-Za-z0-9_$])onfetch\s*=(?!=)/;
  return listener.test(js) || handler.test(js);
}

describe("online only: no cached-board promise (#28 AC 2)", () => {
  it("the service worker registers no listener for network requests", () => {
    expect(hasRequestListener(source), "public/sw.js must not intercept network requests").toBe(false);
  });

  /**
   * The positive control. Without it, a `hasRequestListener` that had been broken into always
   * returning false — a typo in the pattern, a stray `?` — would leave the assertion above
   * green forever, and the failure mode of this guard is silence.
   *
   * Every spelling here is one the real file could plausibly acquire, and each is checked
   * separately so a partial break shows up as one red rather than none.
   */
  it("positive control — the guard recognises a listener when there is one", () => {
    const violations = [
      `self.addEventListener("fetch", (e) => e.respondWith(caches.match(e.request)));`,
      `self.addEventListener('fetch', handler);`,
      "self.addEventListener(`fetch`, handler);",
      `self.addEventListener( "fetch" , handler );`,
      `self.onfetch = handler;`,
      `onfetch = handler;`,
      `globalThis.onfetch = handler;`,
    ];
    for (const v of violations) {
      expect(hasRequestListener(v), `should have been caught: ${v}`).toBe(true);
      // ...and it is caught when it sits inside a real file rather than alone on a line.
      expect(hasRequestListener(`${source}\n${v}\n`), `should have been caught appended: ${v}`).toBe(true);
    }
  });

  /**
   * The negative control, and the one that matters most: the guard must survive `sw.js`'s own
   * explanation of itself. If this ever goes red the answer is to sharpen the pattern, never to
   * reword the file into saying less about why the rule exists.
   */
  it("negative control — prose about network requests is not a listener", () => {
    const prose = [
      "// There is no listener for network requests in this file.",
      "/* A cached board would keep showing a need that has already been filled. */",
      "// fetch, offline, cache, respondWith, caches.match — all words, none of them code.",
      "const label = 'fetch';",
      "// self.addEventListener - install and activate only",
      "if (self.onfetch == null) {}",
      "const prefetching = true;",
    ];
    for (const line of prose) {
      expect(hasRequestListener(line), `false positive on prose: ${line}`).toBe(false);
    }
    // The real file's real comment, which is the case this control exists for.
    expect(source).toMatch(/no listener for network requests/i);
    expect(hasRequestListener(source)).toBe(false);
  });

  it("says in the file why, in the words the criterion uses", () => {
    // The reason has to travel with the file. A worker with no listener and no explanation is
    // one somebody adds caching to next year in good faith.
    expect(source.toUpperCase()).toContain("ONLINE ONLY: NO CACHED-BOARD PROMISE");
  });

  it("is a real worker, not an empty file", () => {
    // Registration succeeds on any served JavaScript, so an empty sw.js would satisfy AC 4's
    // `serviceWorker.ready` and every assertion above at once.
    expect(source).toMatch(/addEventListener\s*\(\s*["'`]install["'`]/);
    expect(source).toMatch(/addEventListener\s*\(\s*["'`]activate["'`]/);
    expect(source).toContain("skipWaiting");
    expect(source).toContain("clients.claim");
  });
});
