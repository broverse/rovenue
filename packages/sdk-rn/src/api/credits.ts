import { getNative } from "../core/native";
import { mapNativeError } from "../errors";

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e: any) {
    if (e?.code) throw mapNativeError(e.code, e.message ?? "native error", e.extras);
    throw e;
  }
}

export async function creditBalance(): Promise<number> {
  return call(() => getNative().creditBalance());
}

export async function refreshCredits(): Promise<void> {
  return call(() => getNative().refreshCredits());
}

export async function consumeCredits(amount: number, description?: string): Promise<number> {
  return call(() => getNative().consumeCredits(amount, description ?? null));
}
