// Vitest stub for `expo-modules-core`. The real module pulls in
// react-native (Flow syntax) which vite-node cannot parse. Tests use
// _setNativeForTesting() to inject a mock; this stub only needs to
// satisfy the imports.

export function requireNativeModule<T>(name: string): T {
  throw new Error(
    `_stubExpoModules: requireNativeModule(${JSON.stringify(name)}) was called — ` +
      `tests must call _setNativeForTesting() before any module accessor runs.`,
  );
}

type Subscription = { remove: () => void };

// Minimal EventEmitter that delegates addListener/removeListeners to the
// underlying mock's __addChangeListener / __addLogListener helpers when
// available. Mirrors the public method names of expo-modules-core's
// EventEmitter but does NOT preserve its full semantics.
export class EventEmitter {
  private nativeModule: any;
  constructor(nativeModule: any) {
    this.nativeModule = nativeModule;
  }
  addListener(eventName: string, cb: (payload: any) => void): Subscription {
    if (eventName === "onChange" && typeof this.nativeModule?.__addChangeListener === "function") {
      return { remove: this.nativeModule.__addChangeListener(cb) };
    }
    if (eventName === "onLog" && typeof this.nativeModule?.__addLogListener === "function") {
      return { remove: this.nativeModule.__addLogListener(cb) };
    }
    return { remove: () => {} };
  }
  removeAllListeners(_eventName: string): void {}
}
