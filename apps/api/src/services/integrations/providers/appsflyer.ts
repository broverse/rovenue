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
  WAVE1_PROVIDER_EVENT_KEYS,
} from "@rovenue/shared";
import {
  applyEventMapping,
  DEFAULT_EVENT_MAPPING,
  deriveRevenueEventKey,
} from "../event-mapping";

// ---------------------------------------------------------------------------
// deriveEventKey
// ---------------------------------------------------------------------------
//
// Same shape as AMPLITUDE/MIXPANEL (Tasks 5/6): the seven `subscription.*`
// RovenueEventType values are already spelled identically to their
// RovenueEventKey counterparts, so only revenue.* goes through the shared
// `deriveRevenueEventKey` helper (the set itself is shared — see
// amplitude.ts for the fuller rationale).
// ---------------------------------------------------------------------------

// Typing the Set as RovenueEventType while seeding it from the shared
// RovenueEventKey list is load-bearing, not incidental: it is what makes tsc
// reject the pass-through cast below the moment the two unions drift.
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
// Default event mapping + catalog
// ---------------------------------------------------------------------------
//
// The vendor names are AppsFlyer's own `af_`-prefixed in-app-event vocabulary
// (unlike AMPLITUDE/MIXPANEL, which have no reserved event-name vocabulary of
// their own); the table lives in event-mapping.ts's DEFAULT_EVENT_MAPPING,
// the one copy applyEventMapping reads. The offered key set comes from
// @rovenue/shared's WAVE1_PROVIDER_EVENT_KEYS, which the dashboard drawer's
// event picker reads too.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Credentials — field ids mirror apps/dashboard's
// PROVIDER_CREDENTIAL_FIELDS.APPSFLYER (step-credentials.tsx). Both app ids
// are individually optional, but the `.refine` below requires at least one —
// AppsFlyer's in-app-event endpoint is per-app (`/inappevent/{appId}`), so a
// connection with neither id configured could never deliver anything.
// .catchall(z.string()) so unrelated extra string keys never fail
// validation, while keeping the inferred type Record<string, string>.
// ---------------------------------------------------------------------------

const credentialsSchema = z
  .object({
    dev_key: z.string().min(1),
    app_id_ios: z.string().min(1).optional(),
    app_id_android: z.string().min(1).optional(),
  })
  .catchall(z.string())
  .refine((c) => Boolean(c.app_id_ios) || Boolean(c.app_id_android), {
    message: "at least one of app_id_ios or app_id_android is required",
    path: ["app_id_ios"],
  });

// ---------------------------------------------------------------------------
// Endpoint — AppsFlyer's server-to-server (S2S) in-app-event API. Per the
// Task 7 brief's verified wire shape: POST
// https://api2.appsflyer.com/inappevent/{appId} with header
// `authentication: <dev_key>`.
//
// Vendor-docs verification note: two live-fetch attempts were made against
// dev.appsflyer.com / support.appsflyer.com during implementation — the
// first returned an unrelated "retrieve test-device events" API-playground
// page (JS-rendered, not the S2S in-app-event reference), the second 403'd.
// Neither confirmed the contract independently; this endpoint/header/body
// shape is taken from the brief's design-time reference, which itself
// reflects AppsFlyer's long-stable, widely-integrated S2S contract. Flagged
// here per the task's "vendor docs unreachable" instruction — first live
// delivery is the real-world proof, consistent with validateCredentials
// being shape-only below.
// ---------------------------------------------------------------------------

const APPSFLYER_INAPP_EVENT_ENDPOINT_BASE = "https://api2.appsflyer.com/inappevent";

function buildEventUrl(appId: string): string {
  return `${APPSFLYER_INAPP_EVENT_ENDPOINT_BASE}/${encodeURIComponent(appId)}`;
}

// ---------------------------------------------------------------------------
// eventTime formatting — AppsFlyer requires "yyyy-MM-dd HH:mm:ss.SSS" in UTC.
// Pure, string-built from UTC Date parts (no date library) so it has no
// runtime-locale or timezone dependency.
// ---------------------------------------------------------------------------

