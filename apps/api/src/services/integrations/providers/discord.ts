import { z } from "zod";
import { ROVENUE_EVENT_KEYS, REVENUE_EVENT_KEY_PREFIX } from "@rovenue/shared";
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
import { buildChatMessageText } from "../chat-message";

// ---------------------------------------------------------------------------
// deriveEventKey — identical rule to SLACK (both subscribe to all four
// fanout topics, unlike the single-topic Wave-1/Wave-2 analytics/attribution
// providers): a revenue envelope derives its key from `revenueEventKind`
// (`deriveRevenueEventKey`); everything else (subscription lifecycle,
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
// DISCORD in step-credentials.tsx), same shape as SLACK. This is a
// two-phase ALLOWLIST (schema `.refine` at connection-setup time AND
// re-verified at delivery time below) rather than the SSRF blocklist
// CUSTOM_WEBHOOK uses for arbitrary user-supplied destinations — a Discord
// incoming webhook can only ever live under `discord.com` or the legacy
// `discordapp.com` host, at a path starting `/api/webhooks/`, per
// https://discord.com/developers/docs/resources/webhook (fetched
// 2026-08-25).
// ---------------------------------------------------------------------------

export const DISCORD_WEBHOOK_HOST = "discord.com";
export const DISCORD_WEBHOOK_HOST_LEGACY = "discordapp.com";
export const DISCORD_WEBHOOK_PATH_PREFIX = "/api/webhooks/";

export function isAllowedDiscordWebhookUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      (url.host === DISCORD_WEBHOOK_HOST || url.host === DISCORD_WEBHOOK_HOST_LEGACY) &&
      url.pathname.startsWith(DISCORD_WEBHOOK_PATH_PREFIX)
    );
  } catch {
    return false;
  }
}

const credentialsSchema = z
  .object({
    webhook_url: z.string().min(1),
  })
  .catchall(z.string())
  .refine((c) => isAllowedDiscordWebhookUrl(c.webhook_url), {
    message: `webhook_url must be an https:// URL on ${DISCORD_WEBHOOK_HOST} or ${DISCORD_WEBHOOK_HOST_LEGACY} with a path starting "${DISCORD_WEBHOOK_PATH_PREFIX}"`,
    path: ["webhook_url"],
  });

// ---------------------------------------------------------------------------
// Message builder — reuses ../chat-message.ts's buildChatMessageText, the
// SAME pure function SLACK uses (Task 3 hoisted it precisely so DISCORD adds
// zero new builder code). Discord's Execute Webhook body has no Block
// Kit/attachment-equivalent required here — the built text is wrapped as
// `{ content: text }` per
// https://discord.com/developers/docs/resources/webhook#execute-webhook
// (fetched 2026-08-25): `content` is "the message contents (up to 2000
// characters)". buildChatMessageText's per-family output is well under that
// limit.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// validateCredentials — Slack-parity: a REAL "Rovenue connected ✅" message
// is posted to the configured channel, disclosed via
// PROVIDER_VALIDATE_NOTES.DISCORD (step-credentials.tsx) and the docs page.
// Discord incoming webhooks have no dedup-key concept either, so — exactly
// like SLACK — this is NOT deduplicated across repeat "Validate" clicks.
// ---------------------------------------------------------------------------

const DISCORD_VALIDATE_MESSAGE_TEXT = "Rovenue connected ✅";

// ---------------------------------------------------------------------------
// Delivery response classification, per Discord's Execute Webhook docs
// (https://discord.com/developers/docs/resources/webhook#execute-webhook,
// fetched 2026-08-25): the endpoint's `wait` query param defaults to
// `false` and Rovenue never sets it, so a successful send returns
// `204 No Content` (no response body to parse); `200` is also treated as
// success in case a future revision (or the `wait=true` shape) is ever
// used. `404` means the webhook (id/token pair) no longer exists — deleted
// or the channel/guild removed — and `401`/`403` mean an invalid/revoked
// token; none of these three are transient, so a corrected credential is
// required before retrying makes sense. `400` is a malformed request body
// (a Rovenue bug, not a user-fixable config problem) — also non-retriable.
// `429` is Discord's per-route/global rate limit; the JSON body carries a
// `retry_after` (seconds, float) per
// https://discord.com/developers/docs/topics/rate-limits (fetched
// 2026-08-25) — Rovenue does not read it, since our own BullMQ backoff
// policy (retry-policies.ts) already owns the retry delay for every
// provider uniformly. `5xx` is Discord-side and retriable, matching every
// other Wave-1/Wave-2 provider's convention.
// ---------------------------------------------------------------------------

