import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The service worker's push and click handlers (story #29 AC 5).
 *
 * `public/sw.js` is served as a static file and never imported, so the temptation is to assert on
 * its SOURCE. That would be a grep proving the words are present, and every claim AC 5 makes is
 * about BEHAVIOUR — what is shown when a payload arrives, and where a tap goes. So the file is
 * executed here in a fake worker scope: the handlers it registers are captured and then called
 * with the events a push service really delivers.
 *
 * This is the same file the browser runs, byte for byte. What it cannot see is anything the
 * browser does around it — permission, delivery, whether iOS shows it — and that is #30's job on
 * a real iPhone.
 */

const SW = readFileSync(fileURLToPath(new URL("../public/sw.js", import.meta.url)), "utf8");

type Handler = (event: unknown) => void;

/** Run sw.js and hand back the listeners it registered, plus what it did to the fake scope. */
function loadWorker() {
  const listeners = new Map<string, Handler>();
  const shown: { title: string; options: Record<string, unknown> }[] = [];
  const opened: string[] = [];
  const navigated: string[] = [];
  const focused: string[] = [];
  const waited: unknown[] = [];
  let windows: { url: string; focus?: () => unknown; navigate?: (u: string) => unknown }[] = [];

  const self = {
    addEventListener(name: string, handler: Handler) {
      listeners.set(name, handler);
    },
    skipWaiting() {},
    registration: {
      showNotification(title: string, options: Record<string, unknown>) {
        shown.push({ title, options });
        return Promise.resolve();
      },
    },
    clients: {
      claim: () => Promise.resolve(),
      matchAll: () => Promise.resolve(windows),
      openWindow(url: string) {
        opened.push(url);
        return Promise.resolve({ url });
      },
    },
  };

  // The file only ever touches `self`, so a single parameter is the whole environment it needs.
  new Function("self", SW)(self);

  return {
    listeners,
    shown,
    opened,
    navigated,
    focused,
    waited,
    setWindows(list: string[]) {
      windows = list.map((url) => ({
        url,
        focus: () => {
          focused.push(url);
          return Promise.resolve({ url });
        },
        navigate: (u: string) => {
          navigated.push(u);
          return Promise.resolve({ url: u, focus: () => focused.push(u) });
        },
      }));
    },
    async push(data: unknown) {
      const handler = listeners.get("push")!;
      const event = { data, waitUntil: (p: unknown) => waited.push(p) };
      handler(event);
      await Promise.all(waited);
    },
    async click(notification: Record<string, unknown>) {
      const handler = listeners.get("notificationclick")!;
      let closed = false;
      const event = {
        notification: { ...notification, close: () => (closed = true) },
        waitUntil: (p: unknown) => waited.push(p),
      };
      handler(event);
      await Promise.all(waited);
      return closed;
    },
  };
}

/** What the push service delivers: an object whose `.json()` parses the encrypted payload. */
const payloadOf = (value: unknown) => ({ json: () => value });

describe("push — what the phone shows (AC 5)", () => {
  it("registers a push handler and a click handler", () => {
    const w = loadWorker();
    expect([...w.listeners.keys()].sort()).toEqual(["activate", "install", "notificationclick", "push"]);
  });

  it("shows the boat, class, date and rung word from the payload", async () => {
    const w = loadWorker();
    await w.push(
      payloadOf({
        title: "Crew needed: Blue Moon (Thistle)",
        body: "Sun, Jun 13, 1:00 PM · Rung 2 · amber",
        url: "/post/abc",
        tag: "post-abc",
      }),
    );
    expect(w.shown).toHaveLength(1);
    expect(w.shown[0].title).toBe("Crew needed: Blue Moon (Thistle)");
    expect(w.shown[0].options.body).toBe("Sun, Jun 13, 1:00 PM · Rung 2 · amber");
    expect(w.shown[0].options.tag).toBe("post-abc");
    // The destination travels in `data`, not in the tag — a tag is a collapse key the browser may
    // overwrite, and losing it would leave a notification that opens nowhere.
    expect(w.shown[0].options.data).toEqual({ url: "/post/abc" });
  });

  /**
   * The rule that makes every branch below end in a notification. A push that resolves without
   * showing one is a "silent push": Chrome substitutes its own "site updated in the background"
   * message, and Safari counts it against a budget and REVOKES the subscription after a few. A
   * vague notification is recoverable; a revoked subscription is not, and nobody would know.
   */
  describe("always shows something, whatever arrives", () => {
    it("a push with no data at all", async () => {
      const w = loadWorker();
      await w.push(null);
      expect(w.shown).toHaveLength(1);
      expect(w.shown[0].title).toBe("Crew needed");
      expect(w.shown[0].options.data).toEqual({ url: "/board" });
    });

    it("a payload that is not JSON", async () => {
      const w = loadWorker();
      await w.push({
        json: () => {
          throw new SyntaxError("not json");
        },
      });
      expect(w.shown).toHaveLength(1);
      expect(w.shown[0].title).toBe("Crew needed");
    });

    it("JSON of the wrong shape — null, a bare string, a number, an object with no title", async () => {
      for (const value of [null, "hello", 42, { body: "no title here" }]) {
        const w = loadWorker();
        await w.push(payloadOf(value));
        expect(w.shown, `for ${JSON.stringify(value)}`).toHaveLength(1);
        expect(w.shown[0].title).toBe("Crew needed");
      }
    });

    it("a payload with a title but a missing body or url falls back per FIELD, not wholesale", async () => {
      const w = loadWorker();
      await w.push(payloadOf({ title: "Crew needed: Red Sky (Laser)" }));
      expect(w.shown[0].title).toBe("Crew needed: Red Sky (Laser)"); // the real title is kept
      expect(w.shown[0].options.body).toBe("A skipper needs crew. Open Tender to see.");
      expect(w.shown[0].options.data).toEqual({ url: "/board" });
    });
  });
});

describe("notificationclick — a tap opens the post (AC 5)", () => {
  it("closes the notification and opens the post when nothing is open", async () => {
    const w = loadWorker();
    w.setWindows([]);
    const closed = await w.click({ data: { url: "/post/abc" } });
    expect(closed).toBe(true);
    expect(w.opened).toEqual(["/post/abc"]);
  });

  it("reuses a window that is already open rather than opening a second copy of the app", async () => {
    const w = loadWorker();
    w.setWindows(["https://tender.madcowsailing.com/board"]);
    await w.click({ data: { url: "/post/abc" } });
    expect(w.opened).toEqual([]); // no second window
    expect(w.navigated).toEqual(["/post/abc"]); // the existing one was moved
  });

  it("falls back to the board when the notification carries no destination", async () => {
    const w = loadWorker();
    w.setWindows([]);
    await w.click({ data: {} });
    expect(w.opened).toEqual(["/board"]);
    const w2 = loadWorker();
    w2.setWindows([]);
    await w2.click({});
    expect(w2.opened).toEqual(["/board"]);
  });
});
