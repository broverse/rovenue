import { getNative } from "../core/native";
import { mapNativeError } from "../errors";
import {
  type EventEnvelope,
  type IdentityContext,
  serializeEnvelope,
} from "../events";

/** Optional fields for {@link track}. `eventType` is the first positional arg. */
export interface TrackParams {
  /** ISO-8601 override; defaults to the call-time timestamp. */
  occurredAt?: string;
  /** Defaults to the current scope (app user id, else anonymous id). */
  subscriberId?: string;
  productId?: string;
  /** Decimal string, e.g. "9.99". */
  amount?: string;
  /** ISO-4217 three-letter code, e.g. "USD". */
  currency?: string;
  eventSourceUrl?: string;
  identityContext?: IdentityContext;
}

function isoNow(): string {
  return new Date().toISOString();
}

async function call<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e: any) {
    if (e?.code) throw mapNativeError(e.code, e.message ?? "native error", e.extras);
    throw e;
  }
}

/**
 * Emit a generic event to the backend (`POST /v1/events`). The SDK's HTTP
 * layer retries transient failures; the returned promise rejects if the POST
 * ultimately fails. `occurredAt` defaults to now; `subscriberId` is filled
 * from the current scope when omitted, and the native core stamps the wire
 * version and a stable `eventId`.
 */
export async function track(eventType: string, params: TrackParams = {}): Promise<void> {
  const envelope: EventEnvelope = {
    eventType,
    occurredAt: params.occurredAt ?? isoNow(),
    subscriberId: params.subscriberId,
    productId: params.productId,
    amount: params.amount,
    currency: params.currency,
    eventSourceUrl: params.eventSourceUrl,
    identityContext: params.identityContext,
  };
  return call(() => getNative().track(serializeEnvelope(envelope)));
}
