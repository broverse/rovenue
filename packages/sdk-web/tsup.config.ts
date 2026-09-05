import { defineConfig } from "tsup";

// Builds ESM + CJS + .d.ts for three entry points.
//
// They are separate entries, not one bundle, so a consumer that imports only
// the core never pays for React. That is the whole reason `sideEffects: false`
// and the split exist: the core is what a plain-JS site loads, and React is
// most of the weight.
//
// `@rovenue/shared` and `@rovenue/paywall-renderer` are workspace packages
// that ship TypeScript sources, so they are BUNDLED rather than externalised —
// a published consumer has no way to resolve `workspace:*`. React is external
// because the host owns it and two copies break hooks.

export default defineConfig({
  entry: {
    index: "src/index.ts",
    react: "src/react/index.ts",
    paywall: "src/paywall/index.tsx",
  },
  format: ["esm", "cjs"],
  dts: true,
  outDir: "dist",
  clean: true,
  sourcemap: true,
  target: "es2020",
  splitting: true,
  treeshake: true,
  // Force .js for ESM and .cjs for CJS so the exports map resolves
  // regardless of the package `type` field.
  outExtension({ format }) {
    return { js: format === "esm" ? ".js" : ".cjs" };
  },
  external: ["react", "react-dom", "react/jsx-runtime"],
  // Workspace packages are `private: true` and ship TypeScript sources, so a
  // consumer installing this from npm cannot resolve them — `workspace:*` is
  // not a publishable specifier. They must be inlined, and only a real build
  // shows it: the source tree resolves them fine.
  noExternal: [/^@rovenue\//],
});
