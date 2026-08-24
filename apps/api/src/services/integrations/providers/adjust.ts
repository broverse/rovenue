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
// Same shape as AMPLITUDE/MIXPANEL/APPSFLYER (Tasks 5-7): the seven
// `subscription.*` RovenueEventType values are already spelled identically
// to their RovenueEventKey counterparts, so only revenue.* goes through the
// shared `deriveRevenueEventKey` helper.
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
// Default event mapping — DELIBERATELY EMPTY.
//
// PRE-FLIGHT RULING (ledgered, Task 8 controller context): Adjust event
// tokens are opaque, account-specific ids minted per-event in the Adjust
// dashboard (e.g. "f0ob4r") — there is no vendor-wide vocabulary to default
// to, unlike Amplitude/Mixpanel/AppsFlyer's own free-form or `af_`-prefixed
// event names. `eventCatalog` still lists the 13 revenue+subscription keys
// (it drives the drawer's mapping-step rows, letting a user configure a
// token per key); a key with no configured token falls through
// `applyEventMapping` to `{ kind: "skip", reason: "no_mapping" }` exactly
// like every other provider's genuinely-unmapped key — no special-casing
// needed here. The (empty) table itself lives in event-mapping.ts's
// DEFAULT_EVENT_MAPPING.ADJUST, the one copy applyEventMapping reads.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Credentials — field id mirrors apps/dashboard's
// PROVIDER_CREDENTIAL_FIELDS.ADJUST (step-credentials.tsx): a single
// `app_token` field. `.catchall(z.string())` so unrelated extra string keys
// never fail validation, while keeping the inferred type
// Record<string, string>.
// ---------------------------------------------------------------------------

const credentialsSchema = z
  .object({
    app_token: z.string().min(1),
  })
  .catchall(z.string());

// ---------------------------------------------------------------------------
// Endpoint
//
// Vendor-docs verification note: unlike AppsFlyer's blocked fetch attempts,
// Adjust's S2S events reference (https://help.adjust.com/en/article/
// server-to-server-events, fetched 2026-08-24) loaded successfully and
// confirms: POST https://s2s.adjust.com/event, Content-Type
// application/x-www-form-urlencoded for a body-parameter POST, required
// params app_token/event_token/s2s=1/one advertising id, optional
// revenue+currency ("Revenue event value in full currency units... Adjust's
// servers accept a minimum value of 0.001"; no distinction is drawn between
// a purchase and a refund — there is NO documented negative-revenue
// convention, so REFUND is sent POSITIVE, mirroring AppsFlyer's identical
// finding), created_at_unix (UNIX seconds — confirmed, not milliseconds),
// and callback_params (a URL-encoded JSON object of string key/value pairs,
// surfaced in Adjust's raw-data exports).
//
// One documented gap: the fetched reference does NOT enumerate a
// `deduplication_id` parameter — Adjust's own dedup story for S2S events is
// undocumented on this page. It is still sent per the Task 8 controller
// ruling's locked wire shape, as a top-level echo of the same
// `outboxEventId` already embedded in `callback_params.outbox_event_id`.
// An unrecognized top-level form field is expected to be silently ignored
// by Adjust's ingestion endpoint (the documented contract doesn't reject
// on unknown params), so this is a safe no-op if Adjust doesn't act on it.
// Rovenue's own dedup guarantees (outbox at-least-once + query-time
// idempotent ClickHouse views) do not depend on Adjust honoring this field.
// ---------------------------------------------------------------------------

const ADJUST_S2S_EVENT_ENDPOINT = "https://s2s.adjust.com/event";

// ---------------------------------------------------------------------------
// Device-id resolution (§ identity ladder)
//
// Adjust's S2S events API requires exactly one advertising/device id per
// event. Preference order: Rovenue's own `$adjustId` (the Adjust-generated
// `adid`, stable even with no IDFA/GAID) > `$idfa` (iOS) > `$gpsAdId`
// (Android). The ATT consent gate already strips idfa/gps_adid upstream in
// enrich-envelope.ts when consent is denied — this function does not
// re-implement that check, it only reads whatever attributes survived
// enrichment.
// ---------------------------------------------------------------------------

type DeviceIdField = "adid" | "idfa" | "gps_adid";

function resolveDeviceId(
  attrs: Record<string, string> | undefined,
): { field: DeviceIdField; value: string } | undefined {
  const adjustId = attrs?.["$adjustId"];
  if (adjustId) return { field: "adid", value: adjustId };

  const idfa = attrs?.["$idfa"];
  if (idfa) return { field: "idfa", value: idfa };

  const gpsAdId = attrs?.["$gpsAdId"];
  if (gpsAdId) return { field: "gps_adid", value: gpsAdId };

  return undefined;
}

// ---------------------------------------------------------------------------
// Wire body shape — form-encoded at deliver() time. `app_token` is a
// credential, not carried here (mirrors meta-capi.ts / appsflyer.ts keeping
// secrets out of mapEvent's returned body; deliver() reads it off `creds`).
// ---------------------------------------------------------------------------

