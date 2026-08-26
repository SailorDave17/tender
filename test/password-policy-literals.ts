/**
 * The detector behind `password-policy.test.ts` (#100 AC 8), separated so it can be proven on a
 * fixture before it is turned loose on `src/` — a grep-shaped guard passes on an empty corpus,
 * and passing for that reason is indistinguishable from passing for the right one (cairn:
 * a-mutation-certifies-the-corpus-not-the-guard-2026-08-20).
 *
 * **The subject is the password policy's NUMBER, written out instead of imported.** It has four
 * shapes: the constant re-declared, a form constraint, a threshold, and a sentence a member
 * reads. Three of them carried the literal `8` in two files before #100.
 *
 * Four deliberate choices, each of which is a way this could have been wrong:
 *
 * - **Any digits, not just today's `PASSWORD_MIN`.** Keying the match on the constant's current
 *   value would go quiet in exactly the case that matters most: raise the policy to 10 and every
 *   surviving `8` stops being matched, so the guard falls silent the moment it has something to
 *   say. What is forbidden is a *literal* in these positions, whatever it says.
 * - **`minLength` and not `maxLength`.** The policy is a minimum. `maxLength={80}` on a name and
 *   `maxLength={280}` on a note are unrelated constraints and must not be refused. The cost is
 *   stated rather than hidden: a future `minLength` on some other field would be flagged, and
 *   that is a question for whoever adds it, not a silent pass.
 * - **A threshold, not an emptiness check.** `password.length < 8` is the policy; `password.length
 *   === 0` and `password.length > 0` are "did they type anything", which is nobody's policy, so
 *   the comparison shape takes only `<`/`>` against a non-zero number. `src/auth/password.ts`'s
 *   own `input.password.length === 0` is the live example, and matching it would have made this
 *   guard's exemption look load-bearing when it was not.
 * - **No comment stripping.** A comment quoting the number is a copy of the policy that ages
 *   exactly like a line of code, and this guard's own docblock is deliberately written without
 *   one. Stripping would also mean running a hand-rolled lexer over files it has never seen,
 *   which is what #78 measured eating real configuration (cairn:
 *   a-guard-preprocesses-its-evidence-before-it-looks-2026-08-25).
 *
 * What it does **not** cover, said plainly: a fresh constant under a different name
 * (`const MIN_CHARS = 8`) is not the policy's name and is not matched. The declaration shape below
 * closes the likely re-declaration, not every conceivable one.
 */

export type PolicyHit = { line: number; text: string; shape: string };

/**
 * The `g` flag is safe to store here because `matchAll` clones the regex and never advances the
 * original's `lastIndex` — *measured*, two calls over the same text both return 2 with
 * `lastIndex` still 0. It would NOT be safe under `.test()` or `.exec()`, which do advance it:
 * the same measurement shows one `.test` call dropping the next `matchAll` from 2 hits to 1. So
 * the repeat-call assertion in the test file is a live control for that rewrite rather than
 * decoration, and no defensive clone is needed for the code as it stands.
 */
const SHAPES: { name: string; re: RegExp }[] = [
  // A second `export const PASSWORD_MIN = 8` somewhere else is two policies, not one.
  { name: "policy declaration", re: /PASSWORD_MIN\s*=\s*\d/g },
  // <input minLength={8} />, or minLength: 8 in a props object. `\s*` spans newlines, so a JSX
  // attribute broken across lines is still one match.
  { name: "minLength literal", re: /minLength\s*[=:]\s*\{?\s*\d/g },
  // password.length < 8 and its family — but not `> 0`, which is an emptiness check.
  { name: "password length threshold", re: /password\w*\s*\.\s*length\s*[<>]=?\s*(?!0\b)\d/gi },
  // "Choose a password of at least 8 characters."
  { name: "policy sentence", re: /at\s+least\s+\d+\s+characters?/gi },
];

/** Every place `text` writes the password policy's number out instead of importing it. */
export function findPolicyLiterals(text: string): PolicyHit[] {
  const lines = text.split("\n");
  const hits: PolicyHit[] = [];
  for (const shape of SHAPES) {
    for (const m of text.matchAll(shape.re)) {
      const line = text.slice(0, m.index).split("\n").length;
      hits.push({ line, text: lines[line - 1].trim(), shape: shape.name });
    }
  }
  return hits.sort((a, b) => a.line - b.line);
}
