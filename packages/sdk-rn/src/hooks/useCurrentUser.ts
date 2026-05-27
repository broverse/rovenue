import { useEffect, useSyncExternalStore } from "react";
import { getNative } from "../core/native";
import { store } from "../store/reactiveStore";
import type { User } from "../types";

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
