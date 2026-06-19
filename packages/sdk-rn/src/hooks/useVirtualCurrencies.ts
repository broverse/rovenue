import { useEffect, useSyncExternalStore } from "react";
import { getNative } from "../core/native";
import { store } from "../store/reactiveStore";

const EMPTY: Record<string, number> = {};

function loadIfNeeded(): void {
  if (store.get("virtualCurrencies" as any) === undefined) {
    getNative()
      .virtualCurrencies()
      .then((m) => store.set("virtualCurrencies" as any, m as any))
      .catch(() => {});
  }
}

/** Reactive map of all virtual-currency balances (code → amount). */
export function useVirtualCurrencies(): Record<string, number> {
  useEffect(loadIfNeeded, []);
  return useSyncExternalStore(
    store.subscribe.bind(store),
    () => store.get<Record<string, number>>("virtualCurrencies" as any) ?? EMPTY,
    () => EMPTY,
  );
}

/** Reactive single-currency balance; 0 when absent. */
export function useVirtualCurrency(code: string): number {
  const all = useVirtualCurrencies();
  return all[code] ?? 0;
}