function pad(n: number, len = 2): string {
  return String(n).padStart(len, "0");
}

export function formatAppsflyerEventTime(occurredAt: string): string {
  const d = new Date(occurredAt);
  const datePart = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  const timePart = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${pad(
    d.getUTCMilliseconds(),
    3,
  )}`;
  return `${datePart} ${timePart}`;
}

// ---------------------------------------------------------------------------
// App-id selection (§4.2 decision matrix)
//
// 1. Both app_id_ios and app_id_android configured AND the subscriber's
//    `platform` attribute matches one of them (ios/android) -> use that one.
// 2. Exactly ONE app id configured -> use it, regardless of platform (a
//    single-storefront project has nothing else to pick between).
// 3. Both configured but platform is absent, unrecognized, or "web" -> there
//    is no basis to choose; skip with the dedicated `no_platform_app_id`
//    reason rather than guessing.
//
// credentialsSchema's `.refine` guarantees at least one id is configured by
// the time a connection can be created, so the neither-configured branch
// below is unreachable in practice — it's kept only so this function is
// total and never silently falls through to `undefined`.
// ---------------------------------------------------------------------------

type AppIdResolution =
  | { appId: string }
  | { skip: true; reason: "no_platform_app_id" };

function resolveAppId(
  creds: ProviderCredentials,
  platform: string | undefined,
): AppIdResolution {
  const iosAppId = creds["app_id_ios"];
  const androidAppId = creds["app_id_android"];
  const hasIos = Boolean(iosAppId);
  const hasAndroid = Boolean(androidAppId);

  if (hasIos && hasAndroid) {
    if (platform === "ios") return { appId: iosAppId as string };
    if (platform === "android") return { appId: androidAppId as string };
    return { skip: true, reason: "no_platform_app_id" };
  }
  if (hasIos) return { appId: iosAppId as string };
  if (hasAndroid) return { appId: androidAppId as string };
  return { skip: true, reason: "no_platform_app_id" };
}

// ---------------------------------------------------------------------------
// Payload body shape
//
// `ProviderPayload.body` is `unknown` by contract — only this provider's own
// mapEvent/deliver pair need to agree on its shape. AppsFlyer's app id is a
// URL path segment, not a wire field, so it can't simply ride inside the
// JSON body that gets POSTed (`wire`) — it's carried alongside it here and
// deliver() reads `body.appId` to build the URL while sending `body.wire`
// (and only `body.wire`) as the request payload.
// ---------------------------------------------------------------------------

interface AppsflyerWireBody {
  appsflyer_id: string;
  customer_user_id?: string;
  eventName: string;
  eventTime: string;
  eventCurrency?: string;
  eventValue: string;
}

interface AppsflyerPayloadBody {
  appId: string;
  wire: AppsflyerWireBody;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const appsflyerProvider: IntegrationProvider = {
  id: "APPSFLYER",

  topics: ["rovenue.revenue", "rovenue.subscription"],
  eventCatalog: WAVE1_PROVIDER_EVENT_KEYS,
  allowMultipleConnections: false,
  credentialsSchema,

  defaultEventMapping: DEFAULT_EVENT_MAPPING.APPSFLYER,

  // SHAPE-ONLY validation — deliberate, documented deviation from the other
  // Wave-1 providers. AppsFlyer's S2S in-app-event API has no dedicated
  // credential-check endpoint (unlike Amplitude/Mixpanel's ingestion
  // endpoints, which reject a bad key/secret up front and so can double as a
  // probe). There is no zero-footprint way to prove a dev_key or app id is
  // *correct* without sending a real, attributable event to a real
  // AppsFlyer app — which validateCredentials must never do silently. So
  // this only confirms the submitted credentials are well-formed per
  // credentialsSchema (dev_key present, at least one app id present); the
  // first real delivery is the live proof, surfaced via the connection's
  // Delivery Log. This is disclosed in the docs page
  // (apps/docs/content/docs/integrations/appsflyer.mdx) — no
  // PROVIDER_VALIDATE_NOTES entry is added in the dashboard because, unlike
  // AMPLITUDE/MIXPANEL, nothing is actually sent here.
  async validateCredentials(
    creds: ProviderCredentials,
    _http: HttpClient,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const result = credentialsSchema.safeParse(creds);
    if (!result.success) {
      return {
        ok: false,
        reason: result.error.issues.map((i) => i.message).join("; "),
      };
    }
    return { ok: true };
  },

  mapEvent(
    envelope: RovenueEventEnvelope,
    config: ConnectionConfig,
    creds: ProviderCredentials,
  ): MapEventResult {
    // outboxEventId is the SOLE provider-side idempotency boundary (it is
    // stamped into `af_order_id` inside eventValue). Fail loudly rather than
    // silently degrade dedup to "every send unique" — same invariant as
    // amplitude.ts / mixpanel.ts / meta-capi.ts.
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
      providerId: "APPSFLYER",
      eventKey,
      enabledEvents: config.enabledEvents,
      override: config.eventMapping,
    });

    if (mappingResult.kind === "skip") {
      return { skip: true, reason: mappingResult.reason };
    }

    const appsflyerId = envelope.subscriberAttributes?.["$appsflyerId"];
    if (!appsflyerId) {
      return { skip: true, reason: "no_user_data" };
    }

    const platform = envelope.subscriberAttributes?.["platform"];
    const appIdResolution = resolveAppId(creds, platform);
    if ("skip" in appIdResolution) {
      return appIdResolution;
    }

    const eventValue: Record<string, unknown> = {
      af_order_id: envelope.outboxEventId,
    };
    if (envelope.productId) {
      eventValue.product_id = envelope.productId;
    }

    const wire: AppsflyerWireBody = {
      appsflyer_id: appsflyerId,
      eventName: mappingResult.providerEvent,
      eventTime: formatAppsflyerEventTime(envelope.occurredAt),
      eventValue: "", // filled in below, after eventValue is finalized
    };

    const customerUserId = envelope.subscriberAttributes?.["appUserId"];
    if (customerUserId) {
      wire.customer_user_id = customerUserId;
    }

    // Revenue fields only apply to revenue.* keys — sending them on a
    // subscription-lifecycle event would fabricate revenue for an event
    // that carries no money movement. No refund sign-flip here (unlike
    // Amplitude/Mixpanel's documented negative-revenue convention):
    // AppsFlyer's in-app-event API has no equivalent documented convention
    // for representing refunds as negative revenue, so `af_revenue` is sent
    // as Rovenue's own POSITIVE stored amount.
    if (eventKey.startsWith("revenue.")) {
      const amount = envelope.amount ? parseFloat(envelope.amount) : undefined;
      if (amount !== undefined && !isNaN(amount)) {
        eventValue.af_revenue = amount;
        if (envelope.currency) {
          eventValue.af_currency = envelope.currency;
        }
      }
      if (envelope.currency) {
        wire.eventCurrency = envelope.currency;
      }
    }

    wire.eventValue = JSON.stringify(eventValue);

    return {
      eventKey,
      providerEvent: mappingResult.providerEvent,
      body: { appId: appIdResolution.appId, wire } satisfies AppsflyerPayloadBody,
    };
  },

  async deliver(
    payload: ProviderPayload,
    creds: ProviderCredentials,
    http: HttpClient,
  ): Promise<DeliveryResult> {
    const { appId, wire } = payload.body as AppsflyerPayloadBody;
    const devKey = creds["dev_key"] ?? "";

    const res = await http.request({
      method: "POST",
      url: buildEventUrl(appId),
      headers: {
        "content-type": "application/json",
        authentication: devKey,
      },
      body: JSON.stringify(wire),
    });

    // Per the Task 7 brief's classification: 200 ok; 400/401/403 (malformed
    // request / bad dev_key / forbidden) are permanent rejections of this
    // exact request and must NOT retry; 429/5xx are retriable.
    const retriable = res.status === 429 || res.status >= 500;
    const ok = res.status >= 200 && res.status < 300;

    return {
      ok,
      httpStatus: res.status,
      responseBody: res.body,
      errorMessage: ok ? undefined : `appsflyer http ${res.status}`,
      retriable,
    };
  },
};
