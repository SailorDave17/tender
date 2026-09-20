import type { SVGProps } from "react";

/**
 * TenderMark — the club badge, themed per club (story #41). Ported from `brand/TenderMark.jsx`,
 * which sat outside `tsconfig`, so this is now the one copy and it is typed.
 *
 * A club theme is exactly two colours: the disc and the knockout. Everything else is fixed
 * geometry, so onboarding a new club is a config row, not a design job.
 *
 * INLINE, NEVER `<img src="mark.svg">`. An SVG referenced by `<img>` is a separate document and
 * cannot see the page's colours or CSS variables, so a themed mark loaded that way silently
 * renders the file's own colours — or black, for `currentColor` (cairn:
 * `svg-currentcolor-and-movable-holes`). This component renders the SVG into the document.
 *
 * `disc` and `mark` are required rather than defaulted. The .jsx defaulted to hull green, which
 * is retired (see `theme.ts`), and the pair now comes from the club row: the layout passes the
 * row's values, and `/admin/theme`'s preview passes the pair being tried. A default here would
 * be a third copy of the theme that nothing holds to the other two.
 *
 * The dev-time `console.warn` on a sub-3:1 pair is not ported: the database refuses such a pair
 * at save (0028), so a rendered mark below the line is a seed problem, not a component one.
 */

export type MarkVariant = "primary" | "reversed" | "outline" | "flat";

type Props = {
  size?: number;
  /** The disc's fill, `#RRGGBB`. */
  disc: string;
  /** The rig's fill — the knockout, `#RRGGBB`. */
  mark: string;
  variant?: MarkVariant;
  title?: string;
} & Omit<SVGProps<SVGSVGElement>, "width" | "height">;

function Rig({
  fill,
  sailOpacity,
  waterOpacity,
  waterWidth,
}: {
  fill: string;
  sailOpacity: number;
  waterOpacity: number;
  waterWidth: number;
}) {
  return (
    <>
      <g transform="translate(64,64) scale(0.857)">
        {/* masthead — the top crossbar is the masthead, not the boom (brand/README.md) */}
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

export function TenderMark({ size = 128, disc, mark, variant = "primary", title = "Tender", ...rest }: Props) {
  const svg = (children: React.ReactNode) => (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 128 128"
      width={size}
      height={size}
      role="img"
      aria-label={title}
      data-tender-mark={variant}
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
      </>,
    );
  }

  if (variant === "outline") {
    return svg(
      <>
        <circle cx="64" cy="64" r="58" fill="none" stroke={disc} strokeWidth="4" />
        <Rig fill={disc} sailOpacity={0.55} waterOpacity={0.5} waterWidth={3.6} />
      </>,
    );
  }

  // flat — no opacity anywhere. For embroidery, screen print, vinyl, laser: physical gaps do the
  // separating instead, because opacity does not exist in thread or ink.
  if (variant === "flat") {
    return svg(
      <>
        <circle cx="64" cy="64" r="60" fill={disc} />
        <Rig fill={mark} sailOpacity={1} waterOpacity={1} waterWidth={4.5} />
      </>,
    );
  }

  return svg(
    <>
      <circle cx="64" cy="64" r="60" fill={disc} />
      <Rig fill={mark} sailOpacity={0.65} waterOpacity={0.45} waterWidth={3.6} />
    </>,
  );
}
