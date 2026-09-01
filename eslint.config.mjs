import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
  {
    rules: {
      // Omitting a key by destructuring it out — `const { person: _x, ...rest } = overrides` — is
      // the idiomatic way to build a spread that cannot carry that key, and the discarded binding
      // is unused BY CONSTRUCTION. Without this option the rule reports it, which is a warning
      // nobody can act on: deleting the binding changes what `rest` contains.
      //
      // `src/auth/join.test.ts` is the live case and the reason this is a real rule rather than a
      // tidy-up. Its fake store is merged field-by-field so a partial override keeps the recorders
      // that make `calls.createUser === 0` mean "never called" instead of "was replaced", and the
      // key is destructured out precisely so the spread below cannot swap the whole store back in
      // (cairn: a-fake-cannot-disagree-with-its-author-2026-08-24, where overriding a recording
      // fake silently dropped the recording and reported an alarming zero).
      //
      // Deliberately NOT `varsIgnorePattern: "^_"`, which is the commoner fix and the broader one:
      // it exempts by NAMING, so any unused `_foo` anywhere goes unreported forever. This exempts
      // by STRUCTURE, so it can only ever apply where a rest sibling proves the omission was the
      // point. The `_` on `_storeOverride` therefore still means nothing to the linter, and that
      // is intended — it is a note to a human reader, not a silencer.
      //
      // *Measured 2026-08-31*, four arms, restoring between each: baseline 1 warning; with this
      // option 0; with a plain unused variable added 1 (so the rule is narrowed, not disabled);
      // with an unused `_underscorePrefixed` variable that is NOT a rest sibling, 1 — which is the
      // control proving the exemption is structural.
      "@typescript-eslint/no-unused-vars": ["warn", { ignoreRestSiblings: true }],
    },
  },
]);

export default eslintConfig;
