/**
 * Who gets asked to install Tender, and what they are asked to do (story #28 AC 3).
 *
 * The decision is a pure function of three facts the browser can report, so all of it is
 * testable in node — the component that uses it reads `navigator.userAgent`,
 * `matchMedia("(display-mode: standalone)")` and `localStorage` and passes them in. That split
 * is the only reason AC 3's "component test with stubbed display-mode" is possible here at all:
 * the repo's vitest environment is `node`, and a component that reached for `window` itself
 * could only be tested by adding a DOM.
 *
 * There are three answers because there are three genuinely different situations, and the two
 * platforms need opposite treatment:
 *
 *   - **iOS Safari** offers no install API whatsoever. `beforeinstallprompt` has never shipped
 *     in Safari and Apple has said it will not, so the ONLY route onto an iPhone home screen is
 *     the person tapping Share and then Add to Home Screen themselves. All this code can do is
 *     tell them where those two taps are — which makes the instructions the feature, not a
 *     fallback. It matters more here than anywhere else, because iOS is the platform where an
 *     un-installed app cannot receive push at all.
 *   - **Chromium** fires `beforeinstallprompt`, which can be held and replayed on a tap. So
 *     Android gets a button that installs, not a paragraph that explains.
 *   - **Already installed, or nothing to offer** — say nothing. A banner asking someone to
 *     install the app they are currently running inside is the kind of thing that teaches people
 *     to ignore banners.
 *
 * Next's own PWA guide advises against `beforeinstallprompt` on the grounds that it is not
 * cross-platform. That is true and it is not a reason to skip it: the alternative is not "one
 * mechanism for everybody", it is "instructions for everybody", and Android users would then be
 * told to hunt through a menu for a thing their browser was willing to do in one tap. The
 * platform split is in the situation, so it is in the code.
 */

/** Nothing to say — already installed, already dismissed, or no route to offer. */
export type NoAdvice = null;

export type InstallAdvice =
  /** iOS: the two taps, spelled out, because nothing else can do it for them. */
  | { kind: "ios-share-sheet" }
  /** Chromium: a held `beforeinstallprompt` we can replay on a tap. */
  | { kind: "browser-prompt" };

export type InstallFacts = {
  /** `navigator.userAgent`. */
  userAgent: string;
  /** `matchMedia("(display-mode: standalone)").matches`, or iOS's `navigator.standalone`. */
  standalone: boolean;
  /** Whether this person has dismissed the banner on this device before. */
  dismissed: boolean;
  /** Whether a `beforeinstallprompt` event has been captured and is still replayable. */
  promptAvailable: boolean;
  /** `navigator.maxTouchPoints`. Only consulted to tell an iPad from a Mac — see `isIos`. */
  maxTouchPoints: number;
};

/**
 * iPhone, iPad and iPod touch. iPadOS 13+ reports a desktop Safari user agent by default, which
 * is why the touch-point test is here: a desktop Mac reports 0, an iPad claiming to be one
 * reports 5. Without it every iPad would be told nothing at all, which on a boat is the likelier
 * device of the two.
 *
 * `maxTouchPoints` is a parameter rather than a read of the global `navigator`, and that is not
 * tidiness. Node defines a `navigator` global with no `maxTouchPoints` on it, so a version of
 * this that reached for the global returned false in the test environment whatever the user
 * agent said — the Macintosh case passed for the wrong reason, and a mutation to the comparison
 * reddened nothing. Passing it in is what makes the branch reachable by a test at all.
 */
export function isIos(userAgent: string, maxTouchPoints: number): boolean {
  if (/iPad|iPhone|iPod/.test(userAgent)) return true;
  if (!/Macintosh/.test(userAgent)) return false;
  return maxTouchPoints > 1;
}

/**
 * The banner's whole decision. Order matters: standalone wins over everything, because an
 * installed app must never ask to be installed, and a dismissal must never override that into
 * showing something.
 */
export function installAdvice(facts: InstallFacts): InstallAdvice | NoAdvice {
  if (facts.standalone) return null;
  if (facts.dismissed) return null;
  if (facts.promptAvailable) return { kind: "browser-prompt" };
  if (isIos(facts.userAgent, facts.maxTouchPoints)) return { kind: "ios-share-sheet" };
  // A desktop browser, or a mobile one that has not offered us a prompt: nothing useful to say.
  return null;
}

/** Where a dismissal is remembered. Per-device by design — installing is a per-device act. */
export const DISMISSED_KEY = "tender.install-banner.dismissed";
