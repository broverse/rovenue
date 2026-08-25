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
// deriveEventKey — identical pattern to every other Wave-1/Wave-2 provider:
// the seven subscription.* RovenueEventType values are already spelled
// identically to their RovenueEventKey counterparts, so only revenue.* still
// goes through the shared `deriveRevenueEventKey`.
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
// Credentials — `sdk_key` (Singular's own "SDK Key", retrieved from
// Singular UI → Developer Tools → SDK Integration → SDK Keys — explicitly
// NOT the Reporting API Key, which the vendor's own docs say gets requests
// rejected) plus `app_id` (the app's OS bundle id / package name, sent as
// the wire's required `i` parameter — see "Wire contract" below).
//
// CORRECTION (post-review, 2026-08-25): `app_id` was originally left out of
// this schema per the Task 8 controller context's field lock, with the gap
// documented rather than fixed. That was wrong — `i` is a genuinely
// required Singular parameter with no other honest source, so omitting it
// made every real delivery fail permanently (`missing argument: i`). The
// field lock exists to prevent drift, not to freeze a provably-broken
// contract; this is now the corrected, binding credential shape.
//
// `.catchall(z.string())` so unrelated extra string keys never fail
// validation, while keeping the inferred type Record<string, string>.
// ---------------------------------------------------------------------------

const credentialsSchema = z
  .object({
    sdk_key: z.string().min(1),
    app_id: z.string().min(1),
  })
  .catchall(z.string());

// ---------------------------------------------------------------------------
// Endpoint + wire contract — verified against Singular's own first-party
// support docs, fetched 2026-08-25:
//   - "Server-to-Server - EVENT Endpoint API Reference"
//     (support.singular.net/hc/en-us/articles/31496864868635)
//   - "Server-to-Server - Fundamentals"
//     (support.singular.net/hc/en-us/articles/360037640812)
//   - "Server-to-Server - API Response Codes & Errors"
//     (support.singular.net/hc/en-us/articles/31542603988379)
//   - "Singular Standard Events: Full List"
//     (support.singular.net/hc/en-us/articles/7648172966299)
// Sourcing note: support.singular.net's own Zendesk front door 403'd every
// direct fetch attempt from this environment (the same bot-wall shape
// AIRBRIDGE's/APPSFLYER's sourcing notes describe) — the content above was
// retrieved through a plain-text reader proxy (r.jina.ai) that returns the
// SAME server-rendered article body, confirmed by each page's own title and
// canonical URL matching the requested article. This is still first-party
// vendor documentation, just retrieved through a mirror rather than a
// direct connection, same class of workaround AIRBRIDGE's help-center note
// already established as acceptable.
//
// DIVERGENCE FROM THE TASK BRIEF'S "EXPECTED" SHAPE — verified, not assumed:
// Singular introduced a versioned EVENT endpoint split on July 15, 2026
// (six weeks before this fetch): V1 (legacy, platform ad-id based:
// idfa/idfv/aifa/asid/amid/oaid/andi) stays available for existing
// integrations, while V2 (`sdid`-based, "eliminates need for AIFA, ASID,
// IDFA, IDFV parameters") is now the *recommended* path and mandatory for
// new accounts. This lines up exactly with the task's device ladder, whose
// TOP preference is `$singularDeviceId` (Singular's own Device ID / SDID)
// ahead of `$idfa`/`$gpsAdId` — so this provider routes to V2 when a SDID is
// present and only falls back to the documented V1 identifiers otherwise,
// rather than forcing every event through V1 (which has no field at all for
// a generic "Singular device id").
//   - V2: `POST https://s2s.singular.net/api/v2/evt`, device field `sdid`.
//   - V1: `POST https://s2s.singular.net/api/v1/evt`, device field `idfa`
//     (iOS) or `aifa` (Android's Google Advertising ID, despite the name).
//
// A second, more consequential divergence: the brief's "expected" shape
// pictured the SDK key riding the query string (hence this task's binding
// SECRET-IN-QUERY constraint, honored defensively below regardless). The
// EVENT Endpoint API Reference's own Python example is unambiguous —
// `requests.post(url, data=params, headers={'Content-Type':
// 'application/x-www-form-urlencoded'})` — and the reference states plainly:
// "All parameters must be sent as application/x-www-form-urlencoded data in
// the request body using the POST method... Do not send parameters in a
// JSON request body." The SDK key (`a`) is therefore a FORM-BODY field, not
// a query parameter, for the current EVENT contract on both endpoint
// versions — this provider never constructs a query string at all.
// ---------------------------------------------------------------------------

