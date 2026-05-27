import { defineConfig } from "tsup";

// Builds ESM + CJS + .d.ts for the JS surface. The Expo config plugin
// is built separately via tsconfig.plugin.json (Task 8) because it
// must be plain CommonJS — Expo loads it via `require()`.

export default defineConfig({
  entry: ["src/index.ts", "src/version.ts"],
  format: ["esm", "cjs"],
  dts: true,
  outDir: "dist",
  clean: true,
  sourcemap: true,
  target: "es2020",
  // Force .js for ESM and .cjs for CJS so the package.json `exports`
  // map resolves correctly regardless of the package `type` field.
  outExtension({ format }) {
    return { js: format === "esm" ? ".js" : ".cjs" };
  },
  external: [
    "react",
    "react-native",
    "expo",
    "expo-modules-core",
    "@rovenue/shared",
  ],
});
