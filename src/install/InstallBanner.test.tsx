import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { InstallBannerView } from "./InstallBanner";
import { installAdvice } from "./prompt";

/**
 * Story #28 AC 3, the rendered half — "component test with stubbed display-mode".
 *
 * The display mode is stubbed by being an argument. `InstallBannerView` takes the advice rather
 * than reading the browser, so each of the three situations is rendered here directly and
 * compared against the others. Rendering the `InstallBanner` shell instead would prove nothing:
 * its whole decision is in a `useEffect`, which does not run under `renderToStaticMarkup`, so
 * every case would render the identical empty first paint.
 *
 * The advice values are produced by `installAdvice` rather than written out, so the two halves
 * of AC 3 cannot drift apart into a view that renders a kind the decision never returns.
 */

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) Version/17.4 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 8) Chrome/124.0.0.0 Mobile Safari/537.36";

const iosSafari = installAdvice({ userAgent: IPHONE, standalone: false, dismissed: false, promptAvailable: false, maxTouchPoints: 5 });
const chromeAndroid = installAdvice({ userAgent: ANDROID, standalone: false, dismissed: false, promptAvailable: true, maxTouchPoints: 5 });
const installed = installAdvice({ userAgent: IPHONE, standalone: true, dismissed: false, promptAvailable: false, maxTouchPoints: 5 });

const render = (advice: typeof iosSafari) => renderToStaticMarkup(<InstallBannerView advice={advice} />);

describe("the install banner on /board", () => {
  it("spells out Share then Add to Home Screen on iOS Safari, where nothing can do it for them", () => {
    const html = render(iosSafari);
    expect(html).toContain('data-banner="install"');
    expect(html).toContain('data-install-advice="ios-share-sheet"');
    // The two taps, named. This is the whole content of the iOS case.
    expect(html).toContain("Share");
    expect(html).toContain("Add to Home Screen");
    // ...and no button claiming to install, because iOS Safari has no such API.
    expect(html).not.toContain('data-install-action="prompt"');
  });

  it("offers Chromium a button instead of a paragraph", () => {
    const html = render(chromeAndroid);
    expect(html).toContain('data-install-advice="browser-prompt"');
    expect(html).toContain('data-install-action="prompt"');
    // The Safari instructions must not follow an Android user around.
    expect(html).not.toContain("Add to Home Screen");
  });

  it("renders nothing at all in standalone mode", () => {
    // The negative control sits in the same test as its positive: an always-empty view would
    // pass the assertion below on its own, and cannot pass it beside the two arms here.
    expect(render(installed)).toBe("");
    expect(render(iosSafari)).not.toBe("");
    expect(render(chromeAndroid)).not.toBe("");
  });

  it("is dismissible in every case it appears in", () => {
    for (const advice of [iosSafari, chromeAndroid]) {
      expect(render(advice), `${advice?.kind} must be dismissible`).toContain('data-install-action="dismiss"');
    }
  });

  it("announces itself without stealing focus", () => {
    // `role="status"` is polite: a screen reader finishes the sentence it is on. `role="alert"`
    // interrupts, which is right for a refusal and wrong for an offer — and the board already
    // uses `alert` for its refusals, so the two must not look the same.
    const html = render(iosSafari);
    expect(html).toContain('role="status"');
    expect(html).not.toContain('role="alert"');
  });
});
