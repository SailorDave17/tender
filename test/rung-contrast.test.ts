import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { RUNG_COLOUR } from "@/board/post-view";
import { RungBadge } from "@/post/CandidateList";
import { contrastRatio } from "@/brand/contrast";
import { BAR, readTokenLayer } from "./tokens";

/**
 * Story #155 AC 3 — the rung badge keeps `Rung {n} · {name}` as text beside the colour, and the
 * badge's text-on-fill contrast clears 4.5:1 for all three rungs in BOTH schemes, computed.
 *
 * The fill is the ladder's data (`RUNG_COLOUR[n].hex` in light, `.dark` in dark — post-view.ts),
 * the ink is the token layer's `--accent-ink`, and the stylesheet joins them (`[data-badge="rung"]`).
 * So the pairing is computed from exactly those three sources, the way `tokens.test.ts` computes
 * the palette's — and printed on pass, because a verdict cannot show a value drifting toward the
 * line. The fill against the page is held to the non-text bar too: a badge the same tone as the
 * page is what AC 5 calls "theme-fixed".
 */
const layer = readTokenLayer();
const RUNGS = [1, 2, 3] as const;

describe("the rung badge: text beside the colour, and the ink on the fill clears 4.5:1 in both schemes (#155 AC 3)", () => {
  it.each(RUNGS)("rung %i keeps its number and name as text", (rung) => {
    const html = renderToStaticMarkup(createElement(RungBadge, { rung, colour: RUNG_COLOUR[rung] }));
    expect(html).toContain(`Rung ${rung} · ${RUNG_COLOUR[rung].name}`);
    expect(html).toMatch(/data-badge="rung"/);
    // the fill reaches the markup as data, for the stylesheet to paint from
    expect(html).toContain(`--rung:${RUNG_COLOUR[rung].hex}`);
    expect(html).toContain(`--rung-dark:${RUNG_COLOUR[rung].dark}`);
  });

  it.each(RUNGS)("rung %i: --accent-ink on the light fill, and on the dark fill", (rung) => {
    const light = contrastRatio(layer.light["--accent-ink"], RUNG_COLOUR[rung].hex);
    const dark = contrastRatio(layer.dark["--accent-ink"], RUNG_COLOUR[rung].dark);
    console.log(`rung ${rung} ${RUNG_COLOUR[rung].name.padEnd(5)} light ink on ${RUNG_COLOUR[rung].hex} ${light.toFixed(2)}:1   dark ink on ${RUNG_COLOUR[rung].dark} ${dark.toFixed(2)}:1  (bar ${BAR.text})`);
    expect(light).toBeGreaterThanOrEqual(BAR.text);
    expect(dark).toBeGreaterThanOrEqual(BAR.text);
  });

  it.each(RUNGS)("rung %i: the fill is told apart from the page and from a card, in both schemes", (rung) => {
    for (const [scheme, fill] of [
      ["light", RUNG_COLOUR[rung].hex],
      ["dark", RUNG_COLOUR[rung].dark],
    ] as const) {
      for (const bg of ["--paper", "--surface"]) {
        const r = contrastRatio(fill, layer[scheme][bg]);
        console.log(`rung ${rung} ${scheme.padEnd(5)} fill on ${bg.padEnd(9)} ${r.toFixed(2)}:1  (bar ${BAR["non-text"]})`);
        expect(r, `${scheme}: rung ${rung} fill ${fill} on ${bg}`).toBeGreaterThanOrEqual(BAR["non-text"]);
      }
    }
  });

  it("the dark fills are not the light ones — a badge fixed light-mode is what AC 5 refuses", () => {
    for (const rung of RUNGS) expect(RUNG_COLOUR[rung].dark.toLowerCase()).not.toBe(RUNG_COLOUR[rung].hex.toLowerCase());
  });
});
