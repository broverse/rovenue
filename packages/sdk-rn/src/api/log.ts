// Rovenue.setLogHandler — JS-side seam for receiving bridge-level log
// events from M3/M4. The native module emits `onLog` events; we hold a
// single subscription and forward to the user-provided handler.
//
// Passing `null` removes the active subscription. Replacing a handler
// implicitly unsubscribes the prior one — there is only ever one active
// handler at a time, matching the M3/M4 façade contract.

import { getEmitter } from "../core/native";

export type LogEntry = {
  level: "off" | "error" | "warn" | "info" | "debug" | "trace";
  message: string;
  data?: Record<string, unknown>;
};

let subscription: { remove(): void } | null = null;

export function setLogHandler(fn: ((entry: LogEntry) => void) | null): void {
  subscription?.remove();
  subscription = null;
  if (fn) {
    subscription = getEmitter().addListener(
      "onLog",
      (native: { level: LogEntry["level"]; message: string; fields?: Record<string, string> }) => {
        const entry: LogEntry = {
          level: native.level,
          message: native.message,
          data:
            native.fields && Object.keys(native.fields).length > 0
              ? native.fields
              : undefined,
        };
        fn(entry);
      },
    );
  }
}
