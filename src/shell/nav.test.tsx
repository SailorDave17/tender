import { readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { AppShell } from "./AppShell";
import { TABS, currentTab } from "./nav";
import type { ShellPerson } from "./session";

/**
 * Story #242 AC 1 — the tab each screen marks, driven by the issue's table.
 *
 * The subject is the real `AppShell`, rendered with `usePathname()` answering each route in turn,
 * so a row passes only if the shell really renders the links through `NavLinks` and the mark lands
 * on the tab the table names. `currentTab` alone could be right while the shell ignored it.
 *
 * What this cannot see is whether the mark MOVES on a client-side navigation: every render here is
 * a fresh one, which is exactly what a server-rendered mark would also get right. That half is the
 * smoke's (#242 AC 2), in a real browser.
 */

let pathname: string | null = null;
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  usePathname: () => pathname,
}));

const ADMIN: ShellPerson = { id: "p-1", email: "a@example.test", displayName: "Ada", isAdmin: true };
const MEMBER: ShellPerson = { ...ADMIN, isAdmin: false };
const ID = "00000000-0000-4000-8000-000000000242";

/**
 * The issue's table, with a concrete path for every route on disk. The expected value is the
 * tab's LABEL as a member reads it, or null for "no tab marked". Spelled here rather than read from
 * `nav.ts`, which is the subject.
 */
const TABLE: ReadonlyArray<[route: string, path: string, tab: string | null]> = [
  ["/board", "/board", "Board"],
  ["/post/new", "/post/new", "Post"],
  ["/post/[id]", `/post/${ID}`, "Board"],
  ["/post/[id]/thread", `/post/${ID}/thread`, "Board"],
  ["/boats", "/boats", "Boats"],
  ["/profile", "/profile", "Profile"],
  ["/profile/[id]", `/profile/${ID}`, null],
  ["/admin", "/admin", "Admin"],
  ["/admin/dates", "/admin/dates", "Admin"],
  ["/admin/dates/[id]", `/admin/dates/${ID}`, "Admin"],
  ["/admin/dates/import", "/admin/dates/import", "Admin"],
  ["/admin/invite", "/admin/invite", "Admin"],
  ["/admin/people", "/admin/people", "Admin"],
  ["/admin/theme", "/admin/theme", "Admin"],
  ["/admin/threads", "/admin/threads", "Admin"],
  ["/admin/threads/[id]", `/admin/threads/${ID}`, "Admin"],
  ["/welcome", "/welcome", null],
  ["/support", "/support", null],
  ["/privacy", "/privacy", null],
  ["/", "/", null],
  // Signed-out screens. A session can still be present on them (a reset link opened while signed
  // in), and none of them is a tab.
  ["/join", "/join", null],
  ["/forgot", "/forgot", null],
  ["/reset-password", "/reset-password", null],
];

/** Every `[data-nav]` link in the rendered shell: its text, and whether it is marked. */
function navLinks(html: string): Array<{ label: string; current: boolean }> {
  const nav = html.match(/<nav aria-label="Tender" data-nav[^>]*>([\s\S]*?)<\/nav>/);
  if (!nav) throw new Error("no [data-nav] in the rendered shell");
  return [...nav[1].matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/g)].map((m) => ({
    label: m[2].trim(),
    current: /\baria-current="page"/.test(m[1]),
  }));
}

function render(path: string | null, person: ShellPerson | null = ADMIN): Array<{ label: string; current: boolean }> {
  pathname = path;
  return navLinks(renderToStaticMarkup(<AppShell mark={null} person={person}><main /></AppShell>));
}

/** Every route a page.tsx under src/app serves, in the table's spelling. */
function routesOnDisk(): string[] {
  const app = join(process.cwd(), "src", "app");
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name === "page.tsx") {
        const route = relative(app, dir).split(sep).join("/");
        found.push(`/${route}`.replace(/\/$/, "") || "/");
      }
    }
  };
  walk(app);
  return found.sort();
}

describe("the tab each screen marks (#242 AC 1)", () => {
  for (const [route, path, tab] of TABLE) {
    it(`${route} marks ${tab ?? "no tab"}`, () => {
      const links = render(path);
      // The admin sees every tab, so a row naming one can only fail by marking the wrong one.
      expect(links.map((l) => l.label)).toEqual(TABS.map((t) => t.label));
      const marked = links.filter((l) => l.current).map((l) => l.label);
      expect(marked).toEqual(tab ? [tab] : []);
    });
  }

  it("the table covers every page on disk, so a new route cannot go unmarked by omission", () => {
    expect(TABLE.map(([route]) => route).sort()).toEqual(routesOnDisk());
  });

  it("a member who is not an admin has no Admin tab, so /admin marks nothing", () => {
    const links = render("/admin", MEMBER);
    expect(links.map((l) => l.label)).toEqual(["Board", "Post", "Boats", "Profile"]);
    expect(links.filter((l) => l.current)).toEqual([]);
    // the control: the same member on the board has it marked
    expect(render("/board", MEMBER).filter((l) => l.current).map((l) => l.label)).toEqual(["Board"]);
  });

  it("signed out, the one link is Sign in and it is never marked, even on /join", () => {
    for (const path of ["/join", "/board", null]) {
      expect(render(path, null)).toEqual([{ label: "Sign in", current: false }]);
    }
  });

  it("outside a Next request usePathname() is null, and nothing is marked", () => {
    // What every other test that renders the layout sees: the shell must render, unmarked.
    expect(render(null).filter((l) => l.current)).toEqual([]);
  });

  it("Post carries no permanent marker any more — data-primary is gone from the shell", () => {
    pathname = "/board";
    const html = renderToStaticMarkup(<AppShell mark={null} person={ADMIN}><main /></AppShell>);
    expect(html).not.toContain("data-primary");
  });
});

describe("currentTab's boundaries", () => {
  it("matches a route and what is under it, never a sibling that shares its letters", () => {
    expect(currentTab("/board")).toBe("board");
    expect(currentTab("/boardroom")).toBeNull();
    expect(currentTab("/boats")).toBe("boats");
    expect(currentTab("/boatswain")).toBeNull();
    expect(currentTab("/admin/people")).toBe("admin");
    expect(currentTab("/administrator")).toBeNull();
    expect(currentTab("/profiles")).toBeNull();
    expect(currentTab("/post")).toBeNull();
  });

  it("an absent pathname marks nothing", () => {
    expect(currentTab(null)).toBeNull();
    expect(currentTab(undefined)).toBeNull();
    expect(currentTab("")).toBeNull();
  });
});
