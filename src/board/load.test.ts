import { describe, expect, it } from "vitest";
import type { BoatRow, PostRow } from "./load";

/**
 * Story #69 AC 3 — the competence columns on the board's row types accept 4 and refuse 5.
 *
 * These are TYPE assertions with a runtime tail, because `load.ts` has no behaviour to test: it
 * issues PostgREST reads and casts the responses (`as PostRow[]`). That cast is the problem this
 * file exists for. Narrowing either column back to `1 | 2 | 3` is invisible to every other
 * instrument in the repo — *measured* on this story: the narrowing mutation left `tsc` GREEN and
 * all 379 tests passing, because a `1 | 2 | 3` is perfectly assignable to the wider
 * `1 | 2 | 3 | 4` these values flow into downstream (post-view.ts), and nothing upstream is typed
 * at all. So a post whose minimum is a helm would arrive typed as though it could not be one, and
 * the first exhaustive switch written over it would be wrong with no error anywhere.
 *
 * The `@ts-expect-error` lines are the other half, and they fail in BOTH directions: they error
 * if 5 becomes assignable (the type widened to `number` and stopped meaning anything), and tsc
 * reports an unused '@ts-expect-error' directive if the annotation is removed.
 */

const HELM_POST_MINIMUM: PostRow["minimum"] = 4;
const HELM_BOAT_MINIMUM: BoatRow["default_minimum"] = 4;

// @ts-expect-error 5 is not a competence — the scale is 1..4, widened not opened.
const OFF_SCALE_POST: PostRow["minimum"] = 5;
// @ts-expect-error 5 is not a competence — the scale is 1..4, widened not opened.
const OFF_SCALE_BOAT: BoatRow["default_minimum"] = 5;

describe("board row types carry the four-level competence scale (AC 3)", () => {
  it("post.minimum and boat.default_minimum accept a helm at 4", () => {
    expect(HELM_POST_MINIMUM).toBe(4);
    expect(HELM_BOAT_MINIMUM).toBe(4);
  });

  it("and the off-scale values above are refused at compile time, not here", () => {
    // Referenced so the constants are not dead; the assertion that matters is the directive.
    expect(OFF_SCALE_POST).toBe(5);
    expect(OFF_SCALE_BOAT).toBe(5);
  });
});
