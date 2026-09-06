import { useEffect, useSyncExternalStore } from "react";
import { getNative } from "../core/native";
import { store } from "../store/reactiveStore";
import type { Entitlement } from "../types";

/**
 * Reactive read of one entitlement by id. Returns `null` until the first
 * native `entitlement(id)` read completes (lazily primed on mount and on
 * `id` change), then re-renders on `ENTITLEMENTS_CHANGED`. Also `null`
 * when the entitlement is unknown or not granted — there is no separate
 * "loading" state; a caller that must distinguish "not yet loaded" from
 * "not entitled" should track that itself.
 */
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
