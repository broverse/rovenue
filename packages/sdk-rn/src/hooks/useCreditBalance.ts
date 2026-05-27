import { useEffect, useSyncExternalStore } from "react";
import { getNative } from "../core/native";
import { store } from "../store/reactiveStore";

export function useCreditBalance(): number {
  useEffect(() => {
    if (store.get("creditBalance") === undefined) {
      getNative().creditBalance().then((b) => store.set("creditBalance", b)).catch(() => {});
    }
  }, []);
  return useSyncExternalStore(
    store.subscribe.bind(store),
    () => (store.get<number>("creditBalance") ?? 0),
    () => 0,
  );
}
