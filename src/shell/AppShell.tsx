import Link from "next/link";
import type { ReactNode } from "react";
import { BuildStamp } from "@/build/BuildStamp";
import type { ShellPerson } from "./session";

/**
 * The app shell (story #154): the one frame every page renders inside. A skip link first in the
 * tab order, the club's mark and the product name, the signed-in person and their way out, the
 * navigation, then the page in a frame, then the build stamp. Until #154 the root layout was a
 * one-line brand bar and every page carried its own `padding: 2rem; fontFamily; maxWidth` —
 * twenty copies of one frame; the CSS behind `[data-frame] > main` is the one that replaces them.
 *
 * THE MARK ARRIVES AS AN ELEMENT, built by the layout from the club row. It is passed in rather
 * than rendered here so that `src/app/layout.tsx` is still the file that puts `theme.disc` into
 * `<TenderMark>` — which is what `test/manifest.test.ts` reads to prove the tab, the manifest
 * and the mark are painted from one read. Inline as a component, never `<img src>`: an image
 * SVG is a separate document that cannot see the page's colours (cairn:
 * `svg-currentcolor-and-movable-holes`).
 *
 * THE NAVIGATION DOCKS TO THE BOTTOM ON A PHONE. Under 40rem `[data-nav]` is fixed to the
 * bottom edge (`globals.css`), because the charter's line is "phone, often outdoors, sometimes
 * on the dock" and a thumb reaches the bottom of the screen, not the top — so "Post" is within
 * reach from the board without a stretch. On a wider screen the same list sits in the header.
 * Sign-out stays in the header on every width; it is not a destination.
 *
 * `#main` is the skip link's target and carries `tabindex="-1"` so focus actually lands there.
 * The page's own `<main>` sits inside it; the frame is the div's, the landmark is the page's.
 *
 * SUPPORT AND PRIVACY SIT UNDER THE PAGE ON EVERY PAGE (story #147 AC 3), signed in or out, in a
 * nav of their own above the build stamp. They are not destinations a member moves between, so
 * they stay out of `[data-nav]`, which is the bottom dock on a phone. The shell is also where the
 * criterion's two places meet: the board and /join both render inside it, so one line reaches
 * both, and a person who cannot sign in finds it on the sign-in page itself.
 */
export function AppShell({
  mark,
  person,
  children,
}: {
  /** `<TenderMark …>` in the club row's pair, from the layout. */
  mark: ReactNode;
  person: ShellPerson | null;
  children: ReactNode;
}) {
  const who = person ? (person.displayName ?? person.email ?? "someone") : null;
  return (
    <>
      <a href="#main" data-skip>
        Skip to content
      </a>
      <header data-brand-bar>
        <Link href="/" data-home prefetch={false}>
          {mark}
          <span data-product>Tender</span>
        </Link>
        {person ? (
          <div data-identity>
            <span data-who>Signed in as {who}</span>
            <form action="/auth/signout" method="post">
              <button type="submit" data-signout>
                Sign out
              </button>
            </form>
          </div>
        ) : null}
        <nav aria-label="Tender" data-nav data-signed-in={person ? "true" : undefined}>
          {person ? (
            <>
              <Link href="/board" prefetch={false}>
                Board
              </Link>
              <Link href="/post/new" prefetch={false} data-primary>
                Post
              </Link>
              <Link href="/boats" prefetch={false}>
                Boats
              </Link>
              <Link href="/profile" prefetch={false}>
                Profile
              </Link>
              {person.isAdmin ? (
                <Link href="/admin" prefetch={false}>
                  Admin
                </Link>
              ) : null}
            </>
          ) : (
            <Link href="/join" prefetch={false}>
              Sign in
            </Link>
          )}
        </nav>
      </header>
      <div id="main" tabIndex={-1} data-frame>
        {children}
      </div>
      <nav aria-label="About Tender" data-about>
        <Link href="/support" prefetch={false}>
          Support
        </Link>
        <Link href="/privacy" prefetch={false}>
          Privacy
        </Link>
      </nav>
      <BuildStamp />
    </>
  );
}
