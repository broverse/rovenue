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
// deriveEventKey — identical pattern to onesignal.ts / iterable.ts /
// braze.ts / appsflyer.ts / amplitude.ts / mixpanel.ts / adjust.ts /
// firebase-ga4.ts: the seven subscription.* RovenueEventType values are
// already spelled identically to their RovenueEventKey counterparts, so only
// revenue.* still goes through the shared `deriveRevenueEventKey`.
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
// Credentials — LOCKED field ids per the Task 7 controller context:
// app_name (Airbridge's own app slug, used as a URL path segment) +
// api_token (Airbridge API Token, "Settings > Tokens" in the Airbridge
// dashboard). Both required; `.catchall(z.string())` so unrelated extra
// string keys never fail validation, while keeping the inferred type
// Record<string, string>.
// ---------------------------------------------------------------------------

const credentialsSchema = z
  .object({
    app_name: z.string().min(1),
    api_token: z.string().min(1),
  })
  .catchall(z.string());

// ---------------------------------------------------------------------------
// Endpoint + wire contract — verified against Airbridge's own first-party
// docs (help.airbridge.io/en/references/s2s-event, fetched 2026-08-25).
// Sourcing note: developers.airbridge.io (the URL named in this task's
// context/brief) is a client-side-rendered SPA shell that returns no usable
// content to a plain fetch — help.airbridge.io serves the SAME "API
// Reference" content server-rendered (same nav tree: "API Reference" >
// "Server-to-Server Event"), confirmed via its documented request/response
// examples (a 200 response literally echoes `"Event(9360) is successfully
// proccessed."`, proving `9360` is a real, required literal path segment,
// not a documentation-tool artifact). This is first-party evidence, not
// third-party corroboration.
//
// `POST https://api.airbridge.io/events/v2/apps/{app_name}/mobile-app/9360`
// — the in-app (mobile) Send-Events endpoint; `{app_name}` is the
// credential's own value, a URL path segment (not a body field). Header:
// `Authorization: Bearer {API-TOKEN}`. Body: `device.deviceUUID` (Airbridge
// Device ID) OR `user.externalUserID` is required — this provider always
// sends `device.deviceUUID` (see resolveDeviceUUID below).
// `eventData.goal.category` is the vendor event name; `eventData.goal.value`
// + `eventData.goal.semanticAttributes.currency` carry revenue;
// `eventData.goal.semanticAttributes.transactionID` is Rovenue's own
// `outboxEventId`, per the task brief.
//
// KNOWN GAP (documented, not silently swallowed): the vendor docs mark
// `app.packageName` (the OS bundle id / package name) as a required body
// field. Rovenue's RovenueEventEnvelope/ConnectionConfig carry no bundle-id
// field (unlike AppsFlyer, whose per-platform app ids live directly in its
// own credentialsSchema) and this task's credentials are locked to
// `{ app_name, api_token }` — there is nowhere honest to source a real
// bundle id from without fabricating one. As a pragmatic default this sends
// `app.packageName = app_name` (many Airbridge app registrations use the
// bundle id as their app slug by dashboard convention, and the `{app_name}`
// URL segment already tells Airbridge which app/config the event belongs
// to), but this is NOT guaranteed correct for every customer — flagged here
// and in the docs page as a follow-up candidate (a dedicated bundle-id
// credential field) rather than assumed solved.
// ---------------------------------------------------------------------------

const AIRBRIDGE_API_BASE = "https://api.airbridge.io";
// Literal, vendor-assigned path segment (see sourcing note above) — not a
// version number Rovenue controls.
const AIRBRIDGE_MOBILE_APP_EVENTS_PATH = "mobile-app/9360";

function buildEventUrl(appName: string): string {
  return `${AIRBRIDGE_API_BASE}/events/v2/apps/${encodeURIComponent(appName)}/${AIRBRIDGE_MOBILE_APP_EVENTS_PATH}`;
}

// ---------------------------------------------------------------------------
// Identity resolution — per the Task 7 brief: REQUIRES
// subscriberAttributes.$airbridgeDeviceId, else skip `no_user_data`. Same
// shape as ONESIGNAL's $onesignalId gate: no subscriberId fallback, since a
// Rovenue-internal id is not a valid Airbridge Device ID (GAID/IDFA/IDFV/
// AppSetId/random-UUID) and sending one would misattribute or be rejected.
// ---------------------------------------------------------------------------

function resolveDeviceUUID(envelope: RovenueEventEnvelope): string | undefined {
  return envelope.subscriberAttributes?.["$airbridgeDeviceId"];
}

// ---------------------------------------------------------------------------
// CROSS-PROVIDER CURRENCY RULING (binding for every Wave-2 provider from
// Task 5 on): never fabricate a currency. Airbridge's own "Order Complete"
// standard-event guide says to "Always send
// eventData.goal.semanticAttributes.currency" for a purchase event — but
// this is documented as a correctness best-practice for revenue reporting,
// not a hard validation rule the S2S endpoint is documented to reject
// without (the 400/401 examples in the docs are about malformed requests /
// bad tokens generally, not specifically a missing currency). Given that,
// the chosen behavior mirrors ONESIGNAL's: when amount is present but
// currency is absent (or amount is unparseable), OMIT both `goal.value` and
// `semanticAttributes.currency` rather than send a guessed currency or drop
// the whole event — the event (e.g. "a purchase happened") is still useful
// for Airbridge's own attribution/audience features without a dollar figure
// attached. Both fields are included together only when both are present
// and parseable.
// ---------------------------------------------------------------------------

function resolveRevenueFields(
  envelope: RovenueEventEnvelope,
): { value: number; currency: string } | Record<string, never> {
  if (!envelope.amount || !envelope.currency) {
    return {};
  }
  const amount = parseFloat(envelope.amount);
  if (isNaN(amount)) {
    return {};
  }
  return { value: amount, currency: envelope.currency };
}

