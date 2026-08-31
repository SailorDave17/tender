import { describe, expect, it } from "vitest";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

/**
 * Two facts about src/ that only a read of src/ can hold (story #23 AC 3 and AC 7).
 *
 * AC 3: nothing on a RENDER path can send. The set of files that import a sending entry point is
 * asserted exactly, so a later story adding one changes this list on purpose and a page importing
 * one fails here.
 *
 * WHAT THE SUBJECT IS, AND WHY IT NARROWED (story #25). This used to hold "files importing
 * anything under src/notify/", which was the same set while notify/ had one job. The ladder tick
 * made it two: `src/engine/tick.ts` imports `openRung` — two lines of `Math.max` on a rung — and
 * `src/engine/tick-store.ts` imports the store's TYPE, and neither can cause an email. Left as it
 * was, this test would have refused a correct file for naming a pure helper, which is the failure
 * mode of a guard whose scan is wider than its claim (cairn:
 * a-guard-that-reads-source-must-survive-its-own-docs-2026-08-09). So the scan now matches the
 * claim: the SENDING symbols, by name.
 *
 * The list below is the whole surface — two Server Actions and one Route Handler — and the second
 * assertion is what keeps the original claim intact now that a route is on it: a sender is a
 * Server Action or a route under app/api/, never a page and never a component.
 *
 * AC 7: no client component references RESEND and no NEXT_PUBLIC_RESEND exists — the key stays on
 * the server. Every hunt here is grep-shaped, so each is proven on a fixture first: a guard that
 * reads source can pass on an empty corpus (cairn:
 * a-mutation-certifies-the-corpus-not-the-guard-2026-08-20).
 */

const SRC = join(process.cwd(), "src");

/**
 * The six ways a caller can cause a send. `notifyRung`/`notifyRungLive` run the ladder and
 * then send; `dispatchPending`/`dispatchPendingLive` send what the tick has already queued;
 * `notifyAnswer`/`notifyAnswerLive` tell a post's skipper that crew answered (story #24).
 */
const SENDERS = ["notifyRung", "notifyRungLive", "dispatchPending", "dispatchPendingLive", "notifyAnswer", "notifyAnswerLive"];

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

/** The names a file binds from src/notify/, whether or not the import is type-only. */
function notifyBindings(text: string): string[] {
  const names: string[] = [];
  for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*["']@\/notify\/[a-z-]+["']/g)) {
    for (const raw of m[1].split(",")) {
      const name = raw.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (name) names.push(name);
    }
  }
  return names;
}

/** Files outside src/notify/ that import something able to send. */
function sendersAmong(files: { path: string; text: string }[]): string[] {
  return files
    .filter((f) => !f.path.startsWith("notify/"))
    .filter((f) => notifyBindings(f.text).some((n) => SENDERS.includes(n)))
    .map((f) => f.path)
    .sort();
}

const isClientComponent = (text: string) => /^\s*["']use client["']\s*;?/m.test(text);

describe("what can send a rung email (AC 3)", () => {
  it("the scan finds a sender, ignores a pure helper from the same module, and ignores a type-only import", () => {
    // Proven on a fixture first, and every negative here is a real line from src/: the guard
    // narrowed for #25 precisely because these three shapes had to be told apart.
    const fixture = [
      { path: "app/x/actions.ts", text: `import { notifyRungLive } from "@/notify/live";\n` },
      { path: "app/api/y/route.ts", text: `import { dispatchPendingLive } from "@/notify/live";\n` },
      { path: "engine/tick.ts", text: `import { openRung, type RungPost } from "@/notify/rung";\n` },
      { path: "engine/tick-store.ts", text: `import type { RungStore } from "@/notify/rung";\n` },
      { path: "app/y/page.tsx", text: `import { viewPost } from "@/board/post-view";\n` },
      { path: "notify/live.ts", text: `import { notifyRung } from "./rung";\n` },
    ];
    expect(sendersAmong(fixture)).toEqual(["app/api/y/route.ts", "app/x/actions.ts"]);
    // and the binding parse itself, since everything above rests on it
    expect(notifyBindings(`import {\n  dispatchPending as send,\n  type RungPost,\n} from "@/notify/rung";`)).toEqual([
      "dispatchPending",
      "RungPost",
    ]);
  });

  it("exactly the two Server Actions and the tick route can send — no page, no component", async () => {
    const files = await sourceFiles();
    expect(files.length).toBeGreaterThan(20);
    expect(sendersAmong(files)).toEqual([
      "app/api/ladder/tick/route.ts",
      "app/board/actions.ts",
      "app/post/actions.ts",
    ]);
    // A sender is a Server Action or a Route Handler. Both are entered by a request the person
    // made on purpose; neither is reached by rendering a page, which is the claim AC 3 is about.
    for (const p of sendersAmong(files)) {
      const text = files.find((f) => f.path === p)!.text;
      expect(text.startsWith('"use server";') || /^app\/api\/.*\/route\.ts$/.test(p), `${p} is an action or a route`).toBe(
        true,
      );
      expect(isClientComponent(text), `${p} is not a client component`).toBe(false);
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
