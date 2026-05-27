import { getNative } from "../core/native";
import { mapNativeError } from "../errors";
import type { Entitlement } from "../types";

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e: any) {
    if (e?.code) throw mapNativeError(e.code, e.message ?? "native error", e.extras);
    throw e;
  }
}

export async function entitlement(id: string): Promise<Entitlement | null> {
  return call(() => getNative().entitlement(id));
}

export async function entitlementsAll(): Promise<Entitlement[]> {
  return call(() => getNative().entitlementsAll());
}

export async function refreshEntitlements(): Promise<void> {
  return call(() => getNative().refreshEntitlements());
}
