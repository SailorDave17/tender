import type { Instrumentation } from "next";
import { toReport } from "@/notify/error";
import { reportErrorLive } from "@/notify/error-live";

/**
 * Next's server error hook (story #43) — the club's entire observability layer.
 *
 * docs/charter.md asks for "errors emailed to the owner; nothing else", and Vercel Hobby has no
 * email alerting and keeps its function log for one hour, so an error nobody reads inside that
 * hour is an error nobody ever reads (tender #130 lost eleven scheduled firings exactly that
 * way). This hook is what makes an hour down on a Sunday morning reach a person.
 *
 * DELIBERATELY AN ADAPTER AND NOTHING ELSE. The narrowing is `toReport` in the pure module and
 * every rule is in `reportError` beside it, because this file imports `server-only` through
 * `error-live` and so cannot be imported by a test at all. Logic put here would be logic no
 * instrument can reach.
 *
 * `await`, because Next says an async task in this hook must be awaited or the server may
 * finish the request and tear the invocation down mid-send. `reportErrorLive` swallows its own
 * failures; the catch here is for a rejection that gets past it, and never rethrows — Next wraps
 * this call too (`instrumentationOnRequestError` in base-server.js), and an error raised while
 * reporting an error would replace the symptom with itself.
 *
 * What it does NOT see, so nobody looks for it here: an error the app has already caught. Every
 * `…Live` wrapper in src/notify/live.ts swallows its failure to a console.error on purpose, and
 * a swallowed error never throws out of the route, so it never reaches this hook. Surfacing
 * those is not this story's (src/notify/live.ts says so at morningOfLive).
 */
export const onRequestError: Instrumentation.onRequestError = async (error, request, context) => {
  try {
    await reportErrorLive(toReport(error, request, context));
  } catch (e) {
    console.error("onRequestError: the error reporter itself failed:", e instanceof Error ? e.message : e);
  }
};
