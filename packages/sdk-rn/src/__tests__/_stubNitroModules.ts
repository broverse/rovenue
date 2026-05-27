// Vitest-only stub for react-native-nitro-modules. The real package
// transitively imports react-native, which uses Flow syntax that
// vite-node cannot parse. Tests inject native mocks via
// _setNativeForTesting so the real createHybridObject is never called.

export const NitroModules = {
  createHybridObject(_name: string): never {
    throw new Error(
      "NitroModules.createHybridObject called in tests — use _setNativeForTesting()",
    );
  },
};

// Type-only re-export shim. HybridObject is a phantom type at runtime.
export type HybridObject<_T = unknown> = object;
