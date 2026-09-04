import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

// Keep in sync with eslint.config.restricted-syntax.mjs, which enforces
// this same rule in isolation in CI (see that file for why).
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
  js.configs.recommended,
  ...tseslint.configs.recommended,
  prettier,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "warn",
    },
  },
  {
    // Deployment config is read in exactly one place. Vite inlines
    // import.meta.env.VITE_* at BUILD time, so a direct read anywhere else
    // silently re-breaks the published dashboard image — a bug that never
    // reproduces in dev and never fails a test.
    files: ["apps/dashboard/src/**/*.ts", "apps/dashboard/src/**/*.tsx"],
    ignores: ["apps/dashboard/src/lib/runtime-config.ts"],
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
