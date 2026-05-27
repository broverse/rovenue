import { useEffect, useSyncExternalStore } from "react";
import { getNative } from "../core/native";
import { store } from "../store/reactiveStore";
import type { Entitlement } from "../types";

export function useEntitlement(id: string): Entitlement | null {
  useEffect(() => {
    if (store.get(`entitlement:${id}`) === undefined) {
      getNative().entitlement(id).then((e) => store.set(`entitlement:${id}`, e)).catch(() => {});
    }
  }, [id]);
  return useSyncExternalStore(
    store.subscribe.bind(store),
    () => (store.get<Entitlement | null>(`entitlement:${id}`) ?? null),
    () => null,
  );
}
