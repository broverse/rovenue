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
import { applyEventMapping, deriveRevenueEventKey } from "../event-mapping";

// ---------------------------------------------------------------------------
// deriveEventKey
// ---------------------------------------------------------------------------
//
// Same shape as AMPLITUDE/MIXPANEL/APPSFLYER/ADJUST (Tasks 5-8): the seven
// `subscription.*` RovenueEventType values are already spelled identically
// to their RovenueEventKey counterparts, so only revenue.* goes through the
// shared `deriveRevenueEventKey` helper.
// ---------------------------------------------------------------------------

const SUBSCRIPTION_LIFECYCLE_EVENT_TYPES = new Set<RovenueEventType>([
  "subscription.trial.started",
  "subscription.cancel_requested",
  "subscription.expired",
  "subscription.billing_issue",
  "subscription.grace_period",
  "subscription.uncancelled",
  "subscription.product_changed",
]);

function deriveEventKey(
  envelope: RovenueEventEnvelope,
): RovenueEventKey | undefined {
  if (SUBSCRIPTION_LIFECYCLE_EVENT_TYPES.has(envelope.eventType)) {
    return envelope.eventType as RovenueEventKey;
  }
  return deriveRevenueEventKey(envelope);
}

// ---------------------------------------------------------------------------
// Default event mapping
//
// GA4 custom event names must match `^[A-Za-z]\w*$` (start with a letter,
// then letters/digits/underscore only — dots and hyphens are rejected).
// Per the Task 10 controller ruling:
//   - revenue.INITIAL / RENEWAL / TRIAL_CONVERSION / CREDIT_PURCHASE all
//     collapse onto GA4's own recommended "purchase" event — GA4 has no
//     separate vocabulary for a renewal vs. an initial purchase vs. a trial
//     conversion, unlike Amplitude/Mixpanel's free-form event names.
//   - revenue.REFUND -> GA4's own recommended "refund" event.
//   - revenue.CANCELLATION -> "rovenue_cancellation" (GA4 has no standard
//     cancellation event; this is a literal, not derived by the dots->
//     underscores rule below, since "revenue.CANCELLATION" would otherwise
//     produce "rovenue_revenue_cancellation").
//   - every subscription.* key -> "rovenue_" + the event type with dots
//     replaced by underscores (ga4SubscriptionEventName below), since GA4
//     has no standard vocabulary for subscription lifecycle at all.
// ---------------------------------------------------------------------------

const GA4_PURCHASE_EVENT = "purchase";
const GA4_REFUND_EVENT = "refund";
const GA4_CANCELLATION_EVENT = "rovenue_cancellation";

/** "subscription.trial.started" -> "rovenue_subscription_trial_started". */
function ga4SubscriptionEventName(eventType: RovenueEventType): string {
  return `rovenue_${eventType.replace(/\./g, "_")}`;
}

const defaultEventMapping: IntegrationProvider["defaultEventMapping"] = {
  "revenue.INITIAL": GA4_PURCHASE_EVENT,
  "revenue.RENEWAL": GA4_PURCHASE_EVENT,
  "revenue.TRIAL_CONVERSION": GA4_PURCHASE_EVENT,
  "revenue.CREDIT_PURCHASE": GA4_PURCHASE_EVENT,
  "revenue.REFUND": GA4_REFUND_EVENT,
  "revenue.CANCELLATION": GA4_CANCELLATION_EVENT,
  "subscription.trial.started": ga4SubscriptionEventName("subscription.trial.started"),
  "subscription.cancel_requested": ga4SubscriptionEventName("subscription.cancel_requested"),
  "subscription.expired": ga4SubscriptionEventName("subscription.expired"),
  "subscription.billing_issue": ga4SubscriptionEventName("subscription.billing_issue"),
  "subscription.grace_period": ga4SubscriptionEventName("subscription.grace_period"),
  "subscription.uncancelled": ga4SubscriptionEventName("subscription.uncancelled"),
  "subscription.product_changed": ga4SubscriptionEventName("subscription.product_changed"),
};

// eventCatalog = exactly the keys of defaultEventMapping above — the same
// 13-key Wave-1 revenue + subscription-lifecycle set as AMPLITUDE/MIXPANEL/
// APPSFLYER/ADJUST.
const eventCatalog: readonly RovenueEventKey[] = [
  "revenue.INITIAL",
  "revenue.TRIAL_CONVERSION",
  "revenue.RENEWAL",
  "revenue.CREDIT_PURCHASE",
  "revenue.REFUND",
  "revenue.CANCELLATION",
  "subscription.trial.started",
  "subscription.cancel_requested",
  "subscription.expired",
  "subscription.billing_issue",
  "subscription.grace_period",
  "subscription.uncancelled",
  "subscription.product_changed",
];

