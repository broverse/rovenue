import { createHash } from "node:crypto";
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
// Credentials — app_name (Airbridge's own app slug, used as a URL path
// segment) + api_token (Airbridge API Token, "Settings > Tokens" in the
// Airbridge dashboard), both required. `.catchall(z.string())` so unrelated
// extra string keys never fail validation, while keeping the inferred type
// Record<string, string>.
//
// package_name added post-review (2026-08-25), OPTIONAL: Airbridge's S2S
// contract marks `app.packageName` (the OS bundle id / package name) as a
// REQUIRED body field, and this provider was silently guessing it as the
// app_name slug. That is the same class of sin as fabricating a currency —
// inventing a vendor-required identifier — so there is now an honest place
// to put the real value. It stays optional rather than required because
// making it required would break every already-configured connection on
// upgrade with no migration to backfill it (this wave ships zero
// migrations); when it is blank the disclosed slug fallback still applies
// (see resolvePackageName below), and both the dashboard label and
// airbridge.mdx say plainly that setting it is strongly recommended.
// ---------------------------------------------------------------------------

const credentialsSchema = z
  .object({
    app_name: z.string().min(1),
    api_token: z.string().min(1),
    package_name: z.string().min(1).optional(),
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
// `app.packageName` (the OS bundle id / package name) is marked required by
// the vendor docs. It now has an honest source — the OPTIONAL `package_name`
// credential (see credentialsSchema above) — with the previously-disclosed
// `app_name` slug kept only as the blank-field fallback. See
// resolvePackageName below.
//
// EVENT AGE LIMIT (vendor-imposed, disclosed rather than worked around):
// Airbridge DISCARDS events whose `eventTimestamp` is more than 24 hours in
// the past. Nothing in this provider or the delivery pipeline can widen that
// window — the endpoint answers 2xx and drops the event server-side, so a
// discarded event is INVISIBLE to Rovenue: the Delivery Log shows a green
// `succeeded` row and nothing arrives in Airbridge.
//
// The consequence that matters operationally: BACKFILL (services/
// integrations/backfill.ts) is gated only by the provider's topics, so the
// dashboard happily offers a backfill for an AIRBRIDGE connection — and any
// backfilled row older than 24 hours is a silent no-op. Backfill is still
// useful here for a window that starts inside the last day (e.g. a
// connection activated this morning), and is deliberately NOT blocked in
// code this wave: that would be a behavior change beyond the disclosure
// fix, and a hard block would also be wrong for the sub-24h case. Documented
// in apps/docs/content/docs/integrations/airbridge.mdx's verification
// section.
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
// app.packageName — the real bundle id when the connection supplies one,
// otherwise the long-standing (and documented) `app_name` slug fallback.
//
// The fallback exists only for connections created before `package_name` was
// offered; it is a guess, and both the dashboard field label and the docs
// page say so. It is kept rather than skipping the event because
// `app.packageName` is required by the vendor: dropping every event from an
// already-working connection on upgrade would be a strictly worse failure
// than the imperfect value those connections have been sending all along.
// ---------------------------------------------------------------------------

function resolvePackageName(creds: ProviderCredentials): string {
  return creds["package_name"] ?? creds["app_name"] ?? "";
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
// eventUUID — DETERMINISTIC, derived from outboxEventId.
//
// Airbridge types `eventUUID` as "a random string in UUID4 format" and treats
// it as its own dedup key. It used to be left unset here, on the (correct)
// premise that Rovenue's cuid2 outboxEventIds are not UUID4-shaped — but the
// conclusion was wrong: delivery is at-least-once, so an unset eventUUID
// means a RETRIED delivery arrives as a brand-new event and double-counts the
// revenue on Airbridge's side. `semanticAttributes.transactionID` carries the
// outboxEventId for traceability, but it is not the field Airbridge dedups on.
//
// So: derive a UUID4-SHAPED value deterministically instead of skipping it.
// sha256 the outboxEventId, lay the digest out as 8-4-4-4-12, and force the
// version (`4`) and variant (`8|9|a|b`) nibbles so the result matches the
// format Airbridge expects while the SAME outboxEventId always produces the
// SAME eventUUID. Same "deterministic id from stable fields via sha256"
// precedent the SDK session-telemetry event ids use.
//
// This is a dedup key, not a security token: sha256 is used for its stable,
// well-distributed output, and the truncation to 122 usable bits is inherent
// to the UUID format Airbridge requires.
// ---------------------------------------------------------------------------

const UUID4_VERSION_NIBBLE = "4";
/** The four nibbles RFC 4122 allows in the variant position. */
const UUID4_VARIANT_NIBBLES = "89ab";

export function deriveAirbridgeEventUUID(outboxEventId: string): string {
  const hex = createHash("sha256").update(outboxEventId).digest("hex");
  const variantIndex = parseInt(hex.slice(16, 17), 16) % UUID4_VARIANT_NIBBLES.length;
  const variant = UUID4_VARIANT_NIBBLES.slice(variantIndex, variantIndex + 1);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `${UUID4_VERSION_NIBBLE}${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join("-");
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
  eventUUID: string;
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
    // outboxEventId is the SOLE provider-side idempotency boundary. It rides
    // the wire TWICE: verbatim as `semanticAttributes.transactionID` (human-
    // traceable back to the Rovenue outbox row) and hashed into a
    // UUID4-shaped `eventUUID` (the field Airbridge itself dedups on — see
    // deriveAirbridgeEventUUID above). Fail loudly rather than silently
    // degrade dedup to "every send unique" — same invariant as every other
    // provider in this codebase.
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

    const body: AirbridgeEventBody = {
      eventUUID: deriveAirbridgeEventUUID(envelope.outboxEventId),
      eventTimestamp: Date.parse(envelope.occurredAt),
      device: { deviceUUID },
      app: { packageName: resolvePackageName(creds) },
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