const SINGULAR_V1_EVENT_ENDPOINT = "https://s2s.singular.net/api/v1/evt";
const SINGULAR_V2_EVENT_ENDPOINT = "https://s2s.singular.net/api/v2/evt";

// ---------------------------------------------------------------------------
// KNOWN GAPS (documented, not silently swallowed):
//
//   - `i` (app identifier / bundle id): RESOLVED (post-review, 2026-08-25) —
//     sourced from the `app_id` credential above and sent on every event.
//     Previously omitted with the gap merely disclosed; that was corrected
//     because `i` is genuinely required and had no other honest source.
//   - `ip`: NOT solved by the documented `use_ip=true` escape hatch — that
//     instructs Singular to read the IP off the HTTP request, which for a
//     server-to-server relay would attribute the event to ROVENUE'S OWN
//     dispatcher IP, not the end subscriber's device, corrupting
//     geolocation-based attribution. Sent only when a real subscriber IP is
//     available via `identityContext.ip`; omitted (never `use_ip`)
//     otherwise, for the same "never fabricate" reasoning as the currency
//     ruling below. This stance stands after review, but its practical
//     consequence is disclosed rather than left implicit: most
//     server/webhook-driven revenue events (no client HTTP request in the
//     loop) carry no known subscriber IP, so `ip` is frequently omitted and
//     Singular's EVENT endpoint may reject with `missing argument: ip` for
//     exactly that class of event. A customer who wants these attributed
//     should pass `identityContext.ip` on their own `POST /v1/events` calls
//     (apps/api/src/routes/v1/events.ts's `identityContextSchema` already
//     accepts it) — documented in singular.mdx.
//   - `att_authorization_status`: CORRECTED characterization (post-review,
//     2026-08-25) — Singular's EVENT Endpoint Reference documents this as
//     "Always required" for iOS ("Even if ATT is not implemented, pass 0
//     (undetermined)"), not optional context as a prior version of this
//     comment stated. Rovenue still does not fabricate a value: it is sent
//     only when the subscriber's own `$attConsentStatus` reserved attribute
//     is present (mapped to Singular's numeric codes below), and only on
//     the ladder's iOS branch; absent, this stays an honestly-documented
//     gap rather than a guessed `0`. Device-make/model/locale/build
//     enrichment (`ve`/`ma`/`mo`/`lc`/`bd`) remains a scoped-out follow-up.
// ---------------------------------------------------------------------------

// Singular's numeric ATT status codes (EVENT Endpoint API Reference,
// "Application Parameters" > `att_authorization_status`), in the SAME order
// as the (unexported) `ATT_CONSENT` list in
// packages/shared/src/attributes/catalog.ts that validates
// `$attConsentStatus` values — so a value that passed attribute validation
// is guaranteed to have a mapping here.
const SINGULAR_ATT_STATUS_BY_CONSENT: Readonly<Record<string, string>> = {
  notDetermined: "0",
  restricted: "1",
  denied: "2",
  authorized: "3",
};

