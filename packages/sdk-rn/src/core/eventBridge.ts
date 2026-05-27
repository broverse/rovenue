// eventBridge — converts native ChangeEvent callbacks into store mutations.
// Started by configure(); stopped by shutdown(). Idempotent: a second
// startEventBridge() call is a no-op.
//
// Why we re-fetch from native instead of trusting the event payload:
// the event is a "something changed" hint with no value attached
// (matches the M3/M4 ChangeEvent enum's intentional design). The
// authoritative value lives in the Rust core's SQLite cache; the
// native getter reads it. This costs one extra bridge call per event
// but keeps cache invalidation simple.

import { getNative } from "./native";
import { store } from "../store/reactiveStore";

let unsubscribe: (() => void) | null = null;

export function startEventBridge(): void {
  if (unsubscribe) return;
  const native = getNative();
  unsubscribe = native.addChangeListener(async (event) => {
    try {
      switch (event) {
        case "IDENTITY_CHANGED": {
          const u = await native.currentUser();
          store.set("user", u);
          break;
        }
        case "ENTITLEMENTS_CHANGED": {
          const all = await native.entitlementsAll();
          store.set("entitlementsAll", all);
          for (const ent of all) {
            store.set(`entitlement:${ent.id}`, ent);
          }
          break;
        }
        case "CREDIT_BALANCE_CHANGED": {
          const balance = await native.creditBalance();
          store.set("creditBalance", balance);
          break;
        }
        default:
          // Unknown event — ignore silently. The native ChangeEvent
          // enum may grow over time; older JS clients should not crash.
          break;
      }
    } catch {
      // Best-effort: a refresh failure here cannot crash the bridge.
    }
  });
}

export function stopEventBridge(): void {
  unsubscribe?.();
  unsubscribe = null;
}
