import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

// react-native-nitro-modules transitively imports react-native, whose
// `index.js` contains Flow syntax that vite-node cannot parse. Tests
// never need the real native bindings — they inject mocks via
// _setNativeForTesting — so we alias the module to a tiny stub.
export default defineConfig({
  resolve: {
    alias: {
      "react-native-nitro-modules": resolve(
        __dirname,
        "src/__tests__/_stubNitroModules.ts",
      ),
    },
  },
});
