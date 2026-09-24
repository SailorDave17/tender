"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { TABS, currentTab } from "./nav";

/**
 * The signed-in navigation's links, with the current screen's tab marked `aria-current="page"`
 * (story #242). A client component because the mark has to move on a client-side navigation, and
 * the shell around it is rendered by the root layout, which does not re-render when the page
 * changes: a mark decided on the server would be right for the first screen and stale from the
 * next tap on. `usePathname()` re-renders this on every navigation.
 *
 * Outside a Next request (a unit test rendering the layout) `usePathname()` reads the context's
 * default, `null`, and no tab is marked.
 */
export function NavLinks({ isAdmin }: { isAdmin: boolean }) {
  const current = currentTab(usePathname());
  return (
    <>
      {TABS.filter((t) => !t.adminOnly || isAdmin).map((t) => (
        <Link key={t.tab} href={t.href} prefetch={false} aria-current={t.tab === current ? "page" : undefined}>
          {t.label}
        </Link>
      ))}
    </>
  );
}
