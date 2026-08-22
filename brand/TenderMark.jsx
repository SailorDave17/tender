import React from "react";

/* ------------------------------------------------------------------ */
/*  TenderMark — the club badge, themed per club.                      */
/*                                                                     */
/*  A club theme is exactly two colors: the disc and the knockout.     */
/*  Everything else is fixed geometry, so onboarding a new club is a   */
/*  config row, not a design job.                                      */
/*                                                                     */
/*  NOTE: this must be inlined as a component, not loaded via          */
/*  <img src="mark.svg">. An SVG referenced by <img> is a separate     */
/*  document and cannot see the page's colors or CSS variables.        */
/* ------------------------------------------------------------------ */

export const TENDER_DEFAULT = { disc: "#1E5443", mark: "#EDF0EA" };

/* Sampled from the club burgee: blue field, yellow device. */
export const HOOVER_SAILING_CLUB = { disc: "#395FAC", mark: "#FCCF0B" };

/* --- contrast --------------------------------------------------- */

const channel = (c) => {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
};

const luminance = (hex) => {
  const h = hex.replace("#", "");
  const full =
    h.length === 3
      ? h.split("").map((c) => c + c).join("")
      : h;
  const n = parseInt(full, 16);
  return (
    0.2126 * channel((n >> 16) & 255) +
    0.7152 * channel((n >> 8) & 255) +
    0.0722 * channel(n & 255)
  );
};

/**
 * Contrast ratio between two hex colors, 1 (identical) to 21 (black/white).
 *
 * The badge is a graphical object, not text, so the applicable bar is WCAG
 * 1.4.11 non-text contrast at 3:1 — not the 4.5:1 used for body copy. An
 * earlier draft of this file used 4.5 and would have rejected Hoover Sailing
 * Club's own burgee colors, which sit at 4.13. Below 3:1 the interior detail
 * genuinely stops resolving and the badge reads as a solid blob at icon sizes.
 */
export function contrastRatio(a, b) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

export const MIN_CONTRAST = 3.0;   /* hard reject — unusable below this */
export const GOOD_CONTRAST = 4.5;  /* comfortable; below this, just advise */

export const isValidTheme = (disc, mark) =>
  contrastRatio(disc, mark) >= MIN_CONTRAST;

/* --- the mark ----------------------------------------------------- */

function Rig({ fill, sailOpacity, waterOpacity, waterWidth }) {
  return (
    <>
      <g transform="translate(64,64) scale(0.857)">
        <rect x="-40" y="-53" width="80" height="11" rx="3" fill={fill} />
        <rect x="-5" y="-53" width="10" height="86" rx="3" fill={fill} />
        <path d="M 12 -39 L 12 23 L 44 23 Z" fill={fill} opacity={sailOpacity} />
        <rect x="9" y="23" width="42" height="8" rx="3" fill={fill} />
      </g>
      <line
        x1="24"
        y1="103"
        x2="104"
        y2="103"
        stroke={fill}
        strokeWidth={waterWidth}
        strokeLinecap="round"
        opacity={waterOpacity}
      />
    </>
  );
}

export default function TenderMark({
  size = 128,
  disc = TENDER_DEFAULT.disc,
  mark = TENDER_DEFAULT.mark,
  variant = "primary",
  title = "Tender",
  ...rest
}) {
  if (
    typeof process !== "undefined" &&
    process.env?.NODE_ENV !== "production" &&
    !isValidTheme(disc, mark)
  ) {
    console.warn(
      `TenderMark: ${disc} on ${mark} has a contrast ratio of ` +
        `${contrastRatio(disc, mark).toFixed(2)}, below the ${MIN_CONTRAST} ` +
        `minimum. The badge will read as a solid blob at icon sizes.`
    );
  }

  const svg = (children) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 128 128"
      width={size}
      height={size}
      role="img"
      aria-label={title}
      {...rest}
    >
      <title>{title}</title>
      {children}
    </svg>
  );

  if (variant === "reversed") {
    return svg(
      <>
        <circle cx="64" cy="64" r="60" fill={mark} />
        <Rig fill={disc} sailOpacity={0.6} waterOpacity={0.45} waterWidth={3.6} />
      </>
    );
  }

  if (variant === "outline") {
    return svg(
      <>
        <circle cx="64" cy="64" r="58" fill="none" stroke={disc} strokeWidth="4" />
        <Rig fill={disc} sailOpacity={0.55} waterOpacity={0.5} waterWidth={3.6} />
      </>
    );
  }

  /* flat — no opacity anywhere. For embroidery, screen print, vinyl, laser.
     Physical gaps do the separating instead. */
  if (variant === "flat") {
    return svg(
      <>
        <circle cx="64" cy="64" r="60" fill={disc} />
        <Rig fill={mark} sailOpacity={1} waterOpacity={1} waterWidth={4.5} />
      </>
    );
  }

  return svg(
    <>
      <circle cx="64" cy="64" r="60" fill={disc} />
      <Rig fill={mark} sailOpacity={0.65} waterOpacity={0.45} waterWidth={3.6} />
    </>
  );
}
