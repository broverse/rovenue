import { useEffect, useSyncExternalStore } from "react";
import { getNative } from "../core/native";
import { store } from "../store/reactiveStore";
import type { Entitlement } from "../types";

// Module-level constant so React's useSyncExternalStore does not see a
// fresh array reference on every render when the store is empty.
const EMPTY: Entitlement[] = [];

export function useEntitlements(): Entitlement[] {
  useEffect(() => {
    if (store.get("entitlementsAll") === undefined) {
      getNative().entitlementsAll().then((all) => {
        store.set("entitlementsAll", all);
        for (const ent of all) store.set(`entitlement:${ent.id}`, ent);
      }).catch(() => {});
    }
  }, []);
  return useSyncExternalStore(
    store.subscribe.bind(store),
    () => (store.get<Entitlement[]>("entitlementsAll") ?? EMPTY),
    () => EMPTY,
  );
}
