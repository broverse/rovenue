import { z } from "zod";
import type {
  IntegrationProvider,
  RovenueEventEnvelope,
  RovenueEventType,
  ConnectionConfig,
  ProviderCredentials,
  MapEventResult,
  ProviderPayload,
  HttpClient,
  DeliveryResult,
} from "../types";
import type { RovenueEventKey } from "@rovenue/shared";
import {
  SUBSCRIPTION_LIFECYCLE_KEYS,
  STANDARD_PROVIDER_EVENT_KEYS,
  REVENUE_EVENT_KEY_PREFIX,
} from "@rovenue/shared";
import {
  applyEventMapping,
  DEFAULT_EVENT_MAPPING,
  deriveRevenueEventKey,
} from "../event-mapping";

// ---------------------------------------------------------------------------
// deriveEventKey — identical pattern to braze.ts / appsflyer.ts / amplitude.ts
// / mixpanel.ts / adjust.ts / firebase-ga4.ts: the seven subscription.*
// RovenueEventType values are already spelled identically to their
// RovenueEventKey counterparts, so only revenue.* still goes through the
// shared `deriveRevenueEventKey` (kind -> `revenue.${kind}`).
// ---------------------------------------------------------------------------

const SUBSCRIPTION_LIFECYCLE_EVENT_TYPES = new Set<RovenueEventType>(
  SUBSCRIPTION_LIFECYCLE_KEYS,
);

function deriveEventKey(
  envelope: RovenueEventEnvelope,
): RovenueEventKey | undefined {
  if (SUBSCRIPTION_LIFECYCLE_EVENT_TYPES.has(envelope.eventType)) {
    return envelope.eventType as RovenueEventKey;
  }
  return deriveRevenueEventKey(envelope);
}

// ---------------------------------------------------------------------------
// Credentials — field ids mirror apps/dashboard's
// PROVIDER_CREDENTIAL_FIELDS.ONESIGNAL (step-credentials.tsx, locked in the
// Task 2 controller context): app_id + rest_api_key, both required.
// .catchall(z.string()) so unrelated extra string keys never fail
// validation, while keeping the inferred type Record<string, string>.
// ---------------------------------------------------------------------------

const credentialsSchema = z
  .object({
    app_id: z.string().min(1),
    rest_api_key: z.string().min(1),
  })
  .catchall(z.string());

// ---------------------------------------------------------------------------
// Contract verification (task-5-context.md, binding) — fetched
// documentation.onesignal.com 2026-08-25:
//
// The CONTEMPORARY custom-events surface exists and is documented at
// `POST https://api.onesignal.com/apps/{app_id}/custom_events`
// (reference/create-custom-events, OpenAPI operationId "create-custom-
// events", spec version 11.6) — this is a genuine Events API, not a
// tags/user-properties fallback, so that's the surface implemented here
// (the brief's fallback branch — properties/tags keyed by player id — is
// NOT used).
//
// Auth: the endpoint's own OpenAPI parameter spec is explicit —
// `Authorization: Key YOUR_APP_API_KEY` (the modern "Key " prefix; NOT
// Basic, NOT Bearer, despite the Java/Python SDK snippets on the same page
// labeling the scheme "rest_api_key" bearer-style internally — the actual
// wire header documented in the OpenAPI `parameters` block is the source of
// truth). The same per-app REST API key + "Key " prefix is used for the
// validateCredentials GET below (reference/view-an-app targets the same
// `api.onesignal.com` host and app-scoped key).
//
// Request body: `{ events: [{ name, external_id?, onesignal_id?, timestamp,
// payload }] }` — `app_id` is a PATH parameter only, never a body field
// (unlike e.g. Braze, where the endpoint itself is project-specific but
// carries no id in the URL at all). Exactly one of `external_id` /
// `onesignal_id` is required per event; this provider always sends
// `onesignal_id` (see resolveIdentity below — $onesignalId is OneSignal's
// own per-user id, not the app's external id).
// ---------------------------------------------------------------------------

const ONESIGNAL_API_BASE = "https://api.onesignal.com";

function buildCustomEventsUrl(appId: string): string {
  return `${ONESIGNAL_API_BASE}/apps/${encodeURIComponent(appId)}/custom_events`;
}

function buildViewAppUrl(appId: string): string {
  return `${ONESIGNAL_API_BASE}/apps/${encodeURIComponent(appId)}`;
}

function authHeader(restApiKey: string): string {
  return `Key ${restApiKey}`;
}

// ---------------------------------------------------------------------------
// Identity resolution — per the Task 5 brief: REQUIRES
// subscriberAttributes.$onesignalId, else skip `no_user_data`. Unlike
// BRAZE/APPSFLYER, there is no subscriberId fallback: $onesignalId is
// OneSignal's own internal user id (distinct from the app's own
// appUserId/externalId), and Rovenue has no way to derive it from anything
// else it holds — sending a Rovenue-internal id as `onesignal_id` would
// target the wrong (or no) OneSignal user.
// ---------------------------------------------------------------------------

function resolveOnesignalId(envelope: RovenueEventEnvelope): string | undefined {
  return envelope.subscriberAttributes?.["$onesignalId"];
}

// ---------------------------------------------------------------------------
// CROSS-PROVIDER RULING (Task 4 review, binding for every Wave-2 provider
// from Task 5 on): when a revenue envelope carries `amount` but NO
// `currency`, never fabricate a currency (no "USD" default). OneSignal's
// custom-events `payload` is a free-form JSON object with no vendor-required
// monetary schema (unlike Braze's `purchases[]`, which requires
// product_id/currency/price) — so the chosen behavior here is to OMIT both
// `amount` and `currency` from the payload rather than skip the whole event:
// the event (e.g. "a purchase happened") is still meaningful in OneSignal
// for Journey triggers/segmentation even without a dollar figure attached,
// and dropping just the two monetary keys costs nothing structurally. Both
// fields are included together only when both are present and parseable.
// ---------------------------------------------------------------------------

