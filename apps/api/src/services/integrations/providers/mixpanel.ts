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
// Mixpanel's catalog/mapping is identical in shape to AMPLITUDE's (Task 5):
// the seven `subscription.*` RovenueEventType values are already spelled
// identically to their RovenueEventKey counterparts, so only revenue.* goes
// through the shared `deriveRevenueEventKey` helper. See amplitude.ts for
// the fuller rationale.
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
// distinct_id = $mixpanelDistinctId (an identified Mixpanel user, set via
// the host app calling Mixpanel's own identify()) ?? appUserId (the host
// app's own id, so events still join across a Rovenue subscriber even
// without an explicit Mixpanel identify() call) ?? subscriberId (the
// Rovenue-internal id, last resort so revenue is never silently dropped).
// Mixpanel requires distinct_id on every event (an empty string is
// accepted but excluded from behavioral analysis) — Rovenue never sends an
// event at all when no identity is resolvable (`no_user_data` skip) rather
// than degrade to an unattributed distinct_id.
// ---------------------------------------------------------------------------

function resolveDistinctId(envelope: RovenueEventEnvelope): string | undefined {
  const attrs = envelope.subscriberAttributes;
  return attrs?.["$mixpanelDistinctId"] ?? attrs?.["appUserId"] ?? envelope.subscriberId;
}

// Field ids mirror apps/dashboard's PROVIDER_CREDENTIAL_FIELDS.MIXPANEL
// (step-credentials.tsx) — the backend contract those inputs submit
// against. .catchall(z.string()) so unrelated extra string keys never fail
// validation, while keeping the inferred type Record<string, string>.
const credentialsSchema = z
  .object({
    service_account_username: z.string().min(1),
    service_account_secret: z.string().min(1),
    project_id: z.string().min(1),
    region: z.enum(["us", "eu"]).optional(),
  })
  .catchall(z.string());

// ---------------------------------------------------------------------------
// Endpoints — verified against Mixpanel's Import Events API reference
// (https://developer.mixpanel.com/reference/import-events, fetched
// 2026-08-24): event ingestion lives on `api.mixpanel.com/import` (default
// / US) or `api-eu.mixpanel.com/import` (EU data residency). Both require
// `strict` (validate the batch server-side, default "1") and `project_id`
// as query params.
// ---------------------------------------------------------------------------

const MIXPANEL_ENDPOINTS = {
  us: "https://api.mixpanel.com/import",
  eu: "https://api-eu.mixpanel.com/import",
} as const;

function resolveRegion(creds: ProviderCredentials): keyof typeof MIXPANEL_ENDPOINTS {
  return creds["region"] === "eu" ? "eu" : "us";
}

function buildImportUrl(creds: ProviderCredentials): string {
  const endpoint = MIXPANEL_ENDPOINTS[resolveRegion(creds)];
  const projectId = creds["project_id"] ?? "";
  return `${endpoint}?strict=1&project_id=${encodeURIComponent(projectId)}`;
}

function buildAuthHeader(creds: ProviderCredentials): string {
  const username = creds["service_account_username"] ?? "";
  const secret = creds["service_account_secret"] ?? "";
  return `Basic ${Buffer.from(`${username}:${secret}`).toString("base64")}`;
}