// ---------------------------------------------------------------------------
// SECRET-IN-QUERY CONSTRAINT (spec-binding, Task 8 controller context) —
// even though the verified current wire contract keeps the SDK key in the
// POST body (see the divergence note above, not the query string the brief
// pictured), this provider still never constructs a URL containing the SDK
// key or any request parameter: `deliver()` always POSTs to the bare
// endpoint constant, and every dynamic value (sdk_key, device id, event
// name, revenue amount) lives ONLY in the URLSearchParams-encoded request
// body. DeliveryResult never carries the request URL or the raw sdk_key —
// it is built solely from Singular's own HTTP status and response body
// (classifySingularResponse below), so no code path here can leak either
// into a delivery log, error message, or test assertion. A dedicated test
// asserts this for both the ok and error branches.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Device-id resolution (§ identity ladder, locked): $singularDeviceId (SDID,
// routes to the V2 endpoint) -> $idfa (V1, param `idfa`, iOS) -> $gpsAdId
// (V1, param `aifa` — Android's Google Advertising ID, despite the
// Apple-sounding name) -> skip `no_user_data`. The ATT consent gate already
// strips idfa/gps ad ids upstream in enrich-envelope.ts when consent is
// denied — this function does not re-check consent, it only reads whatever
// attributes survived enrichment.
//
// `platform` is derived, never guessed: it is certain for the idfa/aifa
// branches (iOS/Android respectively, straight from which platform-specific
// identifier matched) and best-effort from the subscriber's own `platform`
// attribute for the SDID branch (Singular's V2 device id is platform-
// agnostic — iOS, Android, Web, PC, console). When SDID is present but the
// platform attribute is absent or unrecognized, `platform` is left
// undefined and the wire's `p` parameter is simply omitted rather than
// fabricated — the same "never guess" principle as the currency ruling.
// ---------------------------------------------------------------------------

type SingularPlatform = "iOS" | "Android" | "Web";

interface SingularDeviceResolution {
  endpoint: string;
  deviceField: "sdid" | "idfa" | "aifa";
  deviceValue: string;
  platform?: SingularPlatform;
}

function resolvePlatformAttribute(
  attrs: Record<string, string> | undefined,
): SingularPlatform | undefined {
  const raw = attrs?.["platform"];
  if (raw === "ios") return "iOS";
  if (raw === "android") return "Android";
  if (raw === "web") return "Web";
  return undefined;
}

