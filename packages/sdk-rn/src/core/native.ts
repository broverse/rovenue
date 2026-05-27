// Lazily acquires the native Expo module the first time we touch it.
// Tests override `_setNativeForTesting` to inject a mock instead.
//
// `getEmitter()` constructs an EventEmitter against the current native
// instance — lazy so test injection is observed.

import { EventEmitter, requireNativeModule } from "expo-modules-core";
import type { RovenueModuleSpec } from "../specs/RovenueModule.types";

let instance: RovenueModuleSpec | null = null;
let emitter: EventEmitter | null = null;

export function getNative(): RovenueModuleSpec {
  if (instance) return instance;
  instance = requireNativeModule<RovenueModuleSpec>("Rovenue");
  return instance;
}

export function getEmitter(): EventEmitter {
  if (emitter) return emitter;
  emitter = new EventEmitter(getNative() as any);
  return emitter;
}

// Test seam: replaces the cached instance + forces a fresh emitter.
// Production code MUST NOT call this.
export function _setNativeForTesting(mock: RovenueModuleSpec | null): void {
  instance = mock;
  emitter = null;
}
