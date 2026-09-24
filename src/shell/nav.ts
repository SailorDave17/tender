/**
 * Which tab the signed-in navigation marks as the screen you are on (story #242).
 *
 * Until #242 nothing was marked, and Post's permanent outline (#154's call to action) read as
 * "you are here" on every screen. The table is the issue's, owner decision 2026-09-24:
 *
 *   /board                        Board
 *   /post/new                     Post
 *   /post/[id], /post/[id]/thread Board    a post is opened from the board
 *   /boats                        Boats
 *   /profile                      Profile
 *   /profile/[id]                 none     another member's profile is not yours
 *   /admin and everything under   Admin
 *   anything else                 none     /welcome, /support, /privacy, /
 *
 * Pure, so the table is testable row by row without a router. `src/shell/NavLinks.tsx` feeds it
 * `usePathname()`, which is what lets the mark follow a client-side navigation: the shell is
 * rendered by the root layout, which does not re-render when the page changes.
 */

export type Tab = "board" | "post" | "boats" | "profile" | "admin";

export type TabLink = { tab: Tab; href: string; label: string; adminOnly?: true };

/** The signed-in navigation, in order. Admin appears only for an admin. */
export const TABS: readonly TabLink[] = [
  { tab: "board", href: "/board", label: "Board" },
  { tab: "post", href: "/post/new", label: "Post" },
  { tab: "boats", href: "/boats", label: "Boats" },
  { tab: "profile", href: "/profile", label: "Profile" },
  { tab: "admin", href: "/admin", label: "Admin", adminOnly: true },
];

/** `root` itself or a route below it, never a sibling that merely starts with the same letters. */
function under(pathname: string, root: string): boolean {
  return pathname === root || pathname.startsWith(`${root}/`);
}

export function currentTab(pathname: string | null | undefined): Tab | null {
  if (!pathname) return null;
  if (under(pathname, "/board")) return "board";
  if (pathname === "/post/new") return "post";
  // Every other post route is a post, and a post is opened from the board.
  if (pathname.startsWith("/post/")) return "board";
  if (under(pathname, "/boats")) return "boats";
  // Only your own profile. /profile/[id] is someone else's, and no tab is theirs.
  if (pathname === "/profile") return "profile";
  if (under(pathname, "/admin")) return "admin";
  return null;
}
