import type { Browser } from "playwright-core";

/**
 * Story #247 — how long a Chrome-backed test file's `afterAll` may take to close its browser.
 *
 * `browser.close()` is not quick inside a full run. Playwright sends `Browser.close` and gives
 * Chrome 30 s (`DEFAULT_PLAYWRIGHT_TIMEOUT`) to exit. It then force-kills the process tree with
 * a synchronous `taskkill /T /F` and waits for the exit. Its own debug log says so:
 * `<gracefully close start>`, then `<kill>` 30 s later.
 *
 * Measured 2026-09-24 on this machine, from a start/end log around every close and from
 * Playwright's own `DEBUG=pw:browser` timestamps:
 *
 *   - alone, the same file under vitest: 248 ms, with the process exit taking ~220 ms of it;
 *   - in a full `npm test`, 35 closes over seven runs: 2.3–82.5 s, median ~30 s. Two were past
 *     the 60 s `hookTimeout`, which made each of these files fail as a suite with no failed test;
 *   - with a second full suite running beside it, 25 closes: 3.5–78.1 s, six of them past 60 s;
 *   - 16 of the 30 closes read from the debug log were force-killed at Playwright's 30 s.
 *
 * The time is the process exit, not the temporary-profile cleanup after it (38–57 ms, one of 5.9 s).
 * Why the exit starves is reasoned, not measured: the rest of the suite (pglite boots included)
 * is running beside it, and the same close alone takes a quarter of a second.
 * (#280 measured the reverse on 2026-10-12: every exit quick, no kill at all, and the 180 s spent
 * on a profile cleanup that could never finish. See `closeChrome` below.)
 *
 * So the hook needs room for Playwright's 30 s plus the kill and the exit. 180 s is 2.2 times the
 * slowest close measured. The tail climbed from 66 s to 83 s as the sample grew, so the margin is
 * wide on purpose, and it costs nothing unless a close genuinely hangs. The alternative was
 * to race the close against a shorter timer of our own. That returns while Playwright's kill is
 * still in flight, and whatever it has not finished is left running when the worker exits. That
 * includes the child `taskkill` already reported it could not terminate.
 */
export const CHROME_CLOSE_TIMEOUT_MS = 180_000;

/** The slowest close measured for #247 (an ordinary full run); the timeout has to stay clear of it. */
export const WORST_MEASURED_CLOSE_MS = 82_524;

/**
 * Story #280 — close a test file's Chrome without waiting forever on the deletion of its profile.
 *
 * `browser.close()` resolves only once Playwright has deleted the browser's temporary profile
 * (`fs.promises.rm(dir, { recursive: true, force: true, maxRetries: 10 })`), after Chrome's
 * process has exited. On the owner's machine that deletion sometimes never finishes. Measured
 * 2026-10-12 over seven full local runs, checkout and a `develop` worktree alike: every run passed
 * every test and ended `success: false`, because one or two Chrome files' `afterAll` ran out the
 * 180 s above. Each timed-out hook was exactly one profile whose deletion started and never
 * finished (10 of 10). The other 39 deletions took 16–82 ms. Every Chrome exited on its own, and
 * no close reached Playwright's kill.
 *
 * The profiles it could not delete had their `Default\` folder locked while Chrome was still
 * running. It refused read, write and delete to every non-browser process, `node` and PowerShell
 * alike, with `STATUS_ACCESS_DENIED`, under an ACL granting the owner full control, with no handle
 * open on it, and across a reboot. Node's `rm` retries such a refusal at every level of the tree,
 * so it never settles. The machine runs ESET Internet Security, whose "Enhanced data protection"
 * is documented as preventing unauthorized applications from reading and writing a browser's user
 * profile folders. That it is the cause is reasoned, not measured. Fifty Chromes launched the same
 * way outside the suite were never locked.
 *
 * So this waits for whichever comes first: `close()` settling, or Chrome's own process having
 * exited. In the second case it gives the deletion `PROFILE_CLEANUP_GRACE_MS` more, then warns and
 * returns. A slow EXIT is still waited for in full, under #247's timeout: `disconnected` would not
 * do here, because it fires about 30 ms after `close()` is called, before the process has exited
 * (5 of 5). The pid comes from CDP's `SystemInfo.getProcessInfo`, whose `browser` entry is
 * Playwright's own launched pid (3 of 3).
 */
export async function closeChrome(browser: Closable | undefined, deps: CloseDeps = DEFAULT_DEPS): Promise<void> {
  if (!browser || !browser.isConnected()) return;
  const pid = await deps.pidOf(browser).catch(() => undefined);
  const closing = browser.close();
  if (pid === undefined) return closing;

  let settled = false;
  const closed = closing.then(
    () => { settled = true; return "closed" as const; },
    (error: unknown) => { settled = true; throw error; },
  );
  const exited = (async () => {
    while (!settled && deps.alive(pid)) await sleep(deps.pollMs);
    return "exited" as const;
  })();
  if ((await Promise.race([closed, exited])) === "closed") return;

  const late = await Promise.race([closed, sleep(deps.graceMs).then(() => "pending" as const)]);
  if (late === "closed") return;
  // A later rejection is already handled (the races above subscribed to `closed`), so it would pass
  // in silence: report it instead. Measured: without this, nothing fails and nothing is printed.
  closed.catch((error: unknown) => deps.warn(`#280: Chrome pid ${pid}'s close rejected after it was let go: ${String(error)}`));
  deps.warn(
    `#280: Chrome (pid ${pid}) exited, but Playwright was still deleting its temporary profile ` +
      `${deps.graceMs} ms later, so the close was let go. On this machine that is a profile folder ` +
      `locked against node (README, "A Chrome profile the suite cannot delete").`,
  );
}

/** How long a profile's deletion may run after Chrome has exited: 120x the slowest of 39 measured, 1.7x #247's one outlier. */
export const PROFILE_CLEANUP_GRACE_MS = 10_000;

/** The slowest profile deletion ever measured to finish here (#247's outlier); the grace has to stay clear of it. */
export const WORST_MEASURED_CLEANUP_MS = 5_900;

export type Closable = Pick<Browser, "close" | "isConnected" | "newBrowserCDPSession">;

export type CloseDeps = {
  pidOf(browser: Closable): Promise<number | undefined>;
  alive(pid: number): boolean;
  graceMs: number;
  pollMs: number;
  warn(message: string): void;
};

/** The browser process's pid, as Chrome reports it over CDP. */
export async function browserPid(browser: Closable): Promise<number | undefined> {
  const cdp = await browser.newBrowserCDPSession();
  try {
    const { processInfo } = await cdp.send("SystemInfo.getProcessInfo");
    return processInfo.find((p) => p.type === "browser")?.id;
  } finally {
    await cdp.detach().catch(() => {});
  }
}

/** Whether a process exists. `EPERM` means it does and this process may not signal it. */
export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export const DEFAULT_DEPS: CloseDeps = {
  pidOf: browserPid,
  alive: processAlive,
  graceMs: PROFILE_CLEANUP_GRACE_MS,
  pollMs: 100,
  // not console.warn: vitest 5 drops console output from an afterAll (measured 2026-10-12, before and
  // after an await alike), and this warning is only ever written from one
  warn: (message) => process.stderr.write(`${message}\n`),
};

const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
