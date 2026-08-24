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
// Amplitude (unlike Meta CAPI / TikTok Events) forwards the full Wave-1
// subscription-lifecycle set, not just trial-started + identified. Those
// seven `subscription.*` RovenueEventType values are already spelled
// identically to their RovenueEventKey counterparts (see types.ts /
// packages/shared/src/integrations.ts), so no per-key mapping table is
// needed here — only revenue.* still goes through the shared
// `deriveRevenueEventKey` (kind -> `revenue.${kind}`) helper.
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
// Identity resolution
// ---------------------------------------------------------------------------
//
// user_id = $amplitudeUserId (an identified Amplitude user) ?? appUserId
// (the host app's own id, so events still join across a Rovenue subscriber
// even without an explicit Amplitude identify() call) ?? subscriberId (the
// Rovenue-internal id, last resort so revenue is never silently dropped).
// device_id is populated only when the host app called
// setAttributes({"$amplitudeDeviceId": ...}) — Amplitude derives its own
// hashed device id from user_id when device_id is omitted (see vendor
// docs), so omitting it here is not a data-loss risk.
// ---------------------------------------------------------------------------

function resolveUserId(envelope: RovenueEventEnvelope): string | undefined {
  const attrs = envelope.subscriberAttributes;
  return attrs?.["$amplitudeUserId"] ?? attrs?.["appUserId"] ?? envelope.subscriberId;
}

function resolveDeviceId(envelope: RovenueEventEnvelope): string | undefined {
  return envelope.subscriberAttributes?.["$amplitudeDeviceId"];
}

// ---------------------------------------------------------------------------
// Default event mapping + catalog
// ---------------------------------------------------------------------------
//
// Both come from single sources rather than a per-provider copy: the vendor
// event names from event-mapping.ts's DEFAULT_EVENT_MAPPING (the ONLY copy
// any runtime path — applyEventMapping — has ever read), and the offered key
// set from @rovenue/shared's STANDARD_PROVIDER_EVENT_KEYS, which the dashboard
// drawer's event picker reads too. The names' per-key rationale lives with
// the mapping table in event-mapping.ts.

// Field ids mirror apps/dashboard's PROVIDER_CREDENTIAL_FIELDS.AMPLITUDE
// (step-credentials.tsx) — the backend contract those inputs submit
// against. .catchall(z.string()) so unrelated extra string keys never fail
// validation, while keeping the inferred type Record<string, string>.
const credentialsSchema = z
  .object({
    api_key: z.string().min(1),
    region: z.enum(["us", "eu"]).optional(),
  })
  .catchall(z.string());

// ---------------------------------------------------------------------------
// Endpoints — verified against Amplitude's HTTP API v2 reference
// (https://amplitude.com/docs/apis/analytics/http-v2, fetched 2026-08-24):
// event ingestion lives on `api2.amplitude.com` (default / US) or
// `api.eu.amplitude.com` (EU data residency) at path `/2/httpapi`. Other
// Amplitude APIs use different hostnames — this is specifically the
// ingestion host.
// ---------------------------------------------------------------------------

const AMPLITUDE_ENDPOINTS = {
  us: "https://api2.amplitude.com/2/httpapi",
  eu: "https://api.eu.amplitude.com/2/httpapi",
} as const;

function resolveRegion(creds: ProviderCredentials): keyof typeof AMPLITUDE_ENDPOINTS {
  return creds["region"] === "eu" ? "eu" : "us";
}

// Amplitude requires user_id/device_id to be >= 5 chars (or the event is
// silently stripped of that id, then may 400 if neither remains) — these
// constants satisfy that for the validateCredentials probe only; they are
// never used on the real delivery path (mapEvent always resolves a real
// subscriber identity).
const AMPLITUDE_VALIDATION_USER_ID = "rovenue_credential_check";
const AMPLITUDE_VALIDATION_EVENT_TYPE = "[Rovenue] Credential Check";
// Stable (not per-call) so repeated "Validate" clicks against the same
// project dedupe within Amplitude's documented 7-day insert_id window
// instead of writing a fresh event every time.
const AMPLITUDE_VALIDATION_INSERT_ID = "rovenue-credential-probe";

