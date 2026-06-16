// Verifies getEmitter() picks the right subscription path per Expo SDK:
//   - SDK 52+ : the native module *is* an EventEmitter — subscribe on it
//               directly (no legacy wrapper).
//   - SDK 51  : a plain module is wrapped in the legacy EventEmitter.
//
// `expo-modules-core` is aliased to the test stub (see vitest.config.ts),
// so `EventEmitter` here is the stub class and `instanceof` is meaningful.

import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter } from "expo-modules-core";
import { _setNativeForTesting, getEmitter } from "../core/native";

describe("getEmitter version resolution", () => {
  afterEach(() => _setNativeForTesting(null));

  it("SDK 52+: returns the module itself when it is an EventEmitter", () => {
    const calls: Array<[string, unknown]> = [];
    // A module that extends EventEmitter and exposes a real 2-arg
    // addListener — mirrors expo-modules-core ≥ 2.
    const modern: any = new EventEmitter({});
    modern.addListener = (name: string, cb: (p: any) => void) => {
      calls.push([name, cb]);
      return { remove() {} };
    };
    _setNativeForTesting(modern);

    const em = getEmitter();
    expect(em).toBe(modern); // subscribed directly, no wrapper allocated
    em.addListener("onChange", () => {});
    expect(calls).toHaveLength(1);
  });

  it("SDK 52+: also accepts a non-instanceof module with a 2-arg addListener", () => {
    // Guards the monorepo edge case where `instanceof` identity is lost
    // but the real 2-arg addListener is still present.
    const plainModern: any = {
      addListener: (_name: string, _cb: (p: any) => void) => ({ remove() {} }),
    };
    _setNativeForTesting(plainModern);
    expect(getEmitter()).toBe(plainModern);
  });

  it("SDK 51: wraps a plain module in the legacy EventEmitter", () => {
    const legacy: any = {
      // 1-arg bookkeeping hook — listener is ignored at this layer.
      addListener: (_eventName: string) => {},
      removeListeners: (_count: number) => {},
    };
    _setNativeForTesting(legacy);

    const em = getEmitter();
    expect(em).not.toBe(legacy);
    expect(em).toBeInstanceOf(EventEmitter);
  });
});