// ---------------------------------------------------------------------------
// Credentials — field ids mirror apps/dashboard's
// PROVIDER_CREDENTIAL_FIELDS.FIREBASE_GA4 (step-credentials.tsx) — the
// backend contract those inputs submit against. `firebase_app_id` (NOT
// `measurement_id`) scopes this provider to Firebase app streams only; GA4
// web streams (measurement_id + client_id) are a documented non-goal this
// wave (see the docs page). `.catchall(z.string())` so unrelated extra
// string keys never fail validation, while keeping the inferred type
// Record<string, string>.
// ---------------------------------------------------------------------------

const credentialsSchema = z
  .object({
    api_secret: z.string().min(1),
    firebase_app_id: z.string().min(1),
  })
  .catchall(z.string());

// ---------------------------------------------------------------------------
// Endpoints — verified against Google's GA4 Measurement Protocol reference
// (developers.google.com/analytics/devguides/collection/protocol/ga4,
// fetched 2026-08-24): event ingestion is `POST /mp/collect`, the parallel
// validation server is `POST /debug/mp/collect` — both on
// `www.google-analytics.com`, both taking `firebase_app_id` + `api_secret`
// as query params (for a Firebase-app stream; a GA4 web stream would instead
// use `measurement_id`, which this provider does not support — see docs).
// The request body shape is identical between the two endpoints; only the
// path differs.
// ---------------------------------------------------------------------------

const GA4_MP_COLLECT_ENDPOINT = "https://www.google-analytics.com/mp/collect";
const GA4_MP_DEBUG_ENDPOINT = "https://www.google-analytics.com/debug/mp/collect";

function buildUrl(base: string, creds: ProviderCredentials): string {
  const appId = creds["firebase_app_id"] ?? "";
  const secret = creds["api_secret"] ?? "";
  return `${base}?firebase_app_id=${encodeURIComponent(appId)}&api_secret=${encodeURIComponent(secret)}`;
}

// ---------------------------------------------------------------------------
// Identity resolution — REQUIRES $firebaseAppInstanceId, no fallback chain
// (unlike Amplitude/Mixpanel's appUserId/subscriberId fallbacks). GA4's
// Measurement Protocol has no concept of an arbitrary user id for a
// Firebase-app stream — every event must carry the Firebase Analytics SDK's
// own `app_instance_id`, which only the host app's Firebase SDK can mint.
// There is no substitute value Rovenue could send that would land against
// the correct GA4 user, so an absent id skips with `no_user_data` rather
// than guessing.
// ---------------------------------------------------------------------------

function resolveAppInstanceId(envelope: RovenueEventEnvelope): string | undefined {
  return envelope.subscriberAttributes?.["$firebaseAppInstanceId"];
}

// ---------------------------------------------------------------------------
// Wire body shape
// ---------------------------------------------------------------------------

interface Ga4EventParams {
  currency?: string;
  value?: number;
  transaction_id: string;
  product_id?: string;
  rovenue_event: string;
}

interface Ga4WireBody {
  app_instance_id: string;
  timestamp_micros: number;
  events: [{ name: string; params: Ga4EventParams }];
}

