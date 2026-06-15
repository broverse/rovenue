import { getNative } from "../core/native";
import { mapNativeError } from "../errors";

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    if (e?.code) throw mapNativeError(e.code, e.message ?? "native error", e.extras);
    throw e;
  }
}

export async function setAttributes(attributes: Record<string, string | null>): Promise<void> {
  return call(() => getNative().setAttributes(attributes));
}
export async function setEmail(email: string | null): Promise<void> {
  return call(() => getNative().setEmail(email));
}
export async function setDisplayName(name: string | null): Promise<void> {
  return call(() => getNative().setDisplayName(name));
}
export async function setPhoneNumber(phone: string | null): Promise<void> {
  return call(() => getNative().setPhoneNumber(phone));
}
export async function setPushToken(token: string | null): Promise<void> {
  return call(() => getNative().setPushToken(token));
}
export async function flushAttributes(): Promise<number> {
  return call(() => getNative().flushAttributes());
}
