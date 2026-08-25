import { execFileSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The VAPID private key stays on the server, and `npm run vapid:keys` makes a fresh pair
 * (story #29 AC 7).
 *
 * The hazard is specific and quiet: the public key's name begins `NEXT_PUBLIC_`, so it IS inlined
 * into the browser bundle — that is what it is for. The private key's name is one word away from
 * it, and a `NEXT_PUBLIC_VAPID_PRIVATE_KEY` anywhere would ship the signing key to every phone
 * with nothing failing and nothing looking wrong. So the scan is for the wrong name existing at
 * all, not only for the right one being used carefully.
 *
 * Grep-shaped, so each hunt is proven on a fixture first — a guard that reads source can pass on
 * an empty corpus (cairn: a-mutation-certifies-the-corpus-not-the-guard-2026-08-20).
 */

const ROOT = process.cwd();
const SRC = join(ROOT, "src");

async function sourceFiles(): Promise<{ path: string; text: string }[]> {
  const out: { path: string; text: string }[] = [];
  async function walk(dir: string) {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const f = join(dir, e.name);
      if (e.isDirectory()) await walk(f);
      // Test files are excluded, as they are in `notify-call-sites.test.ts`, and for the same
      // reason: the claim is about code that SHIPS. `push/send.test.ts` names the variable in an
      // assertion about refusing to run without it, which is the guard's own subject matter and
      // not a leak — nothing under `.test.` reaches a bundle or a browser.
      else if (/\.(ts|tsx|mjs)$/.test(e.name) && !/\.test\./.test(e.name))
        out.push({ path: relative(SRC, f).replace(/\\/g, "/"), text: await readFile(f, "utf8") });
    }
  }
  await walk(SRC);
  return out;
}

const isClientComponent = (text: string) => /^\s*["']use client["']\s*;?/m.test(text);

describe("the VAPID private key never reaches a browser (AC 7)", () => {
  it("the scans fire on a fixture: a client component naming it, and a NEXT_PUBLIC_ spelling", () => {
    const client = { path: "x/Client.tsx", text: `"use client";\nconst k = process.env.VAPID_PRIVATE_KEY;\n` };
    const pub = { path: "y/z.ts", text: `const k = process.env.NEXT_PUBLIC_VAPID_PRIVATE_KEY;\n` };
    expect([client].filter((f) => isClientComponent(f.text) && /VAPID_PRIVATE_KEY/.test(f.text)).map((f) => f.path)).toEqual(["x/Client.tsx"]);
    expect([pub].filter((f) => /NEXT_PUBLIC_VAPID_PRIVATE/.test(f.text)).map((f) => f.path)).toEqual(["y/z.ts"]);
  });

  it("no client component under src/ names the private key", async () => {
    const files = await sourceFiles();
    const clients = files.filter((f) => isClientComponent(f.text));
    expect(clients.length).toBeGreaterThan(0); // the corpus has client components to scan
    expect(clients.filter((f) => /VAPID_PRIVATE_KEY/.test(f.text)).map((f) => f.path)).toEqual([]);
  });

  it("`NEXT_PUBLIC_VAPID_PRIVATE` exists nowhere — the one-word slip that would ship the key", async () => {
    const files = await sourceFiles();
    expect(files.filter((f) => /NEXT_PUBLIC_VAPID_PRIVATE/.test(f.text)).map((f) => f.path)).toEqual([]);
  });

  it("exactly one module under src/ reads it, so a second reader shows up here", async () => {
    const files = await sourceFiles();
    expect(files.filter((f) => /VAPID_PRIVATE_KEY/.test(f.text)).map((f) => f.path)).toEqual(["push/send.ts"]);
  });

  it("the PUBLIC key is read on the server and handed down, never read inside a client component", async () => {
    // NEXT_PUBLIC_ is inlined at BUILD time, so a client component reading it directly bakes in
    // whatever the building machine had rather than what the deployment holds (cairn:
    // nextjs-proxy-inlines-public-env-at-build). The toggle takes it as a prop.
    const files = await sourceFiles();
    const clientReaders = files.filter((f) => isClientComponent(f.text) && /process\.env\.NEXT_PUBLIC_VAPID/.test(f.text));
    expect(clientReaders.map((f) => f.path)).toEqual([]);
  });

  it("the files that mention the private key are the env sample, the README and server code", () => {
    // `--untracked` is load-bearing, not tidiness. A plain `git grep` reads only what is COMMITTED,
    // which is never the file a change is adding — this very assertion passed against a single
    // `.env.example` hit while four of the files it names sat uncommitted in the working tree
    // (cairn: a-checks-coverage-is-not-a-completion-condition, the git-corpus half). Ignored files
    // are still excluded, which is what keeps the real `.env.local` out of the scan.
    const hits = execFileSync("git", ["grep", "--untracked", "-l", "VAPID_PRIVATE_KEY", "--", ":!*.test.ts"], { cwd: ROOT, encoding: "utf8" })
      .trim()
      .split("\n")
      .map((l) => l.replace(/\\/g, "/"))
      .sort();
    expect(hits).toEqual([".env.example", "README.md", "scripts/vapid-keys.mjs", "src/push/send.ts"]);
  });
});

describe("npm run vapid:keys prints a fresh pair (AC 7)", () => {
  const run = () => execFileSync("node", ["scripts/vapid-keys.mjs"], { cwd: ROOT, encoding: "utf8" });

  it("prints both names with a value beside each", () => {
    const out = run();
    expect(out).toMatch(/NEXT_PUBLIC_VAPID_PUBLIC_KEY=[A-Za-z0-9_-]{80,}/);
    expect(out).toMatch(/VAPID_PRIVATE_KEY=[A-Za-z0-9_-]{40,}/);
  });

  it("is FRESH: two runs never produce the same pair", () => {
    // The word in the criterion is "fresh". A script that printed a constant would satisfy every
    // assertion above and be catastrophically wrong.
    const first = run();
    const second = run();
    const key = (s: string) => /VAPID_PRIVATE_KEY=(\S+)/.exec(s)![1];
    expect(key(first)).not.toBe(key(second));
  });

  it("warns that rotating invalidates every existing subscription", () => {
    // Browsers hold the public key inside the subscription they made, so a rotation silently
    // turns off notifications for everyone and nothing tells them.
    expect(run()).toMatch(/invalidates every existing push subscription/i);
  });
});
