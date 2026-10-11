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
