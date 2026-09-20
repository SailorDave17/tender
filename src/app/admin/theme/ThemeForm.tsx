"use client";

import { useState } from "react";
import { GOOD_CONTRAST, MIN_CONTRAST, contrastRatio, isHexColour, meetsMinimum } from "@/brand/contrast";
import { TenderMark } from "@/brand/TenderMark";

/**
 * The two hex inputs, a live preview of the mark in that pair, the computed ratio, and a Save
 * that is disabled below 3.0 (story #41 AC 4).
 *
 * The ratio here is `src/brand/contrast.ts`'s, the TypeScript spelling of the rule; the SQL
 * spelling in `set_club_theme()` decides at save. Both are proven equal on the same pairs
 * (`test/club-theme.test.ts`), so what the admin sees passing is what the database will accept.
 *
 * The inputs are text, not `<input type="color">`: the criterion says the admin ENTERS two hex
 * values, a picker cannot be given the burgee's sampled value exactly, and a picker's popover is
 * a poor fit for a phone on the dock. `pattern` and `maxLength` keep a stray character out; a
 * value that is not yet a colour shows no ratio and disables Save rather than showing NaN.
 *
 * Every state the screen can be in is a data attribute, so a probe reads the decision the
 * component made rather than re-deriving it from the text.
 */
export function ThemeForm({
  disc: initialDisc,
  mark: initialMark,
  action,
}: {
  disc: string;
  mark: string;
  action: (formData: FormData) => Promise<void>;
}) {
  const [disc, setDisc] = useState(initialDisc);
  const [mark, setMark] = useState(initialMark);

  const valid = isHexColour(disc) && isHexColour(mark);
  const ratio = valid ? contrastRatio(disc, mark) : null;
  const passes = ratio !== null && meetsMinimum(ratio);
  const verdict = ratio === null ? "invalid" : !passes ? "fail" : ratio < GOOD_CONTRAST ? "advise" : "pass";

  return (
    <form action={action} style={{ display: "grid", gap: "0.75rem" }} data-theme-form>
      <label htmlFor="disc">Disc — the colour behind the mark</label>
      <input
        id="disc"
        name="disc"
        value={disc}
        onChange={(e) => setDisc(e.target.value)}
        pattern="#[0-9A-Fa-f]{6}"
        maxLength={7}
        required
        autoComplete="off"
        spellCheck={false}
        data-theme-disc
        style={{ fontFamily: "monospace", fontSize: "1rem", padding: "0.5rem" }}
      />
      <label htmlFor="mark">Mark — the colour drawn on it</label>
      <input
        id="mark"
        name="mark"
        value={mark}
        onChange={(e) => setMark(e.target.value)}
        pattern="#[0-9A-Fa-f]{6}"
        maxLength={7}
        required
        autoComplete="off"
        spellCheck={false}
        data-theme-mark
        style={{ fontFamily: "monospace", fontSize: "1rem", padding: "0.5rem" }}
      />

      <div
        data-theme-preview
        style={{
          display: "flex",
          alignItems: "center",
          gap: "1rem",
          padding: "1rem",
          background: valid ? disc : undefined,
          color: valid ? mark : undefined,
          borderRadius: "0.5rem",
        }}
      >
        {valid ? (
          <>
            <TenderMark size={96} disc={disc} mark={mark} />
            <span style={{ fontWeight: 600, fontSize: "1.25rem" }}>Tender</span>
          </>
        ) : (
          <span>Enter two colours as #RRGGBB to see the mark.</span>
        )}
      </div>

      <p data-theme-ratio={ratio === null ? "" : ratio.toFixed(2)} data-theme-verdict={verdict}>
        Contrast: <strong>{ratio === null ? "—" : ratio.toFixed(2)}</strong>
        {verdict === "fail" && <> — below the {MIN_CONTRAST.toFixed(1)} minimum, so it cannot be saved.</>}
        {verdict === "advise" && (
          <> — readable; above {GOOD_CONTRAST.toFixed(1)} would be more comfortable, and this can be saved.</>
        )}
        {verdict === "pass" && <> — comfortable.</>}
        {verdict === "invalid" && <> — enter both colours first.</>}
      </p>

      <button type="submit" disabled={!passes} data-theme-save>
        Save
      </button>
    </form>
  );
}
