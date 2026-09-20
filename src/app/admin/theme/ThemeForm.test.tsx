// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { ThemeForm } from "./ThemeForm";
import { HOOVER_SAILING_CLUB } from "@/brand/theme";

/**
 * Story #41 AC 4 — the live preview, the computed ratio, and Save disabled below 3.0.
 *
 * What is asserted is the DECISION the component made, read off the data attributes it writes,
 * beside the rendered text a person sees. The ratio values are the same ones
 * `src/brand/contrast.test.ts` proves; here the claim is that the screen shows them and acts on
 * them. The Server Action is a recorded fake — it is never called by these tests, since the
 * submit is the browser's, but a `vi.fn()` makes an accidental call visible.
 *
 * jsdom does not compute `disabled` into a click refusal on its own for our purposes; the
 * assertion is on the attribute, which is what the browser reads.
 */

const JUST_ABOVE = ["#242424", "#6D6D6D"] as const;
const JUST_BELOW = ["#1B1B1B", "#666666"] as const;

function mount(disc = HOOVER_SAILING_CLUB.disc, mark = HOOVER_SAILING_CLUB.mark) {
  const action = vi.fn(async () => {});
  const r = render(<ThemeForm disc={disc} mark={mark} action={action} />);
  const discInput = r.container.querySelector<HTMLInputElement>("[data-theme-disc]")!;
  const markInput = r.container.querySelector<HTMLInputElement>("[data-theme-mark]")!;
  const save = r.container.querySelector<HTMLButtonElement>("[data-theme-save]")!;
  const ratio = () => r.container.querySelector<HTMLElement>("[data-theme-ratio]")!;
  const set = (input: HTMLInputElement, value: string) => fireEvent.change(input, { target: { value } });
  return { ...r, action, discInput, markInput, save, ratio, set };
}

afterEach(() => cleanup());

describe("ThemeForm (#41 AC 4)", () => {
  it("shows the seed pair's mark and its ratio, 4.13, with Save enabled", () => {
    const { container, save, ratio } = mount();
    expect(ratio().dataset.themeRatio).toBe("4.13");
    expect(ratio().dataset.themeVerdict).toBe("advise"); // readable, under the 4.5 comfort line
    expect(ratio().textContent).toContain("4.13");
    expect(save.disabled).toBe(false);

    // The preview is the mark, inline, in the pair being tried — never an <img>.
    const svg = container.querySelector("[data-theme-preview] svg[data-tender-mark]")!;
    expect(svg).not.toBeNull();
    expect(container.querySelector("[data-theme-preview] img")).toBeNull();
    expect(svg.querySelector("circle")!.getAttribute("fill")).toBe(HOOVER_SAILING_CLUB.disc);
    expect(svg.querySelector("rect")!.getAttribute("fill")).toBe(HOOVER_SAILING_CLUB.mark);
  });

  it("a colour against itself reads 1.00 and disables Save", () => {
    const { markInput, save, ratio, set } = mount();
    set(markInput, HOOVER_SAILING_CLUB.disc);
    expect(ratio().dataset.themeRatio).toBe("1.00");
    expect(ratio().dataset.themeVerdict).toBe("fail");
    expect(ratio().textContent).toMatch(/below the 3\.0 minimum/);
    expect(save.disabled).toBe(true);
  });

  it("black on white reads 21.00, comfortable, and re-enables Save", () => {
    const { discInput, markInput, save, ratio, set } = mount();
    set(markInput, HOOVER_SAILING_CLUB.disc);
    expect(save.disabled).toBe(true); // the control: it was disabled before the fix
    set(discInput, "#000000");
    set(markInput, "#FFFFFF");
    expect(ratio().dataset.themeRatio).toBe("21.00");
    expect(ratio().dataset.themeVerdict).toBe("pass");
    expect(save.disabled).toBe(false);
  });

  it("the preview follows the pair being typed", () => {
    const { container, discInput, markInput, set } = mount();
    set(discInput, "#000000");
    set(markInput, "#FFFFFF");
    const svg = container.querySelector("[data-theme-preview] svg")!;
    expect(svg.querySelector("circle")!.getAttribute("fill")).toBe("#000000");
    expect(svg.querySelector("rect")!.getAttribute("fill")).toBe("#FFFFFF");
  });

  it("the boundary is 3.0 inclusive: the nearest pair above saves, the nearest below does not", () => {
    const { discInput, markInput, save, ratio, set } = mount();
    set(discInput, JUST_ABOVE[0]);
    set(markInput, JUST_ABOVE[1]);
    expect(ratio().dataset.themeRatio).toBe("3.00");
    expect(save.disabled).toBe(false);

    set(discInput, JUST_BELOW[0]);
    set(markInput, JUST_BELOW[1]);
    expect(ratio().dataset.themeRatio).toBe("3.00"); // rounds the same — which is why the verdict is separate
    expect(ratio().dataset.themeVerdict).toBe("fail");
    expect(save.disabled).toBe(true);
  });

  it("a value that is not yet a colour shows no ratio, no mark, and disables Save", () => {
    const { container, markInput, save, ratio, set } = mount();
    set(markInput, "#FCCF0");
    expect(ratio().dataset.themeRatio).toBe("");
    expect(ratio().dataset.themeVerdict).toBe("invalid");
    expect(ratio().textContent).toContain("—");
    expect(container.querySelector("[data-theme-preview] svg")).toBeNull();
    expect(save.disabled).toBe(true);

    set(markInput, "#FCCF0B");
    expect(save.disabled).toBe(false);
  });

  it("the inputs carry the club row's own shape as their pattern, and post under the action's names", () => {
    const { discInput, markInput, action } = mount();
    for (const input of [discInput, markInput]) {
      expect(input.getAttribute("pattern")).toBe("#[0-9A-Fa-f]{6}");
      expect(input.maxLength).toBe(7);
      expect(input.required).toBe(true);
    }
    expect(discInput.name).toBe("disc");
    expect(markInput.name).toBe("mark");
    expect(action).not.toHaveBeenCalled();
  });
});
