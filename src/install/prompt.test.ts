import { describe, expect, it } from "vitest";
import { DISMISSED_KEY, installAdvice, isIos } from "./prompt";

/**
 * Story #28 AC 3, the decision half. The rendered half is in `InstallBanner.test.tsx`.
 *
 * The table is exhaustive over the three booleans rather than a list of the cases anyone thought
 * of, because the interesting failures here are all precedence: a dismissal that overrides
 * standalone would show a banner inside the installed app, and a `promptAvailable` that
 * overrides dismissal would bring it back on the next Chromium event. Neither is visible from a
 * test that only checks the three headline situations.
 */

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";
const DESKTOP = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

describe("who gets asked to install, and what they are asked to do (#28 AC 3)", () => {
  it("tells an iPhone in Safari where the two taps are — nothing else can", () => {
    expect(installAdvice({ userAgent: IPHONE, standalone: false, dismissed: false, promptAvailable: false, maxTouchPoints: 0 })).toEqual({
      kind: "ios-share-sheet",
    });
  });

  it("offers Chromium's own prompt once the browser has given us one", () => {
    expect(installAdvice({ userAgent: ANDROID, standalone: false, dismissed: false, promptAvailable: true, maxTouchPoints: 0 })).toEqual({
      kind: "browser-prompt",
    });
  });

  it("says nothing on Android until the browser has offered a prompt", () => {
    // Chromium fires `beforeinstallprompt` only when it considers the app installable. Guessing
    // from the user agent instead would print a button whose tap could do nothing at all.
    expect(installAdvice({ userAgent: ANDROID, standalone: false, dismissed: false, promptAvailable: false, maxTouchPoints: 0 })).toBeNull();
  });

  it("says nothing to a desktop browser", () => {
    expect(installAdvice({ userAgent: DESKTOP, standalone: false, dismissed: false, promptAvailable: false, maxTouchPoints: 0 })).toBeNull();
  });

  /**
   * The precedence sweep. Every combination, with the expected answer written out — so a change
   * to the order of the guards in `installAdvice` has to disagree with a row here rather than
   * merely with an intention.
   */
  it("never asks an installed app to install itself, whatever else is true", () => {
    for (const userAgent of [IPHONE, ANDROID, DESKTOP]) {
      for (const dismissed of [false, true]) {
        for (const promptAvailable of [false, true]) {
          expect(
            installAdvice({ userAgent, standalone: true, dismissed, promptAvailable, maxTouchPoints: 0 }),
            `standalone must win: ua=${userAgent.slice(0, 20)} dismissed=${dismissed} prompt=${promptAvailable}`,
          ).toBeNull();
        }
      }
    }
  });

  it("stays quiet once dismissed, including when Chromium offers a prompt afterwards", () => {
    expect(installAdvice({ userAgent: IPHONE, standalone: false, dismissed: true, promptAvailable: false, maxTouchPoints: 0 })).toBeNull();
    expect(installAdvice({ userAgent: ANDROID, standalone: false, dismissed: true, promptAvailable: true, maxTouchPoints: 0 })).toBeNull();
  });

  /**
   * The positive control for the sweep above: with `standalone` and `dismissed` both false, the
   * same fixtures DO produce advice. Without this, a mutation making `installAdvice` return null
   * unconditionally would pass every assertion in this file that asserts null.
   */
  it("positive control — the same inputs with nothing suppressing them do produce advice", () => {
    expect(installAdvice({ userAgent: IPHONE, standalone: false, dismissed: false, promptAvailable: false, maxTouchPoints: 0 })).not.toBeNull();
    expect(installAdvice({ userAgent: ANDROID, standalone: false, dismissed: false, promptAvailable: true, maxTouchPoints: 0 })).not.toBeNull();
  });
});

describe("iPadOS reports a desktop user agent, and an iPad is the likelier boat device", () => {
  it("recognises the three that say so outright", () => {
    expect(isIos(IPHONE, 5)).toBe(true);
    expect(isIos("Mozilla/5.0 (iPad; CPU OS 15_0 like Mac OS X)", 5)).toBe(true);
    expect(isIos("Mozilla/5.0 (iPod touch; CPU iPhone OS 15_0 like Mac OS X)", 5)).toBe(true);
  });

  /**
   * The pair that matters, and the reason `maxTouchPoints` is an argument. Both arms carry the
   * SAME desktop-Safari user agent and differ only in the touch points, so the assertion is
   * about the discriminator itself rather than about the string — an implementation that ignored
   * touch points entirely would have to fail one of these two whichever way it answered.
   */
  it("tells an iPadOS device claiming to be a Mac from an actual Mac", () => {
    const MAC_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 Safari/605.1.15";
    expect(isIos(MAC_UA, 5), "an iPad reports five touch points").toBe(true);
    expect(isIos(MAC_UA, 0), "a desktop Mac reports none").toBe(false);
    // A touch-screen Windows laptop is not an iPad however many touch points it has.
    expect(isIos(DESKTOP, 10)).toBe(false);
  });
});

it("the dismissal key is namespaced, so it cannot collide with anything else on the origin", () => {
  expect(DISMISSED_KEY.startsWith("tender.")).toBe(true);
});