function buildMonetaryFields(
  envelope: RovenueEventEnvelope,
): { amount: number; currency: string } | Record<string, never> {
  if (!envelope.amount || !envelope.currency) {
    return {};
  }
  const amount = parseFloat(envelope.amount);
  if (isNaN(amount)) {
    return {};
  }
  return { amount, currency: envelope.currency };
}

// ---------------------------------------------------------------------------
// Wire body shapes — POST /apps/{app_id}/custom_events request.
// ---------------------------------------------------------------------------

interface OnesignalCustomEvent {
  name: string;
  onesignal_id: string;
  timestamp: string;
  payload: Record<string, unknown>;
}

interface OnesignalCustomEventsBody {
  events: OnesignalCustomEvent[];
}

// ---------------------------------------------------------------------------
// Delivery response classification — per the Task 5 brief and
// reference/create-custom-events's documented response set (fetched
// 2026-08-25): 2xx (200, or 202 "processed with per-event errors" — a
// partial-failure shape that is still an overall accepted request) is ok.
// 400 (malformed JSON / missing required fields) and 401/403 (missing or
// invalid Authorization / insufficient permission) are permanent rejections
// of this request or these credentials and must not retry. 429 (the
// endpoint always emits `Retry-After` on rate limiting) and 5xx are
// retriable.
// ---------------------------------------------------------------------------

function classifyOnesignalResponse(res: { status: number; body: string }): DeliveryResult {
  const { status } = res;
  const retriable = status === 429 || status >= 500;
  const ok = status >= 200 && status < 300;
  return {
    ok,
    httpStatus: status,
    responseBody: res.body,
    errorMessage: ok ? undefined : `onesignal http ${status}`,
    retriable,
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const onesignalProvider: IntegrationProvider = {
  id: "ONESIGNAL",

  topics: ["rovenue.revenue", "rovenue.subscription"],
  eventCatalog: STANDARD_PROVIDER_EVENT_KEYS,
  allowMultipleConnections: false,
  credentialsSchema,

  defaultEventMapping: DEFAULT_EVENT_MAPPING.ONESIGNAL,

  // REAL, zero-footprint validation — reference/view-an-app's
  // `GET /apps/{app_id}` returns the app's metadata for a valid app_id +
  // key pair and 401/403 for a bad key, without writing anything. Unlike
  // BRAZE (no read-only permission-proving endpoint exists), this proves
  // both "app_id is real" and "rest_api_key authenticates against it" with
  // no side effect, so no PROVIDER_VALIDATE_NOTES entry is needed.
  async validateCredentials(
    creds: ProviderCredentials,
    http: HttpClient,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const appId = creds["app_id"] ?? "";
    const apiKey = creds["rest_api_key"] ?? "";

    const res = await http.request({
      method: "GET",
      url: buildViewAppUrl(appId),
      headers: {
        authorization: authHeader(apiKey),
      },
    });
    if (res.status >= 200 && res.status < 300) {
      return { ok: true };
    }
    return { ok: false, reason: `validate http ${res.status}: ${res.body.slice(0, 200)}` };
  },

  mapEvent(
    envelope: RovenueEventEnvelope,
    config: ConnectionConfig,
    _creds: ProviderCredentials,
  ): MapEventResult {
    // outboxEventId rides `payload.outbox_event_id` below — OneSignal's
    // custom-events endpoint has its own `idempotency_key` retry field, but
    // that's a client-retry concern, not the provider-side dedup boundary
    // Rovenue's own delivery pipeline relies on. Fail loudly rather than
    // silently ship without it, same invariant as every other provider.
    if (!envelope.outboxEventId) {
      throw new Error(
        "integration delivery requires a non-empty outboxEventId for provider-side idempotency",
      );
    }

    const eventKey = deriveEventKey(envelope);
    if (!eventKey) {
      return { skip: true, reason: "no_mapping" };
    }

    const mappingResult = applyEventMapping({
      providerId: "ONESIGNAL",
      eventKey,
      enabledEvents: config.enabledEvents,
      override: config.eventMapping,
    });

    if (mappingResult.kind === "skip") {
      return { skip: true, reason: mappingResult.reason };
    }

    const onesignalId = resolveOnesignalId(envelope);
    if (!onesignalId) {
      return { skip: true, reason: "no_user_data" };
    }

    const payload: Record<string, unknown> = {
      rovenue_event: eventKey,
      outbox_event_id: envelope.outboxEventId,
    };

    if (eventKey.startsWith(REVENUE_EVENT_KEY_PREFIX)) {
      Object.assign(payload, buildMonetaryFields(envelope));
      if (envelope.productId) {
        payload.product_id = envelope.productId;
      }
    }

    const body: OnesignalCustomEventsBody = {
      events: [
        {
          name: mappingResult.providerEvent,
          onesignal_id: onesignalId,
          timestamp: new Date(envelope.occurredAt).toISOString(),
          payload,
        },
      ],
    };

    return {
      eventKey,
      providerEvent: mappingResult.providerEvent,
      body,
    };
  },

  async deliver(
    payload: ProviderPayload,
    creds: ProviderCredentials,
    http: HttpClient,
  ): Promise<DeliveryResult> {
    const appId = creds["app_id"] ?? "";
    const apiKey = creds["rest_api_key"] ?? "";

    const res = await http.request({
      method: "POST",
      url: buildCustomEventsUrl(appId),
      headers: {
        "content-type": "application/json",
        authorization: authHeader(apiKey),
      },
      body: JSON.stringify(payload.body),
    });

    return classifyOnesignalResponse(res);
  },
};