const AMPLITUDE_QUANTITY = 1;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const amplitudeProvider: IntegrationProvider = {
  id: "AMPLITUDE",

  topics: ["rovenue.revenue", "rovenue.subscription"],
  eventCatalog: STANDARD_PROVIDER_EVENT_KEYS,
  allowMultipleConnections: false,
  credentialsSchema,

  defaultEventMapping: DEFAULT_EVENT_MAPPING.AMPLITUDE,

  async validateCredentials(
    creds: ProviderCredentials,
    http: HttpClient,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    // Amplitude's HTTP API v2 has no dedicated credential-check endpoint
    // (unlike Meta's GET .../{pixel}?access_token= or GA4's /debug/mp/
    // collect). Per the vendor docs, an invalid api_key is rejected with
    // `400 { error: "Invalid API key" }` before any per-event validation
    // runs, so probing the SAME ingestion endpoint proves the key either
    // way: 2xx means it was accepted, any non-2xx means it was rejected.
    //
    // Evaluated (post-review) switching to the brief's zero-footprint
    // alternative — `{ api_key, events: [] }` — against the fetched vendor
    // contract (https://amplitude.com/docs/apis/analytics/http-v2): the
    // docs document `events` as a required array but do NOT specify
    // whether an empty (present, zero-length) array is accepted as a valid
    // request shape or rejected up-front as `"Request missing required
    // field"` before the api_key is even checked — that distinction is
    // exactly what determines whether an empty probe can tell a good key
    // from a bad one. With no documented answer and no side-effect-free
    // way to test it against the real API from here, switching would be a
    // gamble on unverified behavior. Kept the one-event probe instead, but
    // it now writes to a project-wide STABLE insert_id
    // (AMPLITUDE_VALIDATION_INSERT_ID) so repeated "Validate" clicks
    // dedupe within Amplitude's 7-day insert_id window rather than
    // appending a fresh event on every click — this is disclosed to the
    // user in the dashboard drawer via PROVIDER_VALIDATE_NOTES.AMPLITUDE
    // (step-credentials.tsx).
    const apiKey = creds["api_key"] ?? "";
    const url = AMPLITUDE_ENDPOINTS[resolveRegion(creds)];
    const res = await http.request({
      method: "POST",
      url,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        api_key: apiKey,
        events: [
          {
            user_id: AMPLITUDE_VALIDATION_USER_ID,
            event_type: AMPLITUDE_VALIDATION_EVENT_TYPE,
            insert_id: AMPLITUDE_VALIDATION_INSERT_ID,
          },
        ],
      }),
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
    // outboxEventId is the SOLE provider-side idempotency boundary (it is
    // stamped into Amplitude's `insert_id`, which Amplitude uses to ignore
    // duplicate events sent for the same device within a 7-day window).
    // Fail loudly rather than silently degrade dedup to "every send
    // unique" — same invariant as meta-capi.ts / tiktok-events.ts.
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
      providerId: "AMPLITUDE",
      eventKey,
      enabledEvents: config.enabledEvents,
      override: config.eventMapping,
    });

    if (mappingResult.kind === "skip") {
      return { skip: true, reason: mappingResult.reason };
    }

    const userId = resolveUserId(envelope);
    if (!userId) {
      return { skip: true, reason: "no_user_data" };
    }

    const body: Record<string, unknown> = {
      user_id: userId,
      event_type: mappingResult.providerEvent,
      time: Date.parse(envelope.occurredAt),
      insert_id: envelope.outboxEventId,
      event_properties: {
        rovenue_event: eventKey,
        product_id: envelope.productId,
      },
      quantity: AMPLITUDE_QUANTITY,
    };

    const deviceId = resolveDeviceId(envelope);
    if (deviceId) {
      body.device_id = deviceId;
    }

    // Revenue fields only apply to revenue.* keys — sending them on a
    // subscription-lifecycle event would fabricate revenue in Amplitude's
    // revenue reports for an event that carries no money movement.
    if (eventKey.startsWith("revenue.")) {
      const amount = envelope.amount ? parseFloat(envelope.amount) : undefined;
      if (amount !== undefined && !isNaN(amount)) {
        // Amplitude convention (vendor docs): both `price` and `revenue`
        // accept negative values specifically to represent a refund.
        // Rovenue's own `amount` is stored POSITIVE for REFUND events (see
        // refund_amountusd_positive_convention) — negate here, at the
        // Amplitude wire boundary only, rather than anywhere upstream.
        const isRefund = eventKey === "revenue.REFUND";
        const signedAmount = isRefund ? -amount : amount;
        body.revenue = signedAmount;
        body.price = signedAmount;
        body.revenueType = eventKey;
        if (envelope.currency) {
          body.currency = envelope.currency;
        }
      }
    }

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
    const apiKey = creds["api_key"] ?? "";
    const url = AMPLITUDE_ENDPOINTS[resolveRegion(creds)];

    const res = await http.request({
      method: "POST",
      url,
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: apiKey, events: [payload.body] }),
    });

    // Per Amplitude's HTTP API v2 reference: 413 (payload too large) and
    // 429 (per-device/user throttling — "pause ... then retry") are both
    // explicitly retriable, alongside the generic 5xx bucket (500/502/503/
    // 504). A 400 (including "Invalid API key") or 403 (WAF block) is a
    // permanent rejection of this exact request and must NOT retry.
    const retriable = res.status === 413 || res.status === 429 || res.status >= 500;
    const ok = res.status >= 200 && res.status < 300;

    return {
      ok,
      httpStatus: res.status,
      responseBody: res.body,
      errorMessage: ok ? undefined : `amplitude http ${res.status}`,
      retriable,
    };
  },
};
