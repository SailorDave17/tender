import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser } from "playwright-core";
import { GLOBALS_CSS } from "./tokens";

/**
 * Story #153 AC 6 — `--dur` under `prefers-reduced-motion: reduce`, read as the BROWSER computes
 * it and never as the custom property.
 *
 * The token is re-pointed to `0s` in `globals.css`, and that is exactly the half every debugging
 * instinct checks and the half that can be right while the behaviour is unchanged: a blanket
 * `* { transition-duration: 0.01ms !important }` reset — the one almost every CSS starter ships —
 * beats the shorthand on cascade importance before the token's value is ever consulted, so the
 * property reads `0s` and `getComputedStyle(el).transitionDuration` reads `1e-05s` (cairn:
 * `a-token-loses-to-an-important-it-cannot-see`, measured in Chrome on madcowsailing #12). This
 * repo carries no such reset today; the assertion below is what refuses one being added.
 *
 * So the instrument is the machine's own Chrome through `playwright-core` (`channel: "chrome"`,
 * the owner's no-download rule from #45 — `scripts/smoke.mjs` runs the same way, and so does the
 * CI runner), given a page carrying the real stylesheet and one element the stylesheet itself
 * transitions (`a`). Both readings are taken and both are printed: the ordinary one proves the
 * instrument sees the token at all (a reading of `0s` on a page with no stylesheet would pass
 * the reduced case for nothing), and the reduced one is the criterion.
 *
 * Not skipped when Chrome is absent — it fails, naming the requirement. A test that quietly does
 * nothing looks exactly like a test that found nothing wrong (cairn:
 * `an-absent-result-reads-as-a-clean-one`), and this repo's mutation driver already refuses a run
 * with pending tests for the same reason.
 */

const css = readFileSync(GLOBALS_CSS, "utf8");
const page = `<!doctype html><html lang="en"><head><style>${css}</style></head><body><a href="/board" id="probe">the board</a></body></html>`;

let browser: Browser;

beforeAll(async () => {
  browser = await chromium.launch({ channel: "chrome", headless: true });
}, 60_000);

afterAll(async () => {
  await browser?.close();
});

async function transitionDurationOf(reducedMotion: "reduce" | "no-preference"): Promise<{ property: string; token: string }> {
  const context = await browser.newContext({ reducedMotion });
  try {
    const tab = await context.newPage();
    await tab.setContent(page);
    return await tab.evaluate(() => {
      const el = document.getElementById("probe")!;
      const style = getComputedStyle(el);
      return { property: style.transitionDuration, token: style.getPropertyValue("--dur").trim() };
    });
  } finally {
    await context.close();
  }
}

describe("--dur under prefers-reduced-motion, as Chrome computes it (#153 AC 6)", () => {
  it("transitions for 150ms by default — the instrument sees the token", async () => {
    const read = await transitionDurationOf("no-preference");
    console.log(`no-preference: transitionDuration=${read.property} --dur=${read.token}`);
    expect(read.token).toBe("150ms");
    expect(read.property).toBe("0.15s");
  });

  it("reads 0s — the PROPERTY, not the token — when motion is reduced", async () => {
    const read = await transitionDurationOf("reduce");
    console.log(`reduce:        transitionDuration=${read.property} --dur=${read.token}`);
    // Both are asserted, and the second is the criterion. `1e-05s` here with the token at `0s`
    // is the blanket-reset case, and it is a red test.
    expect(read.token).toBe("0s");
    expect(read.property).toBe("0s");
  });
});
