import { z } from "zod";
import { ROVENUE_EVENT_KEYS } from "@rovenue/shared";
import type { RovenueEventKey } from "@rovenue/shared";
import type {
  IntegrationProvider,
  RovenueEventEnvelope,
  ConnectionConfig,
  ProviderCredentials,
  MapEventResult,
  ProviderPayload,
  HttpClient,
  DeliveryResult,
  FanoutTopic,
} from "../types";
import {
  applyEventMapping,
  DEFAULT_EVENT_MAPPING,
  deriveRevenueEventKey,
} from "../event-mapping";

// ---------------------------------------------------------------------------
// deriveEventKey
// ---------------------------------------------------------------------------
//
// SLACK subscribes to all four fanout topics (like CUSTOM_WEBHOOK), not just
// revenue+subscription — so, exactly like custom-webhook.ts, the generic
// rule is: revenue envelopes derive their key from `revenueEventKind`
// (`deriveRevenueEventKey`), everything else (subscription lifecycle,
// paywall, credit) already carries `eventKey` set by
// integrations-fanout/consumer.ts's `toFanoutEnvelope`.
// ---------------------------------------------------------------------------

function deriveEventKey(
  envelope: RovenueEventEnvelope,
): RovenueEventKey | undefined {
  return deriveRevenueEventKey(envelope) ?? envelope.eventKey;
}

const topics: readonly FanoutTopic[] = [
  "rovenue.revenue",
  "rovenue.subscription",
  "rovenue.paywall_events",
  "rovenue.credit",
];

// ---------------------------------------------------------------------------
// Credentials — a single `webhook_url` field (PROVIDER_CREDENTIAL_FIELDS.
// SLACK in step-credentials.tsx). This is a two-phase ALLOWLIST, not the
// SSRF blocklist guard used by CUSTOM_WEBHOOK (custom destination URLs can
// point anywhere on the public internet, so they need a blocklist against
// private/reserved ranges + DNS-rebinding pinning; a Slack incoming webhook
// can only ever be hosted at `hooks.slack.com`, so the correct control is a
// strict host allowlist instead) — verified at connection-setup time
// (credentialsSchema's `.refine`) AND re-verified at delivery time
// (deliver() below), so a credential row that was somehow mutated after
// validation can never reach the network with the wrong host.
// ---------------------------------------------------------------------------

export const SLACK_WEBHOOK_HOST = "hooks.slack.com";

export function isAllowedSlackWebhookUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.host === SLACK_WEBHOOK_HOST;
  } catch {
    return false;
  }
}

const credentialsSchema = z
  .object({
    webhook_url: z.string().min(1),
  })
  .catchall(z.string())
  .refine((c) => isAllowedSlackWebhookUrl(c.webhook_url), {
    message: `webhook_url must be an https:// URL on ${SLACK_WEBHOOK_HOST}`,
    path: ["webhook_url"],
  });

// ---------------------------------------------------------------------------
// Message builder — PURE function, no I/O. Deliberately reads ONLY
// eventKey/amount/currency/productId/subscriberId off the envelope — never
// `identityContext` (email/phone/ip/userAgent) and never
// `subscriberAttributes` (arbitrary host-app-set key/values) or `payload`
// (raw domain passthrough for paywall/credit events). That is what keeps
// "no PII in Slack messages" true by construction rather than by a filter
// that could someday miss a field.
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

export interface SlackMessageInput {
  eventKey: RovenueEventKey;
  amount?: string;
  currency?: string;
  productId?: string;
  subscriberId?: string;
}

