// eventBridge — converts native `onChange` events into ReactiveStore
// mutations. Started by configure(); stopped by shutdown().
//
// In M6 we subscribe via Expo's EventEmitter ("onChange" event) instead
// of M5's native.addChangeListener callback. The handler is otherwise
// identical: re-fetch from native on each hint, store the result.

import { getEmitter, getNative } from "./native";
import { store } from "../store/reactiveStore";
import { parseRemoteConfig } from "../api/remoteConfig";

let subscription: { remove(): void } | null = null;

export function startEventBridge(): void {
  if (subscription) return;
  const native = getNative();
  subscription = getEmitter().addListener("onChange", async (payload: { event: string }) => {
    try {
      switch (payload.event) {
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
        case "REMOTE_CONFIG_CHANGED": {
          const json = await native.remoteConfigAllJson();
          store.set("remoteConfig", parseRemoteConfig(json));
          break;
        }
        default:
          break;
      }
    } catch {
      // Best-effort: a refresh failure here cannot crash the bridge.
    }
  });
}

export function stopEventBridge(): void {
  subscription?.remove();
  subscription = null;
}
