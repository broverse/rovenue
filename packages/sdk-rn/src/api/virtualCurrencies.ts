import { getNative } from "../core/native";
import { mapNativeError } from "../errors";

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e: any) {
    if (e?.code) throw mapNativeError(e.code, e.message ?? "native error", e.extras);
    throw e;
  }
}

/** All virtual-currency balances (code → amount). */
export async function virtualCurrencies(): Promise<Record<string, number>> {
  return call(() => getNative().virtualCurrencies());
}

/** One currency's balance; 0 when the code is absent. */
export async function virtualCurrency(code: string): Promise<number> {
  return call(() => getNative().virtualCurrency(code));
}

/** Force a refresh of virtual-currency balances from the server. */
export async function refreshVirtualCurrencies(): Promise<void> {
  return call(() => getNative().refreshVirtualCurrencies());
}
