import { z } from "zod";
import { ROVENUE_EVENT_KEYS, WEBHOOK_API_VERSION } from "@rovenue/shared";
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
import { deriveRevenueEventKey } from "../event-mapping";
import { WEBHOOK_RETRY_POLICY } from "../retry-policies";
import { signWebhook } from "../../../lib/svix-sign";
import {
  WebhookUrlError,
  assertPublicWebhookUrl,
  resolvePinnedAddress,
  createPinnedHttpClient,
} from "../../../lib/ssrf-guard";
import { RESPONSE_BODY_MAX_BYTES } from "../http-client";

// Re-exported so callers (dispatcher, tests) can reach the delivery deadline
// from this module without reaching into lib/ssrf-guard directly.
export { WEBHOOK_DELIVERY_TIMEOUT_MS } from "../../../lib/ssrf-guard";

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/** One entry in the "secrets" JSON array stored under ProviderCredentials.
 *  Multiple entries support key rotation: signWebhook signs with every
 *  active key so a receiver mid-rotation can still verify. */
export interface WebhookSecretEntry {
  id: string;
  key: string;
  createdAt: string;
  /** ISO timestamp after which this key stops signing and becomes eligible
   *  for pruning. Stamped only when the key is ROTATED OUT (see the
   *  rotate-secret route), so the grace window is measured from the
   *  rotation rather than from when the key happened to be created — a
   *  long-lived key that is finally rotated still gets the full window.
   *  Absent on the current key and on entries written before this field
   *  existed; those are treated as active indefinitely. */
  expiresAt?: string;
}

/** The keys that may still sign an outgoing delivery: everything without an
 *  expiry, plus anything whose rotation-stamped expiry is still in the
 *  future. An entry with an unparseable expiresAt is treated as expired —
 *  fail closed rather than sign with a key we can't reason about. */
export function activeWebhookSecrets(
  secrets: WebhookSecretEntry[],
  nowMs: number = Date.now(),
): WebhookSecretEntry[] {
  return secrets.filter((s) => {
    if (!s.expiresAt) return true;
    const expiresMs = new Date(s.expiresAt).getTime();
    return Number.isFinite(expiresMs) && expiresMs > nowMs;
  });
}

/** activeWebhookSecrets, projected to the raw keys signWebhook takes. */
export function activeWebhookSecretKeys(
  secrets: WebhookSecretEntry[],
  nowMs: number = Date.now(),
): string[] {
  return activeWebhookSecrets(secrets, nowMs).map((s) => s.key);
}

/** THE current signing key: the newest entry that has not been rotated out.
 *  This is the one a rotation supersedes, the one the reveal route returns,
 *  and the one the credentials hint fingerprints. */