export function buildSlackMessageText(input: SlackMessageInput): string {
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

// ---------------------------------------------------------------------------
// validateCredentials — RC-parity for Slack connect: a REAL "Rovenue
// connected" message is posted to the channel so the user gets the same
// confirmation a human setting up a Slack integration would expect. This is
// disclosed via PROVIDER_VALIDATE_NOTES.SLACK (step-credentials.tsx) and in
// the docs page — unlike AMPLITUDE/MIXPANEL's deduplicated probe, Slack
// incoming webhooks have no dedup key at all, so this message is NOT
// deduplicated across repeat "Validate" clicks (also disclosed).
// ---------------------------------------------------------------------------

const SLACK_VALIDATE_MESSAGE_TEXT = "Rovenue connected :white_check_mark:";

// ---------------------------------------------------------------------------
// Delivery response classification, per Slack's incoming-webhooks docs
// (https://api.slack.com/messaging/webhooks, "Handling errors", fetched
// 2026-08-24): success is HTTP 200 with a plain-text body of exactly "ok".
// Errors return more specific 4xx codes than the Web API — `invalid_payload`
// (malformed request; "should not be retried without correction") maps to
// 400, and a webhook that has been revoked/deleted (`no_service` /
// `no_active_hooks`) maps to 404/410. Neither 429 (rate limited) nor 5xx are
// enumerated on that page, but both are the standard retriable shape used
// across every other Wave-1 provider.
// ---------------------------------------------------------------------------

function classifySlackResponse(res: { status: number; body: string }): DeliveryResult {
  const { status } = res;
  const responseBody = res.body;

  if (status === 200 && responseBody.trim() === "ok") {
    return { ok: true, httpStatus: status, responseBody, retriable: false };
  }
  if (status === 404 || status === 410) {
    return {
      ok: false,
      httpStatus: status,
      responseBody,
      errorMessage: `slack http ${status}: no_service`,
      retriable: false,
    };
  }
  if (status === 400) {
    return {
      ok: false,
      httpStatus: status,
      responseBody,
      errorMessage: `slack http ${status}: invalid_payload`,
      retriable: false,
    };
  }
  if (status === 429) {
    return {
      ok: false,
      httpStatus: status,
      responseBody,
      errorMessage: `slack http ${status}`,
      retriable: true,
    };
  }
  if (status >= 500) {
    return {
      ok: false,
      httpStatus: status,
      responseBody,
      errorMessage: `slack http ${status}`,
      retriable: true,
    };
  }
  // Any other status (403 action_prohibited/channel_is_archived/
  // invalid_token, a 2xx without the exact "ok" body, etc.) — fail closed,
  // non-retriable: none of these are Slack-documented as transient.
  return {
    ok: false,
    httpStatus: status,
    responseBody,
    errorMessage: `slack http ${status}`,
    retriable: false,
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const slackProvider: IntegrationProvider = {
  id: "SLACK",

  topics,
  eventCatalog: ROVENUE_EVENT_KEYS,
  // Single connection per project, same as every other Wave-1 first-class
  // provider (AMPLITUDE/MIXPANEL/APPSFLYER/ADJUST) — the dashboard's
  // per-provider card + generic drawer flow (CARD_ID_TO_PROVIDER in
  // apps.tsx) assumes one connection per provider id. CUSTOM_WEBHOOK is the
  // one exception with its own dedicated multi-endpoint UI; a "post to
  // several Slack channels" feature would need that same bespoke surface,
  // which is out of scope here.
  allowMultipleConnections: false,
  credentialsSchema,

  defaultEventMapping: DEFAULT_EVENT_MAPPING.SLACK,

  async validateCredentials(
    creds: ProviderCredentials,
    http: HttpClient,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const webhookUrl = creds["webhook_url"] ?? "";
    if (!isAllowedSlackWebhookUrl(webhookUrl)) {
      return {
        ok: false,
        reason: `webhook_url must be an https:// URL on ${SLACK_WEBHOOK_HOST}`,
      };
    }

    const res = await http.request({
      method: "POST",
      url: webhookUrl,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: SLACK_VALIDATE_MESSAGE_TEXT }),
    });
    const result = classifySlackResponse(res);
    if (result.ok) {
      return { ok: true };
    }
    return { ok: false, reason: result.errorMessage ?? `validate http ${res.status}` };
  },

  mapEvent(
    envelope: RovenueEventEnvelope,
    config: ConnectionConfig,
    _creds: ProviderCredentials,
  ): MapEventResult {
    // NOTE: unlike AMPLITUDE/MIXPANEL/APPSFLYER/ADJUST/META_CAPI, SLACK does
    // NOT require a non-empty outboxEventId here — the Slack message body
    // has no field that carries it (no insert_id/dedup key equivalent; see
    // classifySlackResponse's doc comment and the docs page's duplicate-
    // message note), so there is nothing for it to feed.
    const eventKey = deriveEventKey(envelope);
    if (!eventKey) {
      return { skip: true, reason: "no_mapping" };
    }

    const mappingResult = applyEventMapping({
      providerId: "SLACK",
      eventKey,
      enabledEvents: config.enabledEvents,
      override: config.eventMapping,
    });

    if (mappingResult.kind === "skip") {
      return { skip: true, reason: mappingResult.reason };
    }

    const text = buildSlackMessageText({
      eventKey,
      amount: eventKey.startsWith("revenue.") ? envelope.amount : undefined,
      currency: envelope.currency,
      productId: envelope.productId,
      subscriberId: envelope.subscriberId,
    });

    return {
      eventKey,
      providerEvent: mappingResult.providerEvent,
      body: JSON.stringify({ text }),
    };
  },

  async deliver(
    payload: ProviderPayload,
    creds: ProviderCredentials,
    http: HttpClient,
  ): Promise<DeliveryResult> {
    const webhookUrl = creds["webhook_url"] ?? "";
    // Re-run the SAME allowlist check as credentialsSchema at send time —
    // the two-phase check the brief calls for, so a connection row that
    // somehow ended up with a mutated/invalid webhook_url (bypassing
    // validate-time checks) can never reach the network.
    if (!isAllowedSlackWebhookUrl(webhookUrl)) {
      return {
        ok: false,
        httpStatus: 0,
        responseBody: "",
        errorMessage: `webhook_url failed host allowlist check (must be https://${SLACK_WEBHOOK_HOST}/...)`,
        retriable: false,
      };
    }

    const res = await http.request({
      method: "POST",
      url: webhookUrl,
      headers: { "content-type": "application/json" },
      body: payload.body as string,
    });

    return classifySlackResponse(res);
  },
};
