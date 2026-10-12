import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { chromium, type Browser } from "playwright-core";
import {
  CHROME_CLOSE_TIMEOUT_MS,
  DEFAULT_DEPS,
  PROFILE_CLEANUP_GRACE_MS,
  WORST_MEASURED_CLEANUP_MS,
  browserPid,
  closeChrome,
  processAlive,
  type Closable,
  type CloseDeps,
} from "./chrome";

/**
 * Story #280 — `closeChrome` waits a slow EXIT out in full, and lets go of a profile deletion that
 * has not finished `graceMs` after Chrome's process is gone.
 *
 * The deletion that never finishes cannot be produced on demand: on the owner's machine a profile
 * folder gets locked against node now and then inside a full run, and never outside one (50 of 50
 * clean, 2026-10-12), and on Linux a held file does not block an unlink at all. So the timing is
 * proven here against a browser whose `close()` and process liveness the test controls. The real
 * Chrome below proves the half a fake cannot: that the pid `browserPid` reads is a process that is
 * alive while Chrome runs and gone once `close()` has resolved.
 */

type Control = { browser: Closable; closes: () => number; settle: () => void; fail: (error: Error) => void };

function controlled(): Control {
  let settle!: () => void;
  let fail!: (error: Error) => void;
  const closing = new Promise<void>((resolve, reject) => {
    settle = resolve;
    fail = reject;
  });
  let closes = 0;
  const browser = {
    isConnected: () => true,
    close: () => {
      closes++;
      return closing;
    },
    newBrowserCDPSession: () => Promise.reject(new Error("the fake has no CDP; pidOf is injected")),
  } as unknown as Closable;
  return { browser, closes: () => closes, settle, fail };
}

const PID = 4242;

function deps(alive: () => boolean, over: Partial<CloseDeps> = {}): CloseDeps & { warnings: string[] } {
  const warnings: string[] = [];
  return {
    pidOf: async () => PID,
    alive,
    graceMs: 200,
    pollMs: 10,
    warn: (message) => warnings.push(message),
    warnings,
    ...over,
  };
}

const after = (ms: number, fn: () => void) => setTimeout(fn, ms);
const since = (t0: number) => Date.now() - t0;

