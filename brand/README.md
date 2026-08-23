# Tender — mark set

All four files share one geometry on a 128×128 artboard, disc centered at 64,64.
Edit one, edit them all — don't let them drift.

| File | Use |
|---|---|
| `tender-mark-primary.svg` | Default. Light backgrounds, app icon, favicon. |
| `tender-mark-reversed.svg` | Dark or busy backgrounds, dark garments. |
| `tender-mark-outline.svg` | Letterhead, etched glass, engraving, single-color line work. |
| `tender-mark-flat.svg` | Embroidery, screen print, laser, vinyl cut. |

## Color

**Hull green `#1E5443`** — primary.
**Paper `#EDF0EA`** — the knockout.

Green was chosen over navy because every yacht club is already navy, and over
red and amber because those are taken: the match ladder uses amber for "any
hull" and red for "below your minimum." A red brand mark would teach users two
contradictory meanings for the same color.

Secondary, if variety is ever needed: reservoir teal `#35606B`. Honest to
Hoover, which is green-grey rather than blue.

## Why `flat` exists

The other three variants draw the sail at 55–65% opacity so it separates from
the mast and boom. **Opacity does not exist in embroidery thread, screen print,
or vinyl.** A shop will either render it solid or drop it, and you won't be
consulted. `flat` is the version with every element at full strength and
physical gaps doing the separating instead — hand this one to any vendor
working in a single ink.

## Geometry notes

- The top crossbar is the **masthead**, not the boom. The boom is the short bar
  at the foot of the sail. An earlier draft had the boom at the top of the
  mainsail, which is backwards on every boat in the HSC fleet — sailors notice.
- The gap between mast and sail luff is load-bearing, not decorative. It's what
  keeps the two readable when opacity is stripped.
- Below roughly 40px the interior detail stops resolving. That's expected and
  fine — the solid disc keeps the silhouette recognizable, which is the whole
  reason the badge beat the bare monogram.

## Club theming

The badge is only ever **two colors** — the disc and the knockout. A club theme
is therefore two hex values on the `clubs` row, not a design engagement:

```
clubs   ...  brand_disc  brand_mark
```

Use `TenderMark.jsx` for anything in-app. It takes `disc`, `mark`, `variant`,
and `size`.

**Inline the component — never `<img src="mark.svg">`.** An SVG loaded through
`<img>` is a separate document and cannot see the page's colors or CSS
variables, so themed marks silently fall back to the default green.

### Contrast is validated, not trusted

`contrastRatio(disc, mark)` must be **≥ 3.0**. That's the WCAG 1.4.11 non-text
bar, which is the applicable one — the badge is a graphical object, not body
copy. Below 3:1 the interior detail stops resolving and the badge collapses
into a solid blob at icon sizes; a club picking gold on white produces a ratio
near 1.5 and an unusable mark.

Above 4.5 is comfortable. Between 3.0 and 4.5, advise but allow — HSC's own
burgee colors land at 4.13, and a threshold that rejects the pilot club's
actual colors is the wrong threshold.

`TenderMark` warns in development; the admin console should reject anything
below 3.0 at save time rather than let a club ship something illegible.

### Burgees with three colors

Most burgees have three. The badge takes two, so the club picks a dominant pair
— usually the field color plus the device color, dropping the trim. Don't try to
fit a third in.

### Static exports

`tender-mark-*.svg` are the default green. For a club that needs files rather
than a running app — a print shop, a clubhouse sign — generate their pair by
substituting the two hex values, and hand over the `flat` variant.

## Hoover Sailing Club

Sampled from the club burgee — a blue field with a yellow H device and a yellow
fly. Two colors, nothing to drop.

| | Hex |
|---|---|
| `brand_disc` | `#395FAC` |
| `brand_mark` | `#FCCF0B` |

Contrast ratio **4.13**. Passes the 3:1 non-text bar comfortably; sits just
under the 4.5 comfort level, which is fine for a mark and is exactly why the
hard threshold is 3.0 and not 4.5.

Blue disc with yellow rig matches the burgee's own figure-ground — yellow
device on blue field — so the app badge and the club burgee read as related
without the app copying the club's mark. Keep them distinguishable: the burgee
is the club's, the badge is the app's.

Import `HOOVER_SAILING_CLUB` from `TenderMark.jsx`.



- PNG exports at 512, 192, 180 (apple-touch-icon), 32, 16
- `favicon.ico`
- Wordmark lockup — mark plus "Tender" set in type, horizontal and stacked
- PWA `manifest.json` icon entries
