import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// expo-modules-core transitively imports react-native (Flow syntax)
// which vite-node cannot parse. Tests inject mocks via
// _setNativeForTesting; the stub only needs to satisfy imports.
export default defineConfig({
  resolve: {
    alias: {
      "expo-modules-core": resolve(
        __dirname,
        "src/__tests__/_stubExpoModules.ts",
      ),
    },
  },
  test: {
    environmentMatchGlobs: [
      ["**/*.test.tsx", "happy-dom"],
    ],
  },
});
