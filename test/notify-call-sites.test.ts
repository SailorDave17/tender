import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

/**
 * Two facts about src/ that only a read of src/ can hold (story #23 AC 3 and AC 7).
 *
 * AC 3: notifyRung() is called from the post-create and availability-toggle Server Actions and
 * nowhere else — a board GET sends no email and writes no suggestion row because no render
 * path can reach the function. The set of importers is asserted exactly, so a later story
 * adding a call site changes this list on purpose, and a page importing it fails here.
 *
 * AC 7: no client component references RESEND and no NEXT_PUBLIC_RESEND exists — the key
 * stays on the server. Both hunts are grep-shaped, so each is proven on a fixture first: a
 * guard that reads source can pass on an empty corpus (cairn:
 * a-mutation-certifies-the-corpus-not-the-guard-2026-08-20).
 */

const SRC = join(process.cwd(), "src");

async function sourceFiles(): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = [];
  async function walk(dir: string) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const f = join(dir, e.name);
      if (e.isDirectory()) await walk(f);
      else if (/\.(ts|tsx|mjs)$/.test(e.name) && !/\.test\./.test(e.name)) out.push({ path: relative(SRC, f).replace(/\\/g, "/"), text: await readFile(f, "utf8") });
    }
  }
  await walk(SRC);
  return out;
}

/** Files importing any module under src/notify/. */
function importersOfNotify(files: { path: string; text: string }[]): string[] {
  return files
    .filter((f) => !f.path.startsWith("notify/"))
    .filter((f) => /from\s+["']@\/notify\/[a-z]+["']/.test(f.text))
    .map((f) => f.path)
    .sort();
}

const isClientComponent = (text: string) => /^\s*["']use client["']\s*;?/m.test(text);

describe("notifyRung's call sites (AC 3)", () => {
  it("the importer scan finds an import by alias and ignores one inside a comment-free unrelated file", () => {
    const fixture = [
      { path: "app/x/actions.ts", text: `import { notifyRungLive } from "@/notify/live";\n` },
      { path: "app/y/page.tsx", text: `import { viewPost } from "@/board/post-view";\n` },
      { path: "notify/live.ts", text: `import { notifyRung } from "./rung";\n` },
    ];
    expect(importersOfNotify(fixture)).toEqual(["app/x/actions.ts"]);
  });

  it("exactly the post action and the board (availability) action import it — no page, no component", async () => {
    const files = await sourceFiles();
    expect(files.length).toBeGreaterThan(20);
    expect(importersOfNotify(files)).toEqual(["app/board/actions.ts", "app/post/actions.ts"]);
    // And both are Server Actions, not modules a page could call during a render.
    for (const p of ["app/board/actions.ts", "app/post/actions.ts"]) {
      expect(files.find((f) => f.path === p)!.text.startsWith('"use server";')).toBe(true);
    }
  });
});

describe("the Resend key stays on the server (AC 7)", () => {
  it("the scans fire on a fixture: a client component naming RESEND, and a NEXT_PUBLIC_RESEND anywhere", () => {
    const client = { path: "x/Client.tsx", text: `"use client";\nconst k = process.env.RESEND_API_KEY;\n` };
    const pub = { path: "y/z.ts", text: `const k = process.env.NEXT_PUBLIC_RESEND_API_KEY;\n` };
    expect([client].filter((f) => isClientComponent(f.text) && /RESEND/.test(f.text)).map((f) => f.path)).toEqual(["x/Client.tsx"]);
    expect([pub].filter((f) => /NEXT_PUBLIC_RESEND/.test(f.text)).map((f) => f.path)).toEqual(["y/z.ts"]);
  });

  it("no client component references RESEND, and NEXT_PUBLIC_RESEND exists nowhere under src/", async () => {
    const files = await sourceFiles();
    const clients = files.filter((f) => isClientComponent(f.text));
    expect(clients.length).toBeGreaterThan(0); // the corpus has client components to scan
    expect(clients.filter((f) => /RESEND/.test(f.text)).map((f) => f.path)).toEqual([]);
    expect(files.filter((f) => /NEXT_PUBLIC_RESEND/.test(f.text)).map((f) => f.path)).toEqual([]);
    // The one place the key is read, by name, so a second reader shows up here.
    expect(files.filter((f) => /RESEND_API_KEY/.test(f.text)).map((f) => f.path)).toEqual(["email/send.ts"]);
  });
});