// Stable (not per-call) validation probe identifiers — mirrors AMPLITUDE/
// MIXPANEL's pattern of a clearly-tagged, deterministic probe rather than a
// fresh event per click. Unlike those two providers this probe is sent to
// the DEBUG endpoint, which per Google's own docs "will not appear in your
// reports" — there is no live-write side effect to disclose here (see
// validateCredentials below and step-credentials.tsx's PROVIDER_VALIDATE_
// NOTES, which deliberately has NO entry for FIREBASE_GA4).
const GA4_VALIDATION_APP_INSTANCE_ID = "rovenue_credential_check";
const GA4_VALIDATION_EVENT_NAME = "rovenue_credential_check";

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const firebaseGa4Provider: IntegrationProvider = {
  id: "FIREBASE_GA4",

  topics: ["rovenue.revenue", "rovenue.subscription"],
  eventCatalog,
  allowMultipleConnections: false,
  credentialsSchema,

  defaultEventMapping,

  // REAL, zero-footprint validation — the one Wave-1 vendor with a
  // purpose-built validation endpoint (GA4's `/debug/mp/collect`), unlike
  // APPSFLYER/ADJUST's shape-only checks. Per Google's docs: "Events sent to
  // the validation server are not counted for reporting purposes" — no
  // Firebase/GA4-side write occurs. A caveat straight from the same docs,
  // repeated here deliberately: the validation server does NOT validate
  // `api_secret` or `firebase_app_id` themselves (a wrong-but-well-formed
  // secret or app id still yields an empty `validationMessages` array) — it
  // only validates the event BODY's shape (event names, param types,
  // reserved-name collisions, etc.). This is disclosed in the docs page;
  // no PROVIDER_VALIDATE_NOTES entry is needed in the dashboard since there
  // is no live-write side effect to disclose, only a scope caveat.
  async validateCredentials(
    creds: ProviderCredentials,
    http: HttpClient,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const res = await http.request({
      method: "POST",
      url: buildUrl(GA4_MP_DEBUG_ENDPOINT, creds),
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        app_instance_id: GA4_VALIDATION_APP_INSTANCE_ID,
        events: [{ name: GA4_VALIDATION_EVENT_NAME, params: {} }],
      }),
    });

    if (res.status < 200 || res.status >= 300) {
      return { ok: false, reason: `validate http ${res.status}: ${res.body.slice(0, 200)}` };
    }

    let parsed: { validationMessages?: unknown[] };
    try {
      parsed = JSON.parse(res.body) as { validationMessages?: unknown[] };
    } catch {
      return { ok: false, reason: "validate: could not parse GA4 debug endpoint response" };
    }

    const messages = Array.isArray(parsed.validationMessages) ? parsed.validationMessages : [];
    if (messages.length > 0) {
      return {
        ok: false,
        reason: `validate: GA4 reported ${messages.length} validation issue(s): ${JSON.stringify(
          messages,
        ).slice(0, 300)}`,
      };
    }
    return { ok: true };
  },

  mapEvent(
    envelope: RovenueEventEnvelope,
    config: ConnectionConfig,
    _creds: ProviderCredentials,
  ): MapEventResult {
    // outboxEventId is the SOLE provider-side idempotency boundary (it is
    // stamped into GA4's `transaction_id`, which GA4 uses to dedup repeated
    // purchase/refund events). Fail loudly rather than silently degrade
    // dedup to "every send unique" — same invariant as every other Wave-1
    // provider.
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
      providerId: "FIREBASE_GA4",
      eventKey,
      enabledEvents: config.enabledEvents,
      override: config.eventMapping,
    });

    if (mappingResult.kind === "skip") {
      return { skip: true, reason: mappingResult.reason };
    }

    const appInstanceId = resolveAppInstanceId(envelope);
    if (!appInstanceId) {
      return { skip: true, reason: "no_user_data" };
    }

    const params: Ga4EventParams = {
      transaction_id: envelope.outboxEventId,
      product_id: envelope.productId,
      rovenue_event: eventKey,
    };

    // Revenue fields only apply to revenue.* keys — sending them on a
    // subscription-lifecycle event would fabricate revenue in GA4's revenue
    // reports for an event that carries no money movement.
    //
    // REFUND is sent with a POSITIVE `value` alongside the "refund" event
    // name — this is the OPPOSITE convention from Amplitude/Mixpanel (which
    // negate the amount and keep a generic event name). GA4's own
    // documented refund model (https://support.google.com/analytics/answer/
    // 9267735) represents a refund as a distinct "refund" event carrying the
    // POSITIVE amount being refunded, which GA4 itself nets against prior
    // "purchase" events server-side when computing revenue. Negating the
    // value here would double-negate against GA4's own accounting.
    if (eventKey.startsWith("revenue.")) {
      const amount = envelope.amount ? parseFloat(envelope.amount) : undefined;
      if (amount !== undefined && !isNaN(amount)) {
        params.value = amount;
        if (envelope.currency) {
          params.currency = envelope.currency;
        }
      }
    }

    const body: Ga4WireBody = {
      app_instance_id: appInstanceId,
      timestamp_micros: Date.parse(envelope.occurredAt) * 1000,
      events: [{ name: mappingResult.providerEvent, params }],
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
    const res = await http.request({
      method: "POST",
      url: buildUrl(GA4_MP_COLLECT_ENDPOINT, creds),
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload.body),
    });

    // Per the Task 10 brief's classification: the Measurement Protocol
    // collect endpoint returns 2xx (typically 204) regardless of whether
    // the event payload itself was valid — Google's own docs are explicit
    // that MP "does not return HTTP error codes even when an event ... is
    // malformed". So this classification only ever fires on transport/
    // auth-adjacent failures, not payload issues: 2xx ok; 4xx (e.g. a
    // malformed request Google's edge rejects before MP semantics apply) is
    // a permanent rejection of this exact request and must NOT retry; 5xx
    // is retriable.
    const ok = res.status >= 200 && res.status < 300;
    const retriable = res.status >= 500;

    return {
      ok,
      httpStatus: res.status,
      responseBody: res.body,
      errorMessage: ok ? undefined : `firebase_ga4 http ${res.status}`,
      retriable,
    };
  },
};
