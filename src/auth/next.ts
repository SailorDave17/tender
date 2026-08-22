/**
 * Where to send a person after the magic link lands. The `next` query parameter is attacker-
 * supplied (it rides in the emailed link), so anything that could leave this origin is replaced
 * by the board: absolute URLs, protocol-relative `//host`, backslash tricks browsers normalise
 * to `//`, bare schemes, and anything carrying control characters.
 */
export const DEFAULT_NEXT = "/board";

const CONTROL_OR_SPACE = /[\s\x00-\x1f\x7f]/;

export function safeNext(next: string | null | undefined): string {
  if (!next) return DEFAULT_NEXT;
  // Control characters and whitespace: the URL parser silently strips tab, CR and LF, so a
  // value carrying them would parse as an honest path. Refuse them before parsing.
  if (CONTROL_OR_SPACE.test(next)) return DEFAULT_NEXT;
  // One mechanism for everything else, deliberately — not a regex plus a parser. Resolving
  // against a fixed origin sends an absolute URL, a protocol-relative `//host`, a backslash
  // form and a bare scheme to a different origin, and that is the whole test. Two overlapping
  // guards here would let either be deleted with no test going red.
  try {
    const u = new URL(next, "https://tender.invalid");
    if (u.origin !== "https://tender.invalid") return DEFAULT_NEXT;
    return u.pathname + u.search + u.hash;
  } catch {
    return DEFAULT_NEXT;
  }
}