function resolveSingularDevice(
  envelope: RovenueEventEnvelope,
): SingularDeviceResolution | undefined {
  const attrs = envelope.subscriberAttributes;

  const singularDeviceId = attrs?.["$singularDeviceId"];
  if (singularDeviceId) {
    return {
      endpoint: SINGULAR_V2_EVENT_ENDPOINT,
      deviceField: "sdid",
      deviceValue: singularDeviceId,
      platform: resolvePlatformAttribute(attrs),
    };
  }

  const idfa = attrs?.["$idfa"];
  if (idfa) {
    return {
      endpoint: SINGULAR_V1_EVENT_ENDPOINT,
      deviceField: "idfa",
      deviceValue: idfa,
      platform: "iOS",
    };
  }

  const gpsAdId = attrs?.["$gpsAdId"];
  if (gpsAdId) {
    return {
      endpoint: SINGULAR_V1_EVENT_ENDPOINT,
      deviceField: "aifa",
      deviceValue: gpsAdId,
      platform: "Android",
    };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// CROSS-PROVIDER CURRENCY RULING (binding for every Wave-2 provider): never
// fabricate a currency. Singular's own EVENT Endpoint Reference documents
// `amt`/`cur` as a pair ("Use in conjunction with" each other) with no
// validation-failure language tied to a missing currency specifically — but
// per the AIRBRIDGE/ONESIGNAL precedent this provider omits BOTH `amt` and
// `cur` together whenever amount is absent, currency is absent, or amount is
// unparseable, rather than guess. The event itself is still forwarded (with
// `is_revenue_event=true`) — Singular's own docs explicitly support this:
// "To mark a revenue event that has no amount, send is_revenue_event=true."
// ---------------------------------------------------------------------------

function resolveRevenueFields(
  envelope: RovenueEventEnvelope,
): { amt: string; cur: string } | Record<string, never> {
  if (!envelope.amount || !envelope.currency) {
    return {};
  }
  const amount = parseFloat(envelope.amount);
  if (isNaN(amount)) {
    return {};
  }
  return { amt: String(amount), cur: envelope.currency };
}

// ---------------------------------------------------------------------------
// Wire body shape — form-urlencoded at deliver() time. `sdk_key` is a
// credential, not carried here (mirrors adjust.ts / meta-capi.ts keeping
// secrets out of mapEvent's returned body; deliver() reads it off `creds`).
// `endpoint` rides alongside the fields because the V1/V2 choice is made in
// mapEvent (it depends on which device id matched), not in deliver().
// ---------------------------------------------------------------------------

interface SingularPayloadBody {
  endpoint: string;
  fields: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Delivery response classification — verified against Singular's own
// "S2S API Response Codes & Errors" reference, which documents an
// architecture different from a typical REST API's HTTP-status-only
// signaling: "all responses return HTTP 200 status codes, requiring
// validation of the response body's 'status' field to determine success
// ('ok') or failure ('error')". A non-200 HTTP status is documented as an
// infrastructure/edge issue (429 rate-limit, 5xx gateway errors), always
// retriable in the vendor's own guidance.
//
// This provider honors that body-status contract as the primary signal, and
// keeps the codebase's usual HTTP-status fallback (400/401/403
// non-retriable, 429/5xx retriable) only as a defensive backstop for a
// non-200 response the documented architecture doesn't actually predict
// (e.g. a WAF/edge layer in front of the endpoint) — consistent with every
// other provider's classifier here, never trusted over the body when a body
// is present.
//
// The non-retryable/retryable reason-keyword split is Singular's OWN
// documented classification, taken verbatim from its response-codes
// article's Python sample: `missing argument: {param}`, `invalid platform:
// {platform}`, `no device ID supplied`, and `platform: {platform} should
// have an {identifier} param` are all permanent, non-retriable request
// errors; anything else with a body-level "error" status is treated as
// retriable (the vendor's own "Decision Logic" note: errors NOT matching
// one of these patterns are the ones it expects a caller to retry).
// ---------------------------------------------------------------------------

const SINGULAR_NON_RETRYABLE_REASON_KEYWORDS = [
  "invalid",
  "missing",
  "should have",
  "no device id",
] as const;

function isNonRetryableSingularReason(reason: string): boolean {
  const lower = reason.toLowerCase();
  return SINGULAR_NON_RETRYABLE_REASON_KEYWORDS.some((keyword) =>
    lower.includes(keyword),
  );
}

interface SingularResponseBody {
  status?: string;
  reason?: string;
}

function classifySingularResponse(res: {
  status: number;
  body: string;
}): DeliveryResult {
  const { status, body } = res;

  if (status === 200) {
    let parsed: SingularResponseBody = {};
    try {
      parsed = JSON.parse(body) as SingularResponseBody;
    } catch {
      // A 200 with a body that isn't the documented JSON shape is treated
      // conservatively as a retriable failure rather than a false "ok".
      return {
        ok: false,
        httpStatus: status,
        responseBody: body,
        errorMessage: "singular: unparseable 200 response body",
        retriable: true,
      };
    }

    if (parsed.status === "ok") {
      return { ok: true, httpStatus: status, responseBody: body, retriable: false };
    }

    const reason = parsed.reason ?? "";
    return {
      ok: false,
      httpStatus: status,
      responseBody: body,
      errorMessage: `singular error: ${reason || "unknown"}`,
      retriable: !isNonRetryableSingularReason(reason),
    };
  }

  // Non-200 — not the documented shape (see the classifier comment above);
  // treated with the same defensive HTTP-status fallback every other
  // provider in this codebase uses.
  const retriable = status === 429 || status >= 500;
  return {
    ok: false,
    httpStatus: status,
    responseBody: body,
    errorMessage: `singular http ${status}`,
    retriable,
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const singularProvider: IntegrationProvider = {
  id: "SINGULAR",

  topics: ["rovenue.revenue", "rovenue.subscription"],
  eventCatalog: STANDARD_PROVIDER_EVENT_KEYS,
  allowMultipleConnections: false,
  credentialsSchema,

  defaultEventMapping: DEFAULT_EVENT_MAPPING.SINGULAR,

  // SHAPE-ONLY validation — same documented deviation as APPSFLYER/ADJUST/
  // AIRBRIDGE, and for an even stronger reason here: Singular's own S2S
  // Fundamentals guide states plainly that "Device-level data cannot be
  // deleted after ingestion — validate before sending", and its EVENT/
  // SESSION endpoints are the ONLY endpoints reachable with an `sdk_key`
  // (the separate, differently-scoped Reporting API Key is explicitly
  // rejected by these endpoints per the vendor's own docs) — there is no
  // zero-footprint, read-only way to confirm an `sdk_key`/`app_id` pair is
  // valid without sending a real, PERMANENT, attributable event. This only
  // confirms the submitted credentials are well-formed per
  // credentialsSchema; the first real delivery is the live proof, surfaced
  // via the connection's Delivery Log. Disclosed in
  // apps/docs/content/docs/integrations/singular.mdx — no
  // PROVIDER_VALIDATE_NOTES entry is added in the dashboard because nothing
  // is actually sent here.
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
    // outboxEventId is the SOLE provider-side idempotency boundary — Singular
    // itself documents "No Deduplication—implement server-side
    // deduplication", so it rides only the `e` custom-attributes JSON below
    // as debugging/reconciliation metadata; Rovenue's own outbox
    // at-least-once + query-time idempotent ClickHouse views remain the real
    // dedup guarantee, unaffected by whether Singular reads this field.
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
      providerId: "SINGULAR",
      eventKey,
      enabledEvents: config.enabledEvents,
      override: config.eventMapping,
    });

    if (mappingResult.kind === "skip") {
      return { skip: true, reason: mappingResult.reason };
    }

    const device = resolveSingularDevice(envelope);
    if (!device) {
      return { skip: true, reason: "no_user_data" };
    }

    const fields: Record<string, string> = {
      n: mappingResult.providerEvent,
      [device.deviceField]: device.deviceValue,
    };
    if (device.platform) {
      fields.p = device.platform;
    }
    const ip = envelope.identityContext?.ip;
    if (ip) {
      fields.ip = ip;
    }

    // att_authorization_status — "Always required" for iOS per Singular's
    // own docs, but never fabricated: sent only when the subscriber's own
    // $attConsentStatus is present, on the iOS branch of the ladder. See
    // the KNOWN GAPS comment above for the full citation.
    if (device.platform === "iOS") {
      const consentStatus = envelope.subscriberAttributes?.["$attConsentStatus"];
      const attStatus = consentStatus
        ? SINGULAR_ATT_STATUS_BY_CONSENT[consentStatus]
        : undefined;
      if (attStatus) {
        fields.att_authorization_status = attStatus;
      }
    }

    // Revenue fields only apply to revenue.* keys — sending them on a
    // subscription-lifecycle event would fabricate revenue for an event
    // that carries no money movement, same invariant as every other
    // provider here.
    if (eventKey.startsWith(REVENUE_EVENT_KEY_PREFIX)) {
      fields.is_revenue_event = "true";
      const revenueFields = resolveRevenueFields(envelope);
      if ("amt" in revenueFields) {
        fields.amt = revenueFields.amt;
        fields.cur = revenueFields.cur;
      }
    }

    fields.e = JSON.stringify({
      outbox_event_id: envelope.outboxEventId,
      rovenue_event: eventKey,
    });

    return {
      eventKey,
      providerEvent: mappingResult.providerEvent,
      body: { endpoint: device.endpoint, fields } satisfies SingularPayloadBody,
    };
  },

  async deliver(
    payload: ProviderPayload,
    creds: ProviderCredentials,
    http: HttpClient,
  ): Promise<DeliveryResult> {
    const { endpoint, fields } = payload.body as SingularPayloadBody;
    const sdkKey = creds["sdk_key"] ?? "";
    const appId = creds["app_id"] ?? "";

    // SECRET-IN-QUERY CONSTRAINT: `endpoint` is always the bare constant
    // (never interpolated with sdk_key or any field) — every dynamic value,
    // including the SDK key, goes ONLY into the form-urlencoded POST body
    // below. See the module-level comment for the full rationale.
    const params = new URLSearchParams();
    params.set("a", sdkKey);
    params.set("i", appId);
    for (const [key, value] of Object.entries(fields)) {
      params.set(key, value);
    }

    const res = await http.request({
      method: "POST",
      url: endpoint,
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    return classifySingularResponse(res);
  },
};