// Mixpanel requires distinct_id + $insert_id on every event, and disallows
// a small reserved list of sentinel values for distinct_id (see vendor
// docs' "high-level requirements") — "rovenue_credential_check" is not on
// that list. These constants satisfy that for the validateCredentials
// probe only; they are never used on the real delivery path (mapEvent
// always resolves a real subscriber identity).
const MIXPANEL_VALIDATION_DISTINCT_ID = "rovenue_credential_check";
const MIXPANEL_VALIDATION_EVENT_NAME = "Rovenue Credential Check";
// Stable (not per-call): unlike Amplitude, Mixpanel's docs do not specify a
// bounded dedup window for $insert_id, but a stable id still avoids writing
// a fresh event on every "Validate" click (Mixpanel dedupes on the tuple
// (event, time, distinct_id, $insert_id); a fixed distinct_id + insert_id
// pair collapses repeat probes to one indefinitely, not just within a
// documented window).
const MIXPANEL_VALIDATION_INSERT_ID = "rovenue-credential-probe";

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const mixpanelProvider: IntegrationProvider = {
  id: "MIXPANEL",

  topics: ["rovenue.revenue", "rovenue.subscription"],
  eventCatalog: STANDARD_PROVIDER_EVENT_KEYS,
  allowMultipleConnections: false,
  credentialsSchema,

  defaultEventMapping: DEFAULT_EVENT_MAPPING.MIXPANEL,

  async validateCredentials(
    creds: ProviderCredentials,
    http: HttpClient,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    // Mixpanel's /import has no dedicated credential-check endpoint. The
    // brief's zero-footprint alternative — POSTing an EMPTY events array —
    // was evaluated against the fetched vendor contract
    // (https://developer.mixpanel.com/reference/import-events) and
    // rejected: the documented request body schema states "Minimum array
    // length: 1", so an empty array is off-contract and its resulting
    // status is unspecified — it could plausibly return a 400 regardless
    // of whether the credentials are valid, which would defeat the whole
    // point of using the response to distinguish good/bad credentials.
    //
    // Instead this sends a single, clearly-tagged, strict-validated probe
    // event to the SAME ingestion endpoint. The docs draw a clean line
    // between auth and payload validation: `401 { error: "Invalid
    // credentials" }` is returned for bad service-account credentials,
    // independent of the `400` bucket used for per-event strict-validation
    // failures — so any 2xx here proves the credentials are both valid AND
    // scoped to the given project_id (a mismatched project_id also surfaces
    // as 401, since project_id participates in service-account auth), and
    // any non-2xx proves they are not. The probe uses a STABLE
    // distinct_id/$insert_id pair (MIXPANEL_VALIDATION_INSERT_ID) so
    // repeated "Validate" clicks collapse to one Mixpanel event via the
    // vendor's own (event, time, distinct_id, $insert_id) dedup rule
    // instead of writing a fresh event every time — this is disclosed to
    // the user in the dashboard drawer via PROVIDER_VALIDATE_NOTES.MIXPANEL
    // (step-credentials.tsx).
    const res = await http.request({
      method: "POST",
      url: buildImportUrl(creds),
      headers: {
        "content-type": "application/json",
        authorization: buildAuthHeader(creds),
      },
      body: JSON.stringify([
        {
          event: MIXPANEL_VALIDATION_EVENT_NAME,
          properties: {
            time: Date.now(),
            distinct_id: MIXPANEL_VALIDATION_DISTINCT_ID,
            $insert_id: MIXPANEL_VALIDATION_INSERT_ID,
          },
        },
      ]),
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
    // stamped into Mixpanel's `$insert_id`, which Mixpanel uses to dedupe
    // events sharing the same (event, time, distinct_id, $insert_id)
    // tuple). Fail loudly rather than silently degrade dedup to "every
    // send unique" — same invariant as amplitude.ts / meta-capi.ts /
    // tiktok-events.ts.
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
      providerId: "MIXPANEL",
      eventKey,
      enabledEvents: config.enabledEvents,
      override: config.eventMapping,
    });

    if (mappingResult.kind === "skip") {
      return { skip: true, reason: mappingResult.reason };
    }

    const distinctId = resolveDistinctId(envelope);
    if (!distinctId) {
      return { skip: true, reason: "no_user_data" };
    }

    const properties: Record<string, unknown> = {
      time: Date.parse(envelope.occurredAt),
      distinct_id: distinctId,
      $insert_id: envelope.outboxEventId,
      product_id: envelope.productId,
      rovenue_event: eventKey,
    };

    // Revenue fields only apply to revenue.* keys — sending them on a
    // subscription-lifecycle event would fabricate revenue for an event
    // that carries no money movement.
    if (eventKey.startsWith("revenue.")) {
      const amount = envelope.amount ? parseFloat(envelope.amount) : undefined;
      if (amount !== undefined && !isNaN(amount)) {
        // Mirrors Amplitude's REFUND sign convention (see amplitude.ts /
        // refund_amountusd_positive_convention): Rovenue's own `amount` is
        // stored POSITIVE for REFUND events — negate here, at the
        // Mixpanel wire boundary only, so a refund reads as negative
        // revenue in any downstream Mixpanel report that sums this
        // property, rather than anywhere upstream.
        const isRefund = eventKey === "revenue.REFUND";
        properties.amount = isRefund ? -amount : amount;
        if (envelope.currency) {
          properties.currency = envelope.currency;
        }
      }
    }

    return {
      eventKey,
      providerEvent: mappingResult.providerEvent,
      body: { event: mappingResult.providerEvent, properties },
    };
  },

  async deliver(
    payload: ProviderPayload,
    creds: ProviderCredentials,
    http: HttpClient,
  ): Promise<DeliveryResult> {
    const res = await http.request({
      method: "POST",
      url: buildImportUrl(creds),
      headers: {
        "content-type": "application/json",
        authorization: buildAuthHeader(creds),
      },
      body: JSON.stringify([payload.body]),
    });

    // Per Mixpanel's Import Events API reference: 429 (per-project rate
    // limiting) and the generic 5xx bucket are explicitly retriable. A 400
    // (strict-validation failure — the event itself is malformed) or 401
    // (invalid service-account credentials) is a permanent rejection of
    // this exact request and must NOT retry.
    const retriable = res.status === 429 || res.status >= 500;
    const ok = res.status >= 200 && res.status < 300;

    return {
      ok,
      httpStatus: res.status,
      responseBody: res.body,
      errorMessage: ok ? undefined : `mixpanel http ${res.status}`,
      retriable,
    };
  },
};
