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

/**
 * Queue a batch of subscriber-attribute mutations. Written to the local
 * buffer immediately (this promise resolves once that local write
 * completes); the server sync happens in the background (30s tick, on
 * foreground, or via {@link flushAttributes}). A `null` value deletes the
 * key. Reserved keys (prefixed with `$`, e.g. `$email`) map to first-class
 * fields server-side — {@link setEmail}/{@link setDisplayName}/
 * {@link setPhoneNumber}/{@link setPushToken} are thin wrappers over this
 * for the common ones.
 */
export async function setAttributes(attributes: Record<string, string | null>): Promise<void> {
  return call(() => getNative().setAttributes(attributes));
}
/** Subscriber's email → the `$email` reserved attribute. Same buffered-write,
 *  background-flush contract as {@link setAttributes}; `null` clears it. */
export async function setEmail(email: string | null): Promise<void> {
  return call(() => getNative().setEmail(email));
}
/** Subscriber's display name → the `$displayName` reserved attribute. Same
 *  buffered-write, background-flush contract as {@link setAttributes};
 *  `null` clears it. */
export async function setDisplayName(name: string | null): Promise<void> {
  return call(() => getNative().setDisplayName(name));
}
/** Subscriber's phone number → the `$phoneNumber` reserved attribute. Same
 *  buffered-write, background-flush contract as {@link setAttributes};
 *  `null` clears it. */
export async function setPhoneNumber(phone: string | null): Promise<void> {
  return call(() => getNative().setPhoneNumber(phone));
}
/** Device push token → the platform's reserved attribute (`$apnsTokens` on
 *  iOS, `$fcmTokens` on Android — the native layer picks the right key).
 *  Same buffered-write, background-flush contract as {@link setAttributes};
 *  `null` clears it. */
export async function setPushToken(token: string | null): Promise<void> {
  return call(() => getNative().setPushToken(token));
}
/**
 * Force an immediate flush of buffered attribute mutations to the server,
 * bypassing the 30s background tick. Returns the number of mutations
 * actually sent. Most apps never need this — the background dispatcher
 * already flushes on its own tick and on foreground.
 */
export async function flushAttributes(): Promise<number> {
  return call(() => getNative().flushAttributes());
}
