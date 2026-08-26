import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import manifest from "@/app/manifest";

/**
 * Story #28 AC 4 — the manifest and the icons as a running build actually serves them.
 *
 * WHY THIS ONE IS OPT-IN, AND WHY THAT IS NOT A SKIP
 *
 * CI runs `npm test` BEFORE `npm run build` (`.github/workflows/ci.yml`), so at the moment this
 * file executes on a runner there is no `.next` to serve and no server to fetch from. A test
 * that started its own `next build` would double the slowest step of every pull request in the
 * repo to check a file that has not changed. So the served check runs when it is pointed at a
 * server and not otherwise:
 *
 *     npm run build && npm start &
 *     TENDER_BASE_URL=http://127.0.0.1:3000 npx vitest run test/manifest-served.test.ts
 *
 * The failure mode this guards against is the one that costs the most here: a test that quietly
 * does nothing looks exactly like a test that found nothing wrong (cairn:
 * `an-absent-result-reads-as-a-clean-one`). Two things keep it honest.
 *
 *   1. The always-on half is elsewhere and is substantial. `test/manifest.test.ts` proves the
 *      manifest's fields and the icons' real pixel dimensions on every run, so what is deferred
 *      here is narrow: whether Next serves what the function returns, at the route it claims.
 *   2. When `TENDER_BASE_URL` IS set, nothing is skipped and nothing is tolerated — a server
 *      that does not answer fails the run rather than passing it. The variable chooses whether
 *      the question is asked, never what the answer may be.
 *
 * The run that ticked AC 4 is recorded on the pull request with its output, because a probe
 * whose result lives only in a session transcript is not an artefact.
 *
 * Registered behind a plain `if` rather than `describe.runIf`, deliberately. `runIf` leaves the
 * cases present and SKIPPED, which would put four permanently-pending tests into every run — and
 * this repo's mutation driver refuses a run with `numPendingTests > 0` as a did-not-run
 * (the complete-story overlay, from #21). Making that tripwire fire on a healthy suite forever
 * would cost more than the visibility of a skip line is worth, and the always-on case at the
 * bottom of this file is what reports that the block exists.
 */

const baseUrl = process.env.TENDER_BASE_URL;

if (baseUrl) describe("the built app serves the manifest and its icons (#28 AC 4)", () => {
  it("serves /manifest.webmanifest with every field the install needs", async () => {
    const res = await fetch(new URL("/manifest.webmanifest", baseUrl));
    expect(res.status, "the manifest route must exist in the built app").toBe(200);
    // Next serves this as `application/manifest+json`; a browser will not treat anything else
    // as a manifest, so the content type is part of the criterion rather than a detail.
    expect(res.headers.get("content-type") ?? "").toContain("manifest+json");

    const served = await res.json();
    // Compared against the source of truth rather than against a copy of its values: this asks
    // "does the build serve what the function returns", which is the only question left.
    expect(served).toEqual(JSON.parse(JSON.stringify(manifest())));
  });

  it("every icon the manifest names resolves 200 as an image", async () => {
    const served = await (await fetch(new URL("/manifest.webmanifest", baseUrl))).json();
    expect(served.icons.length).toBeGreaterThan(0);

    for (const icon of served.icons) {
      const res = await fetch(new URL(icon.src, baseUrl));
      expect(res.status, `${icon.src} must resolve`).toBe(200);
      expect(res.headers.get("content-type") ?? "", `${icon.src} content type`).toContain("image/png");
      const bytes = (await res.arrayBuffer()).byteLength;
      expect(bytes, `${icon.src} looks empty`).toBeGreaterThan(1000);
    }
  });

  it("serves the Apple touch icon and the service worker from the root", async () => {
    // Both are plain files under public/, and both are addressed by a fixed path that something
    // outside this repo resolves — iOS for the first, the registration call for the second — so
    // a rename that a unit test would not notice is a silent break of each.
    const apple = await fetch(new URL("/apple-touch-icon.png", baseUrl));
    expect(apple.status).toBe(200);
    expect(apple.headers.get("content-type") ?? "").toContain("image/png");

    const sw = await fetch(new URL("/sw.js", baseUrl));
    expect(sw.status).toBe(200);
    // A service worker served as anything but JavaScript is refused by the browser at
    // registration with a message about MIME type, which reads as a code fault and is not one.
    expect(sw.headers.get("content-type") ?? "").toMatch(/javascript/);
  });

  it("negative control — a path that should not exist answers 404", async () => {
    // Without this, a dev server or a proxy rewriting every unknown path to the app shell would
    // make every assertion above pass on a build serving nothing of the sort.
    const res = await fetch(new URL("/icon-193.png", baseUrl));
    expect(res.status, "a missing icon must 404, or the 200s above mean nothing").toBe(404);
  });
});

/**
 * Runs always, and is the reason deleting the block above cannot pass unnoticed. It reads this
 * file's own source, because there is nothing else left to read once the cases are unregistered:
 * with `TENDER_BASE_URL` unset the block contributes no tests, so its absence and its silence
 * are the same observation from outside (cairn: `an-absent-result-reads-as-a-clean-one`).
 *
 * It asserts the four fetches by the paths they request rather than by counting cases, so a
 * check quietly narrowed to two of them is caught as well as one deleted wholesale.
 */
it("the served check is present, and still asks for all four artefacts (#28 AC 4)", () => {
  const self = readFileSync(fileURLToPath(import.meta.url), "utf8");
  expect(self, "the served block must be gated on this variable and no other").toContain("process.env.TENDER_BASE_URL");
  for (const path of ["/manifest.webmanifest", "/apple-touch-icon.png", "/sw.js", "/icon-193.png"]) {
    expect(self, `the served check no longer requests ${path}`).toContain(`new URL("${path}", baseUrl)`);
  }
  expect(self, "the served check must assert against the manifest function, not a copy of it").toContain("manifest()");
});
