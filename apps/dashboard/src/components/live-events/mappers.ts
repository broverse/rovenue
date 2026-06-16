import type { LiveEventMessage } from "@rovenue/shared";
import { metaFor } from "./event-types";
import type { EventPlatform, EventTypeKey, LiveEvent } from "./types";

// =============================================================
// Wire → UI adapter
// =============================================================
//
// The live-events SSE channel carries the raw outbox row shape
// (`LiveEventMessage`): eventId / eventType / aggregateType / payload /
// occurredAt. This module normalises each message into the render-ready
// `LiveEvent` the stream and detail panel consume. Anything the wire
// doesn't carry stays `null` — we never fabricate a value.

const REVENUE_TYPE: Record<string, EventTypeKey> = {
  INITIAL: "new_subscription",
  RENEWAL: "renewal",
  TRIAL_CONVERSION: "trial_converted",
  REACTIVATION: "reactivation",
  CANCELLATION: "cancellation",
  REFUND: "refund",
  CREDIT_PURCHASE: "credit_purchase",
};

const CREDIT_TYPE: Record<string, EventTypeKey> = {
  PURCHASE: "credit_purchased",
  SPEND: "credit_spent",
  REFUND: "credit_refunded",
  BONUS: "credit_bonus",
  EXPIRE: "credit_expired",
  TRANSFER_IN: "credit_transfer_in",
  TRANSFER_OUT: "credit_transfer_out",
};

const BILLING_TYPE: Record<string, EventTypeKey> = {
  "billing.invoice.paid": "invoice_paid",
  "billing.payment_method.added": "payment_method_added",
  "billing.subscription.activated": "plan_activated",
};

const str = (p: Record<string, unknown>, key: string): string | null => {
  const v = p[key];
  return typeof v === "string" && v.length > 0 ? v : null;
};

const num = (p: Record<string, unknown>, key: string): number | null => {
  const v = p[key];
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

const normPlatform = (v: string | null): EventPlatform | null => {
  const s = v?.toLowerCase();
  if (s === "ios" || s === "app_store") return "ios";
  if (s === "android" || s === "play_store") return "android";
  return null;
};

export function messageToLiveEvent(
  msg: LiveEventMessage,
  opts: { isNew?: boolean } = {},
): LiveEvent {
  const p: Record<string, unknown> =
    msg.payload && typeof msg.payload === "object" ? msg.payload : {};

  let type: EventTypeKey = "unknown";
  let amount: number | null = null;
  let currency: string | null = null;
  let user: string | null = null;
  let product: string | null = null;
  let platform: EventPlatform | null = null;
  let country: string | null = null;
  let store: string | null = null;

  switch (msg.aggregateType) {
    case "REVENUE_EVENT": {
      type = REVENUE_TYPE[str(p, "type") ?? ""] ?? "unknown";
      store = str(p, "store");
      platform = normPlatform(store);
      currency = str(p, "currency");
      user = str(p, "subscriberId");
      product = str(p, "productId");
      const raw = num(p, "amountUsd") ?? num(p, "amount");
      amount = raw == null ? null : type === "refund" ? -Math.abs(raw) : raw;
      break;
    }
    case "CREDIT_LEDGER": {
      type = CREDIT_TYPE[str(p, "type") ?? ""] ?? "unknown";
      user = str(p, "subscriberId");
      // Credit deltas aren't money — leave the money column empty. The
      // signed delta + running balance are visible in the payload/overview.
      break;
    }
    case "EXPOSURE": {
      type = "experiment_exposure";
      user = str(p, "subscriberId");
      platform = normPlatform(str(p, "platform"));
      country = str(p, "country");
      break;
    }
    case "BILLING": {
      type = BILLING_TYPE[msg.eventType] ?? "unknown";
      const paid = num(p, "amountPaid");
      if (paid != null) {
        amount = paid;
        currency = "USD";
      }
      break;
    }
    default:
      type = "unknown";
  }

  return {
    id: msg.eventId,
    type,
    typeMeta: metaFor(type),
    eventType: msg.eventType,
    aggregateType: msg.aggregateType,
    user,
    product,
    amount,
    currency,
    platform,
    country,
    store,
    receivedAt: new Date(msg.occurredAt),
    payload: p,
    isNew: opts.isNew,
  };
}
