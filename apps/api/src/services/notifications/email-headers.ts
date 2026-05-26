// =============================================================
// List-Unsubscribe header builder
// =============================================================
//
// Returns the RFC 8058 one-click headers for a non-forced event,
// or an empty record for forced channels (which deliberately do
// not advertise an unsubscribe — transactional invoices, security
// alerts, etc).
//
// The signed URL is `${dashboardUrl}/unsubscribe?token=<...>` where
// the token is a 30-day-expiring HMAC of { userId, scope, projectId }.
// Inbox providers honour `mailto:` as the secondary value; we point
// that at a static mailbox the ops team monitors.

import { getEvent } from "@rovenue/shared/notifications";
import { signUnsubscribeToken } from "../../lib/unsubscribe-token";

export interface BuildEmailHeadersInput {
  eventKey: string;
  userId: string;
  projectId?: string;
  /** Dashboard origin without trailing slash, e.g. https://app.rovenue.io */
  dashboardUrl: string;
  /** 32-byte hex HMAC key (UNSUB_SIGNING_KEY) */
  signingKey: string;
  /** Address used in the `mailto:` half of the List-Unsubscribe header */
  mailtoUnsub: string;
  /** Token lifetime in seconds (default: 30 days) */
  ttlSeconds?: number;
  /** Injected so tests can pin the clock */
  nowMs?: number;
}

const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60;

export function buildEmailHeaders(
  input: BuildEmailHeadersInput,
): Record<string, string> {
  const event = getEvent(input.eventKey);

  // Forced channels: no List-Unsubscribe (RFC 8058 N/A for required mail).
  if (event.forcedChannels.includes("email")) {
    return {};
  }

  const now = input.nowMs ?? Date.now();
  const ttl = input.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  const token = signUnsubscribeToken(
    {
      userId: input.userId,
      scope: "channel:email",
      projectId: input.projectId,
      exp: Math.floor(now / 1000) + ttl,
    },
    input.signingKey,
  );

  const unsubUrl = `${input.dashboardUrl.replace(/\/+$/, "")}/unsubscribe?token=${token}`;
  return {
    "List-Unsubscribe": `<${unsubUrl}>, <mailto:${input.mailtoUnsub}>`,
    "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
  };
}