function classifyDiscordResponse(res: { status: number; body: string }): DeliveryResult {
  const { status, body: responseBody } = res;

  if (status === 204 || status === 200) {
    return { ok: true, httpStatus: status, responseBody, retriable: false };
  }
  if (status === 404) {
    return {
      ok: false,
      httpStatus: status,
      responseBody,
      errorMessage: `discord http ${status}: unknown webhook`,
      retriable: false,
    };
  }
  // 401/403 are NOT the same failure as 404: the webhook still exists, but
  // its token is wrong or has been revoked/rotated (regenerating a Discord
  // webhook's URL invalidates the old token while keeping the webhook id).
  // Reusing 404's "unknown webhook" text here sent an operator looking for a
  // deleted webhook that is in fact still there — the docs page already
  // distinguishes the two cases, so the Delivery Log now does too.
  if (status === 401 || status === 403) {
    return {
      ok: false,
      httpStatus: status,
      responseBody,
      errorMessage: `discord http ${status}: invalid or revoked webhook token`,
      retriable: false,
    };
  }
  if (status === 400) {
    return {
      ok: false,
      httpStatus: status,
      responseBody,
      errorMessage: `discord http ${status}: invalid request`,
      retriable: false,
    };
  }
  if (status === 429) {
    return {
      ok: false,
      httpStatus: status,
      responseBody,
      errorMessage: `discord http ${status}: rate limited`,
      retriable: true,
    };
  }
  if (status >= 500) {
    return {
      ok: false,
      httpStatus: status,
      responseBody,
      errorMessage: `discord http ${status}`,
      retriable: true,
    };
  }
  // Any other status — fail closed, non-retriable: none of these are
  // Discord-documented as transient.
  return {
    ok: false,
    httpStatus: status,
    responseBody,
    errorMessage: `discord http ${status}`,
    retriable: false,
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const discordProvider: IntegrationProvider = {
  id: "DISCORD",

  topics,
  eventCatalog: ROVENUE_EVENT_KEYS,
  // Single connection per project, same as SLACK and every other Wave-1/
  // Wave-2 first-class provider — the dashboard's per-provider card +
  // generic drawer flow (CARD_ID_TO_PROVIDER in apps.tsx) assumes one
  // connection per provider id.
  allowMultipleConnections: false,
  credentialsSchema,

  defaultEventMapping: DEFAULT_EVENT_MAPPING.DISCORD,

  async validateCredentials(
    creds: ProviderCredentials,
    http: HttpClient,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const webhookUrl = creds["webhook_url"] ?? "";
    if (!isAllowedDiscordWebhookUrl(webhookUrl)) {
      return {
        ok: false,
        reason: `webhook_url must be an https:// URL on ${DISCORD_WEBHOOK_HOST} or ${DISCORD_WEBHOOK_HOST_LEGACY} with a path starting "${DISCORD_WEBHOOK_PATH_PREFIX}"`,
      };
    }

    const res = await http.request({
      method: "POST",
      url: webhookUrl,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: DISCORD_VALIDATE_MESSAGE_TEXT }),
    });
    const result = classifyDiscordResponse(res);
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
    // NOTE: like SLACK, DISCORD does NOT require a non-empty outboxEventId
    // here — the message body has no dedup-key equivalent field for it to
    // feed (see classifyDiscordResponse's doc comment and the docs page's
    // at-least-once duplicate-message note).
    const eventKey = deriveEventKey(envelope);
    if (!eventKey) {
      return { skip: true, reason: "no_mapping" };
    }

    const mappingResult = applyEventMapping({
      providerId: "DISCORD",
      eventKey,
      enabledEvents: config.enabledEvents,
      override: config.eventMapping,
    });

    if (mappingResult.kind === "skip") {
      return { skip: true, reason: mappingResult.reason };
    }

    const text = buildChatMessageText({
      eventKey,
      amount: eventKey.startsWith(REVENUE_EVENT_KEY_PREFIX) ? envelope.amount : undefined,
      currency: envelope.currency,
      productId: envelope.productId,
      subscriberId: envelope.subscriberId,
    });

    return {
      eventKey,
      providerEvent: mappingResult.providerEvent,
      body: JSON.stringify({ content: text }),
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
    if (!isAllowedDiscordWebhookUrl(webhookUrl)) {
      return {
        ok: false,
        httpStatus: 0,
        responseBody: "",
        errorMessage: `webhook_url failed host allowlist check (must be https://${DISCORD_WEBHOOK_HOST}${DISCORD_WEBHOOK_PATH_PREFIX}... or https://${DISCORD_WEBHOOK_HOST_LEGACY}${DISCORD_WEBHOOK_PATH_PREFIX}...)`,
        retriable: false,
      };
    }

    const res = await http.request({
      method: "POST",
      url: webhookUrl,
      headers: { "content-type": "application/json" },
      body: payload.body as string,
    });

    return classifyDiscordResponse(res);
  },
};
