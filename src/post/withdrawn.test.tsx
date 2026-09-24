import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { IDS, ME, TABLES, fakeClient } from "../../test/surfaces";

/**
 * Story #199 on the two pages a push opens: /post/<id> and /post/<id>/thread, rendered as the real
 * Server Components over test/surfaces.ts's fake client. The post under test is ABSENT from the
 * fixture's `post` and `match` rows, which is what 0006 hands anyone once its race day is
 * unpublished; what differs between the arms is only what withdrawn_post_day() (0034) answers.
 *
 * Every deny arm sits beside its positive control in the same test (AC 2), so "Not here" means
 * the page chose it, not that the render broke: the same page, the same missing post, a non-null
 * day → the withdrawn sentence; a null day → notFound().
 */

const holder = vi.hoisted(() => ({ client: null as unknown }));
vi.mock("@/lib/supabase/server", () => ({ supabaseServer: async () => holder.client }));
vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => undefined, delete: () => undefined }),
}));
vi.mock("@/app/post/actions", () => ({
  acceptAnswer: async () => undefined,
  answerPost: async () => undefined,
  closePost: async () => undefined,
  setMatchStatus: async () => undefined,
}));
vi.mock("@/app/post/[id]/thread/actions", () => ({ sendMessage: async () => undefined }));

const PULLED_POST = "00000000-0000-4000-8000-000000000099";
const PULLED_DAY = "2027-06-13T17:00:00+00:00"; // PostgREST's timestamptz shape

/** The surfaces client, with withdrawn_post_day answering `day` for PULLED_POST and nothing else. */
function clientAnswering(day: string | null, error: unknown = null) {
  const calls: { fn: string; args: unknown }[] = [];
  // No match rows: the stand-in's `.eq` filters nothing, and 0008 shows no match on a post whose
  // day is unpublished — so the thread page's `maybeSingle` must come back null, as it would.
  const base = fakeClient(ME, { ...TABLES, match: [] });
  const client = {
    ...base,
    rpc: async (fn: string, args: { p_post?: string; post_ids?: string[] }) => {
      calls.push({ fn, args });
      if (fn !== "withdrawn_post_day") return base.rpc(fn, args);
      return { data: args.p_post === PULLED_POST ? day : null, error };
    },
  };
  return { client, calls };
}

const NOT_FOUND = /NEXT_HTTP_ERROR_FALLBACK;404/;
const digestOf = (e: unknown) => String((e as { digest?: string }).digest ?? e);

async function renderPost(id: string) {
  const { default: Page } = await import("@/app/post/[id]/page");
  return renderToStaticMarkup(await Page({ params: Promise.resolve({ id }), searchParams: Promise.resolve({}) }));
}
async function renderThread(id: string) {
  const { default: Page } = await import("@/app/post/[id]/thread/page");
  return renderToStaticMarkup(await Page({ params: Promise.resolve({ id }) }));
}

afterEach(() => {
  holder.client = null;
});

describe.each([
  ["/post/[id]", renderPost],
  ["/post/[id]/thread", renderThread],
])("%s on a post whose race day was unpublished (#199)", (_route, render) => {
  it("tells one of the post's own people the day was withdrawn, and names the day (AC 1)", async () => {
    const { client, calls } = clientAnswering(PULLED_DAY);
    holder.client = client;
    const html = await render(PULLED_POST);
    expect(html).toContain("data-withdrawn");
    expect(html).toContain("This race day was withdrawn");
    expect(html).toContain("Sun, Jun 13, 2027"); // formatStartsAt in the club's zone
    expect(html).toContain('href="/board"');
    expect(html).not.toContain("Not here");
    // asked about THIS post, by the argument name 0034 declares
    expect(calls).toContainEqual({ fn: "withdrawn_post_day", args: { p_post: PULLED_POST } });
  });

  it("gives anyone else \"Not here\" — beside the positive control on the same missing post (AC 2)", async () => {
    holder.client = clientAnswering(PULLED_DAY).client;
    expect(await render(PULLED_POST)).toContain("data-withdrawn"); // positive control

    holder.client = clientAnswering(null).client;
    const refused = await render(PULLED_POST).then(
      () => "rendered",
      (e: unknown) => digestOf(e),
    );
    expect(refused).toMatch(NOT_FOUND);
  });

  it("falls back to \"Not here\" when the function errors, rather than rendering anything", async () => {
    holder.client = clientAnswering(PULLED_DAY, { message: "boom", code: "XX000" }).client;
    const refused = await render(PULLED_POST).then(
      () => "rendered",
      (e: unknown) => digestOf(e),
    );
    expect(refused).toMatch(NOT_FOUND);
  });
});

describe("/post/[id] on a post that IS readable never asks (#199)", () => {
  it("renders the post and makes no withdrawn_post_day call", async () => {
    const { client, calls } = clientAnswering(PULLED_DAY);
    holder.client = client;
    const html = await renderPost(IDS.postOpen);
    expect(html).toContain("Blue Moon needs crew");
    expect(html).not.toContain("data-withdrawn");
    expect(calls.map((c) => c.fn)).not.toContain("withdrawn_post_day");
  });
});
