"use client";

import { useCallback, useEffect, useState } from "react";
import { DISMISSED_KEY, type InstallAdvice, installAdvice } from "./prompt";

/**
 * The "add Tender to your home screen" banner on /board (story #28 AC 3).
 *
 * Two exports on purpose. `InstallBannerView` is a plain function of its props with no browser in
 * it, so a test can render each of the three cases directly with the display-mode stubbed —
 * which is what AC 3 asks for and what `renderToStaticMarkup` can actually do in this repo's
 * node test environment. `InstallBanner` is the shell that reads the real browser and hands the
 * answer to the view. Everything that decides anything lives in `./prompt`; everything that
 * reads a global lives in the effect below, and nothing does both.
 *
 * The banner is on the board rather than in the invite flow. The story's title says the invite
 * flow, and the board is where a crew actually is when installing starts to be worth anything:
 * at /join they have not yet seen what the app is for, and the one screen they will return to
 * every week is this one. It is dismissible for the same reason — somebody who has decided not
 * to install should be able to say so once and never be asked again on that device.
 */

/** A `beforeinstallprompt` event. Chromium-only, so it is not in TypeScript's DOM library. */
type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

const wrapperStyle: React.CSSProperties = {
  padding: "0.75rem",
  border: "1px solid currentColor",
  display: "flex",
  gap: "0.75rem",
  alignItems: "flex-start",
  justifyContent: "space-between",
};

export function InstallBannerView({
  advice,
  onInstall,
  onDismiss,
}: {
  advice: InstallAdvice | null;
  onInstall?: () => void;
  onDismiss?: () => void;
}) {
  if (advice === null) return null;

  return (
    <aside role="status" data-banner="install" data-install-advice={advice.kind} style={wrapperStyle}>
      <div>
        {advice.kind === "ios-share-sheet" ? (
          <p style={{ margin: 0 }}>
            Add Tender to your home screen so a skipper&rsquo;s post can reach your phone: tap{" "}
            <strong>Share</strong> at the bottom of Safari, then <strong>Add to Home Screen</strong>.
          </p>
        ) : (
          <p style={{ margin: 0 }}>
            Add Tender to your home screen so a skipper&rsquo;s post can reach your phone.
          </p>
        )}
        {advice.kind === "browser-prompt" && (
          <button type="button" data-install-action="prompt" onClick={onInstall} style={{ marginTop: "0.5rem" }}>
            Add to home screen
          </button>
        )}
      </div>
      <button type="button" data-install-action="dismiss" onClick={onDismiss} aria-label="Dismiss">
        Not now
      </button>
    </aside>
  );
}

export function InstallBanner() {
  const [advice, setAdvice] = useState<InstallAdvice | null>(null);
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);

  // Read the browser once on mount, and again whenever Chromium tells us it would offer an
  // install. Nothing renders on the server: `advice` starts null, so the first paint carries no
  // banner and the client fills it in — which also means the markup a crawler or a signed-out
  // fetch sees is unchanged by this component.
  useEffect(() => {
    const decide = (promptAvailable: boolean) =>
      setAdvice(
        installAdvice({
          userAgent: navigator.userAgent,
          // iOS Safari predates the display-mode media query for home-screen apps and reports
          // `navigator.standalone` instead; reading only the media query would show the banner
          // inside the installed app on the one platform this story is for.
          standalone:
            window.matchMedia("(display-mode: standalone)").matches ||
            (navigator as Navigator & { standalone?: boolean }).standalone === true,
          dismissed: readDismissed(),
          promptAvailable,
          maxTouchPoints: navigator.maxTouchPoints,
        }),
      );

    decide(false);

    const onBeforeInstallPrompt = (event: Event) => {
      // Holding the event is what lets the button below install on a tap. Without
      // preventDefault Chromium shows its own mini-infobar and discards it.
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
      decide(true);
    };
    const onInstalled = () => {
      setDeferred(null);
      setAdvice(null);
    };

    window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  const install = useCallback(async () => {
    if (!deferred) return;
    await deferred.prompt();
    // The event is single-use whichever way they answer, so drop it either way. If they declined,
    // the banner going quiet is the right outcome — they were just asked.
    setDeferred(null);
    setAdvice(null);
  }, [deferred]);

  const dismiss = useCallback(() => {
    writeDismissed();
    setAdvice(null);
  }, []);

  return <InstallBannerView advice={advice} onInstall={install} onDismiss={dismiss} />;
}

/**
 * `localStorage` throws rather than returning null in a browser set to block site data, and in
 * Safari's private mode it has historically thrown on write. Neither is a reason to lose the
 * board, so both directions swallow: an unreadable store means "not dismissed" and an unwritable
 * one means the banner comes back next time, which is the harmless half of each failure.
 */
function readDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, "1");
  } catch {
    // ignored — see readDismissed
  }
}
