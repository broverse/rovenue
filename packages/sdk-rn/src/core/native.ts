// Lazily creates the Nitro hybrid object the first time we touch it.
// Tests override `_setNativeForTesting` to inject a mock instead.

import { NitroModules } from "react-native-nitro-modules";
import type { RovenueNitroSpec } from "../specs/RovenueNitroSpec.nitro";

let instance: RovenueNitroSpec | null = null;

export function getNative(): RovenueNitroSpec {
  if (instance) return instance;
  instance = NitroModules.createHybridObject<RovenueNitroSpec>("RovenueNitroSpec");
  return instance;
}

// Test seam: replaces the cached instance. Production code MUST NOT call this.
export function _setNativeForTesting(mock: RovenueNitroSpec | null): void {
  instance = mock;
}
