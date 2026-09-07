// Lazily acquires the native Expo module the first time we touch it.
// Tests override `_setNativeForTesting` to inject a mock instead.
//
// `getEmitter()` resolves an event emitter for the native module in a way
// that works across every Expo SDK we support (51 → 56):
//
//   - Expo SDK 51 (expo-modules-core 1.x): the module is NOT an emitter.
//     Its `addListener(eventName)` is the 1-arg NativeEventEmitter
//     bookkeeping hook (the listener is ignored), so we must subscribe
//     through the legacy `new EventEmitter(nativeModule)` JS wrapper.
//   - Expo SDK 52+ (expo-modules-core 2.x / 3.x): the EventEmitter moved
//     to C++ and every native module now *extends* it. We subscribe on
//     the module directly via its real 2-arg `addListener(name, listener)`.
//
// NOTE (2026-09-07), two corrections to what this comment used to claim:
//
//  1. It said the legacy `new EventEmitter(module)` constructor "no longer
//     exists" on 52+. It does. In the resolved expo-modules-core@2.5.0 it is
//     `constructor(object: EventEmitter)`, marked `@deprecated As of Expo SDK
//     52 the given object is already an EventEmitter` and `@hidden`. It is
//     deprecated, not removed — but note its parameter type: on 2.x it expects
//     something that ALREADY is an emitter, so it cannot do the wrapping job
//     the SDK-51 branch below needs it for. That branch therefore only
//     functions on expo-modules-core 1.x.
//
//  2. It said this file supports "every Expo SDK we support (51 -> 56)".
//     `package.json` declares `expo >=52.0.0` and `expo-modules-core >=2.0.0`.
//     Under that floor the SDK-51 branch is unreachable. Manifest and comment
//     disagree, and that contradiction is UNRESOLVED: deciding it means either
//     dropping the branch or lowering the floor, and neither is safe to assert
//     until the floor is verified by a real native build. `examples/sample-rn-expo`
//     is still pinned at expo ~51 / RN 0.74.5, below the floor, and is
//     CI-verified typecheck-only.
//
//     `__tests__/native.test.ts` exercises the SDK-51 branch against a STUB
//     EventEmitter whose constructor accepts a plain object. The real 2.x
//     constructor does not. So that test does not evidence the branch works
//     on any supported version.
//
// The emitter is resolved lazily so test injection is observed.

import { EventEmitter, requireNativeModule } from "expo-modules-core";
import type { RovenueModuleSpec } from "../specs/RovenueModule.types";

// The common shape both code paths expose: a subscription-returning
// `addListener`. This is all the callers (eventBridge, log, index) need.
type ListenerEmitter = {
  addListener(
    eventName: string,
    listener: (payload: any) => void,
  ): { remove(): void };
};

let instance: RovenueModuleSpec | null = null;
let emitter: ListenerEmitter | null = null;

export function getNative(): RovenueModuleSpec {
  if (instance) return instance;
  instance = requireNativeModule<RovenueModuleSpec>("Rovenue");
  return instance;
}

export function getEmitter(): ListenerEmitter {
  if (emitter) return emitter;
  const native = getNative() as unknown as ListenerEmitter & {
    addListener?: (...args: unknown[]) => unknown;
  };
  // On expo-modules-core ≥ 2 the module itself is an EventEmitter; the
  // arity check is a belt-and-suspenders guard for setups where the
  // `instanceof` identity is lost (e.g. duplicated core copies under a
  // monorepo) but the real 2-arg `addListener` is still present.
  const moduleIsEmitter =
    native instanceof EventEmitter ||
    (typeof native.addListener === "function" && native.addListener.length >= 2);
  emitter = moduleIsEmitter
    ? native
    : (new EventEmitter(native as any) as unknown as ListenerEmitter);
  return emitter;
}

// Test seam: replaces the cached instance + forces a fresh emitter.
// Production code MUST NOT call this.
export function _setNativeForTesting(mock: RovenueModuleSpec | null): void {
  instance = mock;
  emitter = null;
}