describe("closeChrome against a controlled browser (#280)", () => {
  it("returns as soon as close() settles, with nothing to warn about", async () => {
    const c = controlled();
    const d = deps(() => true);
    after(50, c.settle);
    const t0 = Date.now();
    await closeChrome(c.browser, d);
    expect(since(t0)).toBeLessThan(d.graceMs);
    expect(c.closes()).toBe(1);
    expect(d.warnings).toEqual([]);
  });

  it("lets the close go graceMs after Chrome's process has exited, and says why", async () => {
    const c = controlled(); // never settles: the profile deletion that never finishes
    let exited = false;
    after(50, () => (exited = true));
    const d = deps(() => !exited);
    const t0 = Date.now();
    await closeChrome(c.browser, d);
    const took = since(t0);
    expect(took).toBeGreaterThanOrEqual(50 + d.graceMs - 15);
    expect(took).toBeLessThan(50 + d.graceMs + 1_000);
    expect(d.warnings).toHaveLength(1);
    expect(d.warnings[0]).toMatch(/^#280: Chrome \(pid 4242\) exited, but Playwright was still deleting its temporary profile 200 ms later/);
  });

  it("waits a slow exit out in full: it never returns on its own while Chrome's process is alive", async () => {
    const c = controlled();
    const d = deps(() => true, { graceMs: 20 });
    after(500, c.settle); // Playwright's kill path, finishing long after the grace would have run out
    const t0 = Date.now();
    await closeChrome(c.browser, d);
    expect(since(t0)).toBeGreaterThanOrEqual(490);
    expect(d.warnings).toEqual([]);
  });

  it("falls back to Playwright's own close when the pid cannot be read", async () => {
    const c = controlled();
    let polled = 0;
    const alive = () => {
      polled++;
      return false;
    };
    const d = deps(alive, { pidOf: () => Promise.reject(new Error("no CDP")) });
    after(300, c.settle);
    const t0 = Date.now();
    await closeChrome(c.browser, d);
    expect(since(t0)).toBeGreaterThanOrEqual(290);
    expect(polled).toBe(0);
  });

  it("rejects with close()'s own error when the close fails while Chrome is running", async () => {
    const c = controlled();
    const d = deps(() => true);
    after(50, () => c.fail(new Error("close failed")));
    await expect(closeChrome(c.browser, d)).rejects.toThrow("close failed");
  });

  it("reports a rejection that arrives after the close was let go, which would otherwise pass in silence", async () => {
    const c = controlled();
    const d = deps(() => false, { graceMs: 30 });
    await closeChrome(c.browser, d);
    c.fail(new Error("too late"));
    await new Promise((done) => setTimeout(done, 20));
    expect(d.warnings).toHaveLength(2);
    expect(d.warnings[1]).toBe("#280: Chrome pid 4242's close rejected after it was let go: Error: too late");
  });

  it("does nothing for a browser that never launched or is already closed", async () => {
    await expect(closeChrome(undefined, deps(() => true))).resolves.toBeUndefined();
    const c = controlled();
    const gone = { ...c.browser, isConnected: () => false } as Closable;
    await closeChrome(gone, deps(() => true));
    expect(c.closes()).toBe(0);
  });

  it("the grace outlasts every profile deletion measured to finish, and leaves the hook its room", () => {
    expect(PROFILE_CLEANUP_GRACE_MS).toBeGreaterThan(WORST_MEASURED_CLEANUP_MS);
    // the close inside a hook is Playwright's 30 s, the kill, the exit, then this grace
    expect(PROFILE_CLEANUP_GRACE_MS).toBeLessThanOrEqual(CHROME_CLOSE_TIMEOUT_MS / 10);
  });

  it("the default warning goes straight to stderr, which vitest prints from an afterAll", () => {
    // vitest 5 drops console output from an afterAll, and the warning is only written from one
    const written: string[] = [];
    const write = vi.spyOn(process.stderr, "write").mockImplementation((chunk) => (written.push(String(chunk)), true));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    let warned = -1;
    try {
      DEFAULT_DEPS.warn("#280: probe");
      warned = warn.mock.calls.length;
    } finally {
      write.mockRestore();
      warn.mockRestore();
    }
    expect(written).toEqual(["#280: probe\n"]);
    expect(warned).toBe(0);
  });

  it("processAlive counts a process this one may not signal as alive", () => {
    // pid 4 is Windows' System process, pid 1 is init: both exist, and neither may be signalled by
    // an ordinary user, which is what ESET's memory protection makes of a secured Chrome too
    const pid = process.platform === "win32" ? 4 : 1;
    let code: string | undefined;
    try {
      process.kill(pid, 0);
    } catch (error) {
      code = (error as NodeJS.ErrnoException).code;
    }
    expect(code, `the precondition: signalling pid ${pid} is refused`).toBe("EPERM");
    expect(processAlive(pid)).toBe(true);
  });

  it("browserPid takes the browser process's id, wherever CDP lists it", async () => {
    let detached = 0;
    const session = {
      send: async () => ({
        processInfo: [
          { type: "GPU", id: 11, cpuTime: 0 },
          { type: "browser", id: 22, cpuTime: 0 },
          { type: "network.mojom.NetworkService", id: 33, cpuTime: 0 },
        ],
      }),
      detach: async () => void detached++,
    };
    const browser = { newBrowserCDPSession: async () => session } as unknown as Closable;
    expect(await browserPid(browser)).toBe(22);
    expect(detached).toBe(1);
  });
});

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
}, 60_000);

afterAll(async () => {
  await closeChrome(browser);
}, CHROME_CLOSE_TIMEOUT_MS);

describe("closeChrome on the machine's own Chrome (#280)", () => {
  // the close inside it may take #247's whole path, so it gets the hook's room (as an option, which
  // chrome-hooks.test.ts does not count as a hook)
  it("reads a pid that is alive while Chrome runs and gone once close() has resolved", { timeout: CHROME_CLOSE_TIMEOUT_MS }, async () => {
    const pid = await browserPid(browser);
    expect(pid).toBeGreaterThan(0);
    expect(pid).not.toBe(process.pid);
    expect(processAlive(pid!)).toBe(true);
    await closeChrome(browser);
    expect(browser.isConnected()).toBe(false);
    expect(processAlive(pid!)).toBe(false);
  });
});