export function newestSecretEntry(
  secrets: WebhookSecretEntry[],
): WebhookSecretEntry | undefined {
  return [...secrets]
    .filter((s) => !s.expiresAt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
}

// ProviderCredentials is Record<string, string> — the secrets array is
// carried as a JSON-encoded string under the "secrets" key so it fits that
// flat, encrypted-at-rest shape.
const credentialsSchema = z
  .object({
    url: z.string().min(1),
    secrets: z.string().min(1),
  })
  .catchall(z.string());

/** Parses the stored (decrypted) credentials into { url, secrets }.
 *  Malformed "secrets" JSON degrades to an empty array rather than
 *  throwing — validateCredentials / deliver then fail on "no secrets"
 *  through their normal, reportable path instead of crashing. */
export function parseWebhookCredentials(
  creds: ProviderCredentials,
): { url: string; secrets: WebhookSecretEntry[] } {
  const url = creds["url"] ?? "";
  let secrets: WebhookSecretEntry[] = [];
  try {
    const parsed: unknown = JSON.parse(creds["secrets"] ?? "[]");
    if (Array.isArray(parsed)) {
      secrets = parsed as WebhookSecretEntry[];
    }
  } catch {
    secrets = [];
  }
  return { url, secrets };
}

// ---------------------------------------------------------------------------
// mapEvent
// ---------------------------------------------------------------------------

function deriveEventKey(
  envelope: RovenueEventEnvelope,
): RovenueEventKey | undefined {
  return deriveRevenueEventKey(envelope) ?? envelope.eventKey;
}

/** envelope minus identityContext PII: revenue events keep only the
 *  correlation-safe externalId, dropping email/phone/ip/userAgent/etc;
 *  non-revenue events pass their domain payload through unchanged. */
function buildWebhookData(envelope: RovenueEventEnvelope): Record<string, unknown> {
  if (envelope.eventType === "revenue.event.recorded" && envelope.revenueEventKind) {
    return {
      kind: envelope.revenueEventKind,
      amount: envelope.amount,
      currency: envelope.currency,
      subscriberId: envelope.subscriberId,
      productId: envelope.productId,
      externalId: envelope.identityContext?.externalId,
    };
  }
  return envelope.payload ?? {};
}

// ---------------------------------------------------------------------------
// Delivery response classification
// ---------------------------------------------------------------------------

/** 4xx statuses a receiver uses to ask for a retry (rate limiting / a
 *  transient "try again shortly"), as opposed to a permanent rejection. */
const RETRIABLE_4XX_STATUSES = new Set([408, 425, 429]);

/** A delivery that never reached the network — a bad URL, no secrets to
 *  sign with, or an unparseable payload. Always non-retriable: retrying an
 *  unsigned/un-identifiable send would just repeat the same local failure. */
function nonRetriableFailure(reason: string): DeliveryResult {
  return {
    ok: false,
    httpStatus: 0,
    responseBody: "",
    errorMessage: reason,
    retriable: false,
  };
}

function classifyDeliveryResponse(res: { status: number; body: string }): DeliveryResult {
  const responseBody = res.body.slice(0, RESPONSE_BODY_MAX_BYTES);
  const { status } = res;

  if (status >= 200 && status < 300) {
    return { ok: true, httpStatus: status, responseBody, retriable: false };
  }
  if (status >= 300 && status < 400) {
    return {
      ok: false,
      httpStatus: status,
      responseBody,
      errorMessage: "redirects are not followed",
      retriable: false,
    };
  }
  if (RETRIABLE_4XX_STATUSES.has(status)) {
    return {
      ok: false,
      httpStatus: status,
      responseBody,
      errorMessage: `webhook delivery http ${status}`,
      retriable: true,
    };
  }
  if (status >= 400 && status < 500) {
    return {
      ok: false,
      httpStatus: status,
      responseBody,
      errorMessage: `webhook delivery http ${status}`,
      retriable: false,
    };
  }
  // 5xx (and any other unexpected status) → retriable.
  return {
    ok: false,
    httpStatus: status,
    responseBody,
    errorMessage: `webhook delivery http ${status}`,
    retriable: true,
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

const topics: readonly FanoutTopic[] = [
  "rovenue.revenue",
  "rovenue.subscription",
  "rovenue.paywall_events",
  "rovenue.credit",
];

export const customWebhookProvider: IntegrationProvider = {
  id: "CUSTOM_WEBHOOK",

  topics,
  eventCatalog: ROVENUE_EVENT_KEYS,
  allowMultipleConnections: true,
  credentialsSchema,
  retryPolicy: WEBHOOK_RETRY_POLICY,

  // No default mappings — the user configures event scope entirely via
  // config.enabledEvents; providerEvent always equals the derived eventKey.
  defaultEventMapping: {},

  async validateCredentials(
    creds: ProviderCredentials,
    _http: HttpClient,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const { url, secrets } = parseWebhookCredentials(creds);
    try {
      assertPublicWebhookUrl(url);
    } catch (err) {
      if (err instanceof WebhookUrlError) {
        return { ok: false, reason: err.reason };
      }
      throw err;
    }
    if (activeWebhookSecrets(secrets).length === 0) {
      return { ok: false, reason: "at least one webhook secret is required" };
    }
    return { ok: true };
  },

  buildCredentialsHint(creds: ProviderCredentials): string {
    const { url, secrets } = parseWebhookCredentials(creds);
    const host = (() => {
      try {
        return new URL(url).host;
      } catch {
        return url;
      }
    })();
    const newest = newestSecretEntry(secrets);
    if (!newest) return host;
    return `${host} · …${newest.key.slice(-4)}`;
  },

  mapEvent(
    envelope: RovenueEventEnvelope,
    config: ConnectionConfig,
    _creds: ProviderCredentials,
  ): MapEventResult {
    const eventKey = deriveEventKey(envelope);
    if (!eventKey) {
      return { skip: true, reason: "no_mapping" };
    }
    if (!config.enabledEvents.includes(eventKey)) {
      return { skip: true, reason: "filtered_by_event_scope" };
    }

    const body = JSON.stringify({
      id: envelope.outboxEventId,
      type: eventKey,
      created: envelope.occurredAt,
      apiVersion: WEBHOOK_API_VERSION,
      projectId: envelope.projectId,
      data: buildWebhookData(envelope),
    });

    return { eventKey, providerEvent: eventKey, body };
  },

  async deliver(
    payload: ProviderPayload,
    creds: ProviderCredentials,
    _http: HttpClient,
  ): Promise<DeliveryResult> {
    const { url, secrets } = parseWebhookCredentials(creds);
    const body = payload.body as string;

    // Rotated-out keys stop signing once their grace window closes, even if
    // a later rotation hasn't pruned them from the stored array yet.
    const activeKeys = activeWebhookSecretKeys(secrets);

    // Never send an unsigned or un-identifiable webhook. Both are reachable
    // in practice: parseWebhookCredentials degrades malformed "secrets" JSON
    // to [] rather than throwing, and payload.body is `unknown` on the
    // shared ProviderPayload type. signWebhook([]) would silently produce
    // an empty signature header, and an empty/missing id would ship
    // `webhook-id: ""` — fail closed instead, before any network call.
    if (activeKeys.length === 0) {
      return nonRetriableFailure("no active webhook secret configured for this connection");
    }

    let id: string | undefined;
    try {
      const parsed = JSON.parse(body) as { id?: unknown };
      if (typeof parsed.id === "string" && parsed.id.length > 0) {
        id = parsed.id;
      }
    } catch {
      id = undefined;
    }
    if (!id) {
      return nonRetriableFailure("webhook payload is missing a valid id");
    }

    try {
      // Re-validate at send time (not just at connection setup) — this is
      // what defends against DNS rebinding: the pinned IP resolved here is
      // the exact address the request connects to.
      const validatedUrl = assertPublicWebhookUrl(url);
      const pinnedIp = await resolvePinnedAddress(validatedUrl);
      const pinnedHttp = createPinnedHttpClient(pinnedIp);

      const timestampSec = Math.floor(Date.now() / 1000);
      const signature = signWebhook({
        id,
        timestampSec,
        body,
        secretKeys: activeKeys,
      });

      const res = await pinnedHttp.request({
        method: "POST",
        url,
        headers: {
          "content-type": "application/json",
          "webhook-id": id,
          "webhook-timestamp": String(timestampSec),
          "webhook-signature": signature,
          "svix-id": id,
          "svix-timestamp": String(timestampSec),
          "svix-signature": signature,
        },
        body,
      });

      return classifyDeliveryResponse(res);
    } catch (err) {
      if (err instanceof WebhookUrlError) {
        return nonRetriableFailure(err.reason);
      }
      return {
        ok: false,
        httpStatus: 0,
        responseBody: "",
        errorMessage: err instanceof Error ? err.message : String(err),
        retriable: true,
      };
    }
  },
};
