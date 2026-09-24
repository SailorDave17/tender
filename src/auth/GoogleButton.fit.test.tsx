// @vitest-environment jsdom
import { webcrypto } from "node:crypto";
import { useEffect, useRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";
import { GoogleButton } from "./GoogleButton";

/**
 * #227, the component's half. `test/surfaces.test.ts` hands `fitGoogleButton` to Chrome on its
 * own, so it proves the sizing and cannot see whether the component calls it. This does. GIS's
 * script is replaced by a stand-in that reports ready once, as `next/script`'s `onReady` does on
 * mount, and the assertions are on what GIS was asked to draw and on the observer left behind.
 *
 * jsdom has no layout, so the wrapper reads 0px wide and a fitted draw asks for GIS's minimum,
 * 200. That is the reading that tells a fitted draw from the fixed 300 it replaced.
 */
vi.mock("next/script", () => ({
  default: function Script({ onReady }: { onReady?: () => void }) {
    const fired = useRef(false);
    useEffect(() => {
      if (fired.current) return;
      fired.current = true;
      onReady?.();
    });
    return null;
  },
}));

type Observer = { observed: Element[]; disconnected: boolean };
let observers: Observer[];
let gis: string[];
let asked: { parent: Element; width?: number }[];

beforeEach(() => {
  observers = [];
  gis = [];
  asked = [];
  // makeNonce needs SubtleCrypto, which jsdom's `crypto` does not carry.
  vi.stubGlobal("crypto", webcrypto);
  vi.stubGlobal(
    "ResizeObserver",
    class {
      private record: Observer = { observed: [], disconnected: false };
      constructor() {
        observers.push(this.record);
      }
      observe(el: Element) {
        this.record.observed.push(el);
      }
      unobserve() {}
      disconnect() {
        this.record.disconnected = true;
      }
    },
  );
  window.google = {
    accounts: {
      id: {
        initialize: () => void gis.push("initialize"),
        renderButton: (parent, options) => {
          gis.push("renderButton");
          asked.push({ parent, width: options.width });
        },
      },
    },
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete window.google;
});

describe("GoogleButton draws through fitGoogleButton (#227)", () => {
  it("initialises GIS, then draws at the wrapper's width, watches the wrapper, and stops on unmount", async () => {
    const { container, unmount } = render(
      <GoogleButton clientId="000000000000-test.apps.googleusercontent.com" text="signup_with" flow="signup" onCredential={() => {}} />,
    );
    await waitFor(() => expect(gis).toContain("renderButton"));
    const wrapper = container.querySelector('[data-google="signup"]');
    expect(wrapper).not.toBeNull();
    expect(gis).toEqual(["initialize", "renderButton"]);
    expect(asked).toEqual([{ parent: wrapper!.firstElementChild, width: 200 }]);
    expect(observers).toHaveLength(1);
    expect(observers[0].observed).toEqual([wrapper]);
    expect(observers[0].disconnected).toBe(false);
    unmount();
    expect(observers[0].disconnected, "unmounting disconnects the observer").toBe(true);
  });
});
