import { getNative } from "../core/native";
import { mapNativeError } from "../errors";
import type { User } from "../types";

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try { return await fn(); }
  catch (e: any) {
    if (e?.code) throw mapNativeError(e.code, e.message ?? "native error", e.extras);
    throw e;
  }
}

export async function currentUser(): Promise<User> {
  return call(() => getNative().currentUser());
}

export async function identify(knownUserId: string): Promise<void> {
  return call(() => getNative().identify(knownUserId));
}
