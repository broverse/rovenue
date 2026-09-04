// =============================================================
// Narrow CI check: the VITE_* restricted-syntax rule, in isolation
// =============================================================
//
// eslint.config.mjs's no-restricted-syntax block is spec §10's own
// exemplar for keeping VITE_* reads confined to lib/runtime-config.ts, but
// `npx eslint apps/dashboard/src` is red on main today from pre-existing,
// unrelated failures (react-hooks/exhaustive-deps "rule not found",
// no-irregular-whitespace) that are not in scope for this fix. Running the
// full config in CI would either block on those or require fixing them.
//
// This dedicated flat config loads ONLY the TypeScript/JSX parser and the
// one rule, so CI (.github/workflows/ci.yml) can enforce it in isolation.
// Keep the selectors and message in sync with the matching block in
// eslint.config.mjs.
import tseslint from "typescript-eslint";

const VITE_ENV_MESSAGE =
  "Read deployment config through lib/runtime-config.ts. Vite inlines VITE_* at build time, which a published image cannot override.";

export default [
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/build/**",
      "**/.turbo/**",
      "**/coverage/**",
    ],
  },
  {
    files: ["apps/dashboard/src/**/*.ts", "apps/dashboard/src/**/*.tsx"],
    ignores: ["apps/dashboard/src/lib/runtime-config.ts"],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    // This config loads no other plugins (not even the ones eslint.config.mjs
    // loads), so an inline `eslint-disable` comment naming a rule from an
    // unregistered plugin (react-hooks/exhaustive-deps, etc.) would otherwise
    // be reported as a fatal "Definition for rule ... was not found" error —
    // that's the pre-existing, out-of-scope redness this config must not
    // inherit. Inline directives are irrelevant to the one rule this config
    // enforces, so turn off directive processing entirely rather than
    // chasing every plugin those comments happen to name.
    linterOptions: {
      noInlineConfig: true,
    },
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          // import.meta.env.VITE_X
          selector:
            "MemberExpression[object.object.type='MetaProperty'][property.name=/^VITE_/]",
          message: VITE_ENV_MESSAGE,
        },
        {
          // import.meta.env["VITE_X"]
          selector:
            "MemberExpression[object.object.type='MetaProperty'][computed=true][property.value=/^VITE_/]",
          message: VITE_ENV_MESSAGE,
        },
        {
          // const { VITE_X } = import.meta.env
          selector:
            "VariableDeclarator[init.type='MemberExpression'][init.object.type='MetaProperty'] > ObjectPattern > Property[key.name=/^VITE_/]",
          message: VITE_ENV_MESSAGE,
        },
      ],
    },
  },
];
