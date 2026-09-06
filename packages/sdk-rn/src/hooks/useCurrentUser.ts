import { useEffect, useSyncExternalStore } from "react";
import { getNative } from "../core/native";
import { store } from "../store/reactiveStore";
import type { User } from "../types";

/**
 * Reactive current-user identity. Returns `null` until the first native
 * `currentUser()` read completes (lazily primed on mount), then re-renders
 * on every `IDENTITY_CHANGED` native event (e.g. after `identify()` or
 * `logOut()`). Reads are synchronous off the local store after that first
 * fetch — no network call on every render.
 */
export function useCurrentUser(): User | null {
  useEffect(() => {
    if (store.get("user") === undefined) {
      getNative().currentUser().then((u) => store.set("user", u)).catch(() => {});
    }
  }, []);
  return useSyncExternalStore(
    store.subscribe.bind(store),
    () => (store.get<User>("user") ?? null),
    () => null,
  );
}
