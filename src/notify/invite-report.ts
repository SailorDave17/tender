import { INVITE_MAX, type InviteResult } from "./invite";

/**
 * The invite report, across the redirect (story #31 AC 1).
 *
 * The action sends, then redirects to the page with the outcome per address. A Server Action
 * cannot render — it can only redirect — so the report has to survive a URL, which is why this is
 * its own module rather than a few lines in the action: a format that crosses a trust boundary is
 * worth testing directly, and the page must be able to reject what it cannot trust.
 *
 * WHAT IS AND IS NOT SAFE TO PUT HERE. The report carries email addresses, which are personal
 * data, so:
 *
 *   - It goes in the URL of a redirect the ADMIN's own browser follows, is rendered once, and is
 *     never linked to or stored. That is the same standing the existing `?error=` and `?rotated=`
 *     parameters have, and the addresses in it are ones the admin typed a moment ago.
 *   - It is NOT a bearer of authority. Nothing is read back out of it by the server and nothing
 *     is trusted: the page renders it as text. A forged report makes the page lie to whoever
 *     forged it, which is not a privilege.
 *   - It is length-bounded and shape-checked on the way out (`decodeInviteReport` returns null on
 *     anything it does not recognise), because a URL is attacker-supplied by construction and a
 *     page that renders whatever it finds there is a reflected-content hole waiting for a story
 *     that stops escaping.
 *
 * The encoding is base64url over JSON. Not to obscure anything — it is trivially readable, and
 * should be — but because an address list in a query string otherwise needs three layers of
 * escaping to survive `+` in a local part, and a plus-aliased address is exactly what the fixture
 * accounts use (`complete-story` overlay, #27).
 */

/** What the page renders. The decoded, validated form of what the action put in the URL. */
export type InviteReport = {
  sent: string[];
  refused: { email: string; error: string }[];
  members: string[];
  malformed: string[];
  duplicates: string[];
  refusal?: { reason: "cap"; fits: number } | { reason: "too_many"; max: number } | { reason: "empty" };
};

/**
 * The most characters the encoded report may run to. Fifty addresses at a generous 60 characters
 * each, plus the shape around them, sits comfortably inside this; browsers and Next both handle
 * several times it. The bound exists so a decode is cheap and a hand-built URL cannot make the
 * page parse something enormous.
 */
const MAX_ENCODED = 8000;

export function encodeInviteReport(result: InviteResult): string {
  const report: InviteReport = {
    sent: result.outcomes.filter((o) => o.state === "sent").map((o) => o.email),
    refused: result.outcomes
      .filter((o): o is Extract<typeof o, { state: "refused" }> => o.state === "refused")
      // The provider's message is truncated: it is not the admin's business beyond "this one did
      // not go", and an unbounded string from an external service does not belong in a URL.
      .map((o) => ({ email: o.email, error: o.error.slice(0, 120) })),
    members: result.outcomes.filter((o) => o.state === "member").map((o) => o.email),
    malformed: result.malformed.map((m) => m.slice(0, 120)),
    duplicates: result.duplicates.map((d) => d.slice(0, 120)),
    ...(result.refusal ? { refusal: result.refusal } : {}),
  };
  return Buffer.from(JSON.stringify(report), "utf8").toString("base64url");
}

/**
 * Read a report back out of the URL, or null when it is not one.
 *
 * Every field is checked, not just parsed: `JSON.parse` on attacker-supplied text yields any
 * shape at all, and the page indexes into these arrays. Null on anything unexpected, so the
 * page's own fallback ("the report could not be read") is the single answer for a truncated URL,
 * a hand-edited one and a stale bookmark alike.
 */
export function decodeInviteReport(param: string | undefined): InviteReport | null {
  if (!param || param.length > MAX_ENCODED) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(param, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const r = parsed as Record<string, unknown>;

  const strings = (v: unknown): string[] | null =>
    Array.isArray(v) && v.every((x) => typeof x === "string") && v.length <= INVITE_MAX * 2
      ? (v as string[])
      : null;

  const sent = strings(r.sent);
  const members = strings(r.members);
  const malformed = strings(r.malformed);
  const duplicates = strings(r.duplicates);
  if (!sent || !members || !malformed || !duplicates) return null;

  if (!Array.isArray(r.refused) || r.refused.length > INVITE_MAX * 2) return null;
  const refused: InviteReport["refused"] = [];
  for (const entry of r.refused) {
    if (typeof entry !== "object" || entry === null) return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.email !== "string" || typeof e.error !== "string") return null;
    refused.push({ email: e.email, error: e.error });
  }

  const refusal = decodeRefusal(r.refusal);
  if (refusal === undefined && r.refusal !== undefined) return null;

  return { sent, refused, members, malformed, duplicates, ...(refusal ? { refusal } : {}) };
}

function decodeRefusal(v: unknown): InviteReport["refusal"] | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null) return undefined;
  const r = v as Record<string, unknown>;
  if (r.reason === "empty") return { reason: "empty" };
  if (r.reason === "cap" && typeof r.fits === "number" && Number.isInteger(r.fits) && r.fits >= 0) {
    return { reason: "cap", fits: r.fits };
  }
  if (r.reason === "too_many" && typeof r.max === "number" && Number.isInteger(r.max) && r.max > 0) {
    return { reason: "too_many", max: r.max };
  }
  return undefined;
}