// ---------------------------------------------------------------------------
// Wire body shapes — POST .../mobile-app/9360 request body (In-App Events).
// ---------------------------------------------------------------------------

interface AirbridgeDevice {
  deviceUUID: string;
}

interface AirbridgeApp {
  packageName: string;
}

interface AirbridgeSemanticAttributes {
  transactionID: string;
  currency?: string;
}

interface AirbridgeGoal {
  category: string;
  value?: number;
  semanticAttributes: AirbridgeSemanticAttributes;
  customAttributes: { rovenue_event: RovenueEventKey };
}

interface AirbridgeEventBody {
  eventTimestamp: number;
  device: AirbridgeDevice;
  app: AirbridgeApp;
  eventData: { goal: AirbridgeGoal };
}

// ---------------------------------------------------------------------------
// Delivery response classification — per the Task 7 brief's binding
// classification: 2xx ok; 400/401/403 (malformed request / bad or missing
// token / forbidden) are permanent rejections of this exact request and
// must NOT retry; 429/5xx are retriable. (The vendor docs' own examples only
// show 200/400/401, consistent with — not contradicting — this classification;
// 403/429/5xx follow the same shape used across every other provider here.)
// ---------------------------------------------------------------------------

function classifyAirbridgeResponse(res: { status: number; body: string }): DeliveryResult {
  const { status } = res;
  const retriable = status === 429 || status >= 500;
  const ok = status >= 200 && status < 300;
  return {
    ok,
    httpStatus: status,
    responseBody: res.body,
    errorMessage: ok ? undefined : `airbridge http ${status}`,
    retriable,
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const airbridgeProvider: IntegrationProvider = {
  id: "AIRBRIDGE",

  topics: ["rovenue.revenue", "rovenue.subscription"],
  eventCatalog: STANDARD_PROVIDER_EVENT_KEYS,
  allowMultipleConnections: false,
  credentialsSchema,

  defaultEventMapping: DEFAULT_EVENT_MAPPING.AIRBRIDGE,

  // SHAPE-ONLY validation — same deliberate, documented shape as APPSFLYER's
  // (and ADJUST's/SINGULAR's) validateCredentials. Every genuinely
  // zero-footprint GET endpoint found in Airbridge's API reference (List
  // Tracking Links v1/v2, `GET /v1|v2/tracking-links`) belongs to an
  // unrelated feature (tracking-link generation), requires its own required
  // `from`/`to` date-range query params unrelated to event delivery, and —
  // critically — is NOT scoped by `app_name`, so a successful response would
  // prove only that `api_token` authenticates, never that it's paired with
  // THIS connection's `app_name`. Sending a real S2S event to prove the pair
  // together would be a live, attributable write to a real Airbridge app —
  // exactly the side effect validateCredentials must never cause silently.
  // So this only confirms the submitted credentials are well-formed per
  // credentialsSchema; the first real delivery is the live proof, surfaced
  // via the connection's Delivery Log. Disclosed in the docs page
  // (apps/docs/content/docs/integrations/airbridge.mdx) — no
  // PROVIDER_VALIDATE_NOTES entry is added in the dashboard because, like
  // APPSFLYER, nothing is actually sent here.
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
    // outboxEventId is the SOLE provider-side idempotency boundary — it
    // rides `semanticAttributes.transactionID` below (Airbridge's own
    // `eventUUID` field is intentionally left unset rather than fed
    // outboxEventId: the vendor docs type it as "a random string in UUID4
    // format", and Rovenue's cuid2 outboxEventIds are not valid UUID4
    // strings — sending an off-format value there risks a 400 the same way
    // a guessed currency would misreport revenue). Fail loudly rather than
    // silently degrade dedup to "every send unique" — same invariant as
    // every other provider in this codebase.
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
      providerId: "AIRBRIDGE",
      eventKey,
      enabledEvents: config.enabledEvents,
      override: config.eventMapping,
    });

    if (mappingResult.kind === "skip") {
      return { skip: true, reason: mappingResult.reason };
    }

    const deviceUUID = resolveDeviceUUID(envelope);
    if (!deviceUUID) {
      return { skip: true, reason: "no_user_data" };
    }

    const goal: AirbridgeGoal = {
      category: mappingResult.providerEvent,
      semanticAttributes: {
        transactionID: envelope.outboxEventId,
      },
      customAttributes: {
        rovenue_event: eventKey,
      },
    };

    // Revenue fields only apply to revenue.* keys — sending them on a
    // subscription-lifecycle event would fabricate revenue for an event
    // that carries no money movement, same invariant as every other
    // provider here.
    if (eventKey.startsWith(REVENUE_EVENT_KEY_PREFIX)) {
      const revenueFields = resolveRevenueFields(envelope);
      if ("value" in revenueFields) {
        goal.value = revenueFields.value;
        goal.semanticAttributes.currency = revenueFields.currency;
      }
    }

    const appName = creds["app_name"] ?? "";
    const body: AirbridgeEventBody = {
      eventTimestamp: Date.parse(envelope.occurredAt),
      device: { deviceUUID },
      // See the "KNOWN GAP" comment above the endpoint constants: reuses
      // the app_name credential as a pragmatic default for the vendor's
      // required (and otherwise unavailable) bundle-id field.
      app: { packageName: appName },
      eventData: { goal },
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
    const appName = creds["app_name"] ?? "";
    const apiToken = creds["api_token"] ?? "";

    const res = await http.request({
      method: "POST",
      url: buildEventUrl(appName),
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiToken}`,
      },
      body: JSON.stringify(payload.body),
    });

    return classifyAirbridgeResponse(res);
  },
};