interface AdjustWireBody {
  event_token: string;
  s2s: 1;
  adid?: string;
  idfa?: string;
  gps_adid?: string;
  revenue?: number;
  currency?: string;
  created_at_unix: number;
  callback_params: string;
  deduplication_id: string;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const adjustProvider: IntegrationProvider = {
  id: "ADJUST",

  topics: ["rovenue.revenue", "rovenue.subscription"],
  eventCatalog: STANDARD_PROVIDER_EVENT_KEYS,
  allowMultipleConnections: false,
  credentialsSchema,

  defaultEventMapping: DEFAULT_EVENT_MAPPING.ADJUST,

  // SHAPE-ONLY validation — same documented deviation as APPSFLYER. Adjust's
  // S2S events endpoint has no dedicated credential-check probe (it's a
  // write-only event-ingestion endpoint); there is no zero-footprint way to
  // prove an app_token is *correct* without sending a real, attributable
  // event with a real event_token. This only confirms the submitted
  // credentials are well-formed per credentialsSchema (app_token present);
  // the first real delivery is the live proof, surfaced via the
  // connection's Delivery Log. Disclosed in
  // apps/docs/content/docs/integrations/adjust.mdx — no
  // PROVIDER_VALIDATE_NOTES entry in the dashboard because nothing is
  // actually sent here.
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
    _creds: ProviderCredentials,
  ): MapEventResult {
    // outboxEventId is the SOLE provider-side idempotency boundary (it is
    // stamped into both `deduplication_id` and `callback_params.
    // outbox_event_id`) — same invariant as amplitude.ts / mixpanel.ts /
    // appsflyer.ts / meta-capi.ts.
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
      providerId: "ADJUST",
      eventKey,
      enabledEvents: config.enabledEvents,
      override: config.eventMapping,
    });

    if (mappingResult.kind === "skip") {
      return { skip: true, reason: mappingResult.reason };
    }

    const deviceId = resolveDeviceId(envelope.subscriberAttributes);
    if (!deviceId) {
      return { skip: true, reason: "no_user_data" };
    }

    const callbackParams: Record<string, unknown> = {
      rovenue_event: eventKey,
      outbox_event_id: envelope.outboxEventId,
    };
    if (envelope.productId) {
      callbackParams.product_id = envelope.productId;
    }

    const wire: AdjustWireBody = {
      // mappingResult.providerEvent IS the Adjust event token — this
      // provider has no vendor vocabulary of its own to translate through.
      event_token: mappingResult.providerEvent,
      s2s: 1,
      created_at_unix: Math.floor(new Date(envelope.occurredAt).getTime() / 1000),
      callback_params: JSON.stringify(callbackParams),
      deduplication_id: envelope.outboxEventId,
    };
    wire[deviceId.field] = deviceId.value;

    // Revenue fields only apply to revenue.* keys — sending them on a
    // subscription-lifecycle event would fabricate revenue for an event
    // that carries no money movement. No refund sign-flip (unlike
    // Amplitude/Mixpanel's documented negative-revenue convention):
    // Adjust's S2S revenue parameter has no documented convention for
    // representing a refund as negative revenue (see the endpoint comment
    // above), so `revenue` is sent as Rovenue's own POSITIVE stored amount
    // — same finding and same treatment as AppsFlyer.
    if (eventKey.startsWith("revenue.")) {
      const amount = envelope.amount ? parseFloat(envelope.amount) : undefined;
      if (amount !== undefined && !isNaN(amount)) {
        wire.revenue = amount;
        if (envelope.currency) {
          wire.currency = envelope.currency;
        }
      }
    }

    return {
      eventKey,
      providerEvent: mappingResult.providerEvent,
      body: wire,
    };
  },

  async deliver(
    payload: ProviderPayload,
    creds: ProviderCredentials,
    http: HttpClient,
  ): Promise<DeliveryResult> {
    const wire = payload.body as AdjustWireBody;
    const appToken = creds["app_token"] ?? "";

    const params = new URLSearchParams();
    params.set("app_token", appToken);
    params.set("event_token", wire.event_token);
    params.set("s2s", String(wire.s2s));
    if (wire.adid) params.set("adid", wire.adid);
    if (wire.idfa) params.set("idfa", wire.idfa);
    if (wire.gps_adid) params.set("gps_adid", wire.gps_adid);
    if (wire.revenue !== undefined) params.set("revenue", String(wire.revenue));
    if (wire.currency) params.set("currency", wire.currency);
    params.set("created_at_unix", String(wire.created_at_unix));
    params.set("callback_params", wire.callback_params);
    params.set("deduplication_id", wire.deduplication_id);

    const res = await http.request({
      method: "POST",
      url: ADJUST_S2S_EVENT_ENDPOINT,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    // Per the Task 8 brief's classification: 200 ok; 400 (malformed
    // request, e.g. missing event_token) / 401 / 403 (bad/forbidden
    // app_token) are permanent rejections of this exact request and must
    // NOT retry; 429/5xx are retriable.
    const retriable = res.status === 429 || res.status >= 500;
    const ok = res.status >= 200 && res.status < 300;

    return {
      ok,
      httpStatus: res.status,
      responseBody: res.body,
      errorMessage: ok ? undefined : `adjust http ${res.status}`,
      retriable,
    };
  },
};
