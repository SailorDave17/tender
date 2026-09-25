import type { ErrorReport } from "@/notify/error";

/**
 * What a read of `club.admin_email` MEANS for /support (story #204) — the pure half of
 * `src/support/contact.ts`, which imports `server-only` and so cannot be imported by a test.
 *
 * THREE STATES, NOT TWO. An address is the page's contact. A null or blank column is a state the
 * club chose (0009 made it nullable: "a club row may exist before anyone has decided who the
 * admin is"), and the page says in words who to ask. A REFUSED read is neither: the club has an
 * address, and this request could not see it. Until #204 that third case threw, and /support —
 * the page meant for people who are stuck — showed the error screen instead. On 2026-09-22 the
 * platform refused 1 of 477 service-key requests with `JWT issued at future` (#198), and #198's
 * probe of a production build measured exactly that on /support while every other page rendered.
 *
 * WHY NOT THE NULL WORDING. "The club has not given Tender a contact address yet" would be untrue
 * during a refusal, and a member who believed it would stop looking. Owner decision at pickup,
 * 2026-09-24: a sentence of its own, saying the address could not be loaded and to reload.
 *
 * WHY NO RETRY. The same choice #198 made for the theme, for the same reason: the upstream report
 * (supabase/supabase#50651) has the skew outlasting a 2 s retry, so a retry adds a round trip to
 * every refused load and still needs this fallback behind it.
 *
 * WHY IT IS STILL REPORTED. Nothing throws any more, so Next's error hook never sees this, and a
 * fallback that works hides the failure it absorbs (cairn:
 * a-fallback-absorbs-the-symptom-its-diagnostic-names). The loader hands the report to the
 * reporter after the response, as the theme's does.
 */

export type SupportContact =
  | { kind: "address"; address: string }
  | { kind: "none" }
  | { kind: "unreadable" };

/** The error name a refused read is reported under, and so half of its dedupe signature. */
export const SUPPORT_ADDRESS_READ_ERROR = "SupportAddressReadError";

/** Where the report says it happened: the loader, the other half of the signature. */
export const SUPPORT_ADDRESS_ROUTE = "loadSupportAddress";

/** What PostgREST's `maybeSingle()` answers, narrowed to what this file reads. */
export type SupportAddressRead = {
  data: { admin_email: unknown } | null;
  error: { message: string } | null;
};

/** The report for a refused read, in the shape the error hook's reporter already takes. */
export function supportAddressFailureReport(message: string): ErrorReport {
  return {
    name: SUPPORT_ADDRESS_READ_ERROR,
    message:
      `support address could not be read: ${message}. ` +
      `/support rendered and told the reader to reload, instead of failing.`,
    stack: null,
    method: "GET",
    path: "/support",
    routePath: SUPPORT_ADDRESS_ROUTE,
    routeType: "degraded",
    digest: null,
  };
}

/**
 * The contact a read yields. A refused read reports and says so; an address is the contact; a
 * missing row or a null or blank column is `none`, exactly as before #204. `report` is called at
 * most once and before this returns.
 */
export function contactFromRead(read: SupportAddressRead, report: (r: ErrorReport) => void): SupportContact {
  if (read.error) {
    report(supportAddressFailureReport(read.error.message));
    return { kind: "unreadable" };
  }
  const value = read.data?.admin_email;
  return typeof value === "string" && value.trim() ? { kind: "address", address: value.trim() } : { kind: "none" };
}
