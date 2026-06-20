import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  // Match the Node 22 Alpine base image in Dockerfile
  target: "node22",
  bundle: true,
  // Inline all @rovenue/* workspace packages so their extensionless-ESM
  // dist files (which Node ESM cannot resolve) never appear in the output.
  noExternal: [/^@rovenue\//],
  // CJS packages that use dynamic require() of Node built-ins (pino, pg,
  // bcryptjs) must stay external — tsup's __commonJS shim does not support
  // dynamic requires.  Node 22 handles CJS↔ESM interop natively for these.
  // Listed explicitly because they are transitive deps of @rovenue/shared
  // and @rovenue/db (inlined above) and would otherwise be bundled.
  external: [
    "pino",
    "pino-pretty",
    "pino-std-serializers",
    "pg",
    "bcryptjs",
  ],
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // email-templates imports React JSX components — tsup must know how to
  // transform .tsx files encountered while bundling @rovenue/email-templates.
  esbuildOptions(options) {
    options.jsx = "automatic";
  },
});
