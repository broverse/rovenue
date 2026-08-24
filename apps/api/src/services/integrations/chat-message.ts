import type { RovenueEventKey } from "@rovenue/shared";

// ---------------------------------------------------------------------------
// Chat message builder — PURE function, no I/O. Shared by every chat-webhook
// provider (SLACK today, DISCORD in Wave-2 Task 9) so the "what does a
// Rovenue event look like as a chat message" rule lives in exactly one
// place. Deliberately reads ONLY eventKey/amount/currency/productId/
// subscriberId off the caller-supplied input — never `identityContext`
// (email/phone/ip/userAgent) and never `subscriberAttributes` (arbitrary
// host-app-set key/values) or `payload` (raw domain passthrough for
// paywall/credit events). That is what keeps "no PII in chat messages" true
// by construction rather than by a filter that could someday miss a field:
// callers (slack.ts, discord.ts) must narrow the envelope down to this
// input shape themselves before calling in.
// ---------------------------------------------------------------------------

type EventFamily = "revenue" | "subscription" | "paywall" | "credit";

const FAMILY_EMOJI: Record<EventFamily, string> = {
  revenue: ":moneybag:",
  subscription: ":repeat:",
  paywall: ":eyes:",
  credit: ":coin:",
};

function eventFamily(eventKey: RovenueEventKey): EventFamily {
  if (eventKey.startsWith("revenue.")) return "revenue";
  if (eventKey.startsWith("paywall.")) return "paywall";
  if (eventKey.startsWith("credit.")) return "credit";
  // subscription.* lifecycle keys, plus subscriber.identified (identity is
  // conceptually part of the subscription-lifecycle story here).
  return "subscription";
}

/** First 4 characters + an ellipsis — enough to recognize "the same
 *  subscriber posted again" across messages in a channel without printing
 *  an identifier a reader could act on. */
const MASKED_ID_PREFIX_LENGTH = 4;

export function maskSubscriberId(subscriberId: string): string {
  return `${subscriberId.slice(0, MASKED_ID_PREFIX_LENGTH)}…`;
}

export interface ChatMessageInput {
  eventKey: RovenueEventKey;
  amount?: string;
  currency?: string;
  productId?: string;
  subscriberId?: string;
}

export function buildChatMessageText(input: ChatMessageInput): string {
  const family = eventFamily(input.eventKey);
  const emoji = FAMILY_EMOJI[family];

  const segments: string[] = [];
  if (family === "revenue" && input.amount !== undefined) {
    segments.push(`${emoji} ${input.eventKey} — ${input.amount} ${input.currency ?? ""}`.trim());
  } else {
    segments.push(`${emoji} ${input.eventKey}`);
  }
  if (input.productId) {
    segments.push(input.productId);
  }
  if (input.subscriberId) {
    segments.push(`subscriber ${maskSubscriberId(input.subscriberId)}`);
  }
  return segments.join(" · ");
}
