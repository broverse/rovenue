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
// deriveEventKey — identical pattern to amplitude.ts / mixpanel.ts /
// appsflyer.ts / adjust.ts / firebase-ga4.ts: the seven subscription.*
// RovenueEventType values are already spelled identically to their
// RovenueEventKey counterparts (see types.ts's compile-time bridge), so no
// per-key lookup table is needed for them — only revenue.* still goes
// through the shared `deriveRevenueEventKey` (kind -> `revenue.${kind}`).
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
// Credentials — field ids mirror apps/dashboard's PROVIDER_CREDENTIAL_FIELDS.
// BRAZE (step-credentials.tsx): rest_api_key + rest_endpoint. The endpoint
// is a two-phase ALLOWLIST — verified at connection-setup time
// (credentialsSchema's `.refine`) AND re-verified at delivery time
// (deliver() below), same shape as SLACK's `hooks.slack.com` check — rather
// than a blocklist, because Braze REST endpoints are a small, well-known
// family of regional cluster hosts
// (https://www.braze.com/docs/api/basics#endpoints: rest.iad-01.braze.com,
// rest.fra-02.braze.eu, etc.). BRAZE_ENDPOINT_HOST_RE matches that host
// SHAPE without hardcoding the full, growing cluster list, while staying
// fully anchored so an attacker-controlled suffix (e.g.
// "rest.iad-01.braze.com.evil.example") is rejected — `.host` is matched
// against `^...$`, not `.includes()`.
// ---------------------------------------------------------------------------

export const BRAZE_ENDPOINT_HOST_RE = /^rest\.[a-z0-9-]+\.braze\.(com|eu)$/;

export function isAllowedBrazeEndpoint(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && BRAZE_ENDPOINT_HOST_RE.test(url.host);
  } catch {
    return false;
  }
}

const BRAZE_ENDPOINT_ERROR_MESSAGE =
  "rest_endpoint must be an https:// URL on a rest.<cluster>.braze.com or rest.<cluster>.braze.eu host";

const credentialsSchema = z
  .object({
    rest_api_key: z.string().min(1),
    rest_endpoint: z.string().min(1),
  })
  .catchall(z.string())
  .refine((c) => isAllowedBrazeEndpoint(c.rest_endpoint), {
    message: BRAZE_ENDPOINT_ERROR_MESSAGE,
    path: ["rest_endpoint"],
  });

// ---------------------------------------------------------------------------
// Identity resolution — per the Task 4 brief: external_id =
// subscriberAttributes.appUserId ?? subscriberId; when appUserId is ABSENT
// and $brazeAliasName IS present, a user_alias identifier is sent INSTEAD
// of external_id. Braze's users/track "Identifier resolution" table
// documents external_id/user_alias/braze_id as mutually exclusive PRIMARY
// identifiers — including more than one on the same request object gets
// that object rejected — so this never sends both.
// ---------------------------------------------------------------------------

const BRAZE_ALIAS_LABEL = "rovenue";

type BrazeIdentity =
  | { external_id: string }
  | { user_alias: { alias_name: string; alias_label: string } };

function resolveIdentity(envelope: RovenueEventEnvelope): BrazeIdentity | undefined {
  const appUserId = envelope.subscriberAttributes?.["appUserId"];
  if (appUserId) {
    return { external_id: appUserId };
  }

  const aliasName = envelope.subscriberAttributes?.["$brazeAliasName"];
  if (aliasName) {
    return { user_alias: { alias_name: aliasName, alias_label: BRAZE_ALIAS_LABEL } };
  }

  if (envelope.subscriberId) {
    return { external_id: envelope.subscriberId };
  }

  return undefined;
}

// Braze's purchase object requires product_id/currency/price as non-null
// strings/numbers (https://www.braze.com/docs/api/objects_filters/
// purchase_object/) — these are the same-shaped fallbacks used elsewhere in
// this codebase (see the Task 6 Iterable brief's `productId ?? "unknown"`)
// for the rare case a revenue envelope lacks one.
const BRAZE_UNKNOWN_PRODUCT_ID = "unknown";
const BRAZE_DEFAULT_CURRENCY = "USD";

// ---------------------------------------------------------------------------
// validateCredentials — spec RULING (task-4-context.md, binding): a real
// users/track probe with a FIXED external_id + one tagged event is the ONLY
// check that proves "users.track" permission on the submitted rest_api_key.
// A read-only endpoint (were one even available) would false-negative on a
// key correctly scoped to users.track only, so no zero-footprint
// alternative is used — same reasoning as SLACK's real validate message,
// but landing on a single, REUSED (not per-call) profile instead of a
// human-visible channel post. Disclosed via PROVIDER_VALIDATE_NOTES.BRAZE
// (step-credentials.tsx) and the docs page: one deletable, MAU-countable
// probe profile is created and reused across re-validations — both the
// external_id and the event name below are STABLE constants, so repeat
// "Validate" clicks update the SAME profile/event rather than creating a
// new one (and a new MAU count) every time.
// ---------------------------------------------------------------------------

export const BRAZE_VALIDATION_EXTERNAL_ID = "rovenue-credential-probe";
const BRAZE_VALIDATION_EVENT_NAME = "rovenue_credential_check";

// ---------------------------------------------------------------------------
// Delivery response classification — per Braze's users/track reference
// (https://www.braze.com/docs/api/endpoints/user_data/post_user_track/,
// fetched 2026-08-25): a successful send returns 2xx (201, or 200/201 with
// a `{"message":"success", ...}` body — including the "successful message
// with non-fatal errors" shape, still 2xx). 400 is a malformed-request
// rejection of THIS payload (bad JSON, missing required purchase/event
// fields) and must not retry. 401/403 mean the rest_api_key is invalid or
// lacks the `users.track` permission — a permanent rejection of these
// credentials, not this one request. 429 (Braze documents per-second burst
// limits and per-account hourly limits, both surfaced as 429) and 5xx are
// the standard retriable shape used across every other Wave-1/Wave-2
// provider.
// ---------------------------------------------------------------------------

function classifyBrazeResponse(res: { status: number; body: string }): DeliveryResult {
  const { status } = res;
  const retriable = status === 429 || status >= 500;
  const ok = status >= 200 && status < 300;
  return {
    ok,
    httpStatus: status,
    responseBody: res.body,
    errorMessage: ok ? undefined : `braze http ${status}`,
    retriable,
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const brazeProvider: IntegrationProvider = {
  id: "BRAZE",

  topics: ["rovenue.revenue", "rovenue.subscription"],
  eventCatalog: STANDARD_PROVIDER_EVENT_KEYS,
  allowMultipleConnections: false,
  credentialsSchema,

  defaultEventMapping: DEFAULT_EVENT_MAPPING.BRAZE,

  async validateCredentials(
    creds: ProviderCredentials,
    http: HttpClient,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const restEndpoint = creds["rest_endpoint"] ?? "";
    if (!isAllowedBrazeEndpoint(restEndpoint)) {
      return { ok: false, reason: BRAZE_ENDPOINT_ERROR_MESSAGE };
    }
    const apiKey = creds["rest_api_key"] ?? "";

    const res = await http.request({
      method: "POST",
      url: `${restEndpoint}/users/track`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        events: [
          {
            external_id: BRAZE_VALIDATION_EXTERNAL_ID,
            name: BRAZE_VALIDATION_EVENT_NAME,
            time: new Date().toISOString(),
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
    // outboxEventId rides `properties.outbox_event_id` on both the purchases
    // and events wire shapes below — the provider-side idempotency boundary
    // Braze itself has no server-side dedup key for (unlike Amplitude's
    // insert_id). Fail loudly rather than silently ship without it.
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
      providerId: "BRAZE",
      eventKey,
      enabledEvents: config.enabledEvents,
      override: config.eventMapping,
    });

    if (mappingResult.kind === "skip") {
      return { skip: true, reason: mappingResult.reason };
    }

    const identity = resolveIdentity(envelope);
    if (!identity) {
      return { skip: true, reason: "no_user_data" };
    }

    const time = new Date(envelope.occurredAt).toISOString();
    const properties = {
      rovenue_event: eventKey,
      outbox_event_id: envelope.outboxEventId,
    };

    if (eventKey.startsWith("revenue.")) {
      const amount = envelope.amount ? parseFloat(envelope.amount) : undefined;
      const price = amount !== undefined && !isNaN(amount) ? amount : 0;

      return {
        eventKey,
        providerEvent: mappingResult.providerEvent,
        body: {
          purchases: [
            {
              ...identity,
              product_id: envelope.productId ?? BRAZE_UNKNOWN_PRODUCT_ID,
              currency: envelope.currency ?? BRAZE_DEFAULT_CURRENCY,
              price,
              time,
              properties,
            },
          ],
        },
      };
    }

    return {
      eventKey,
      providerEvent: mappingResult.providerEvent,
      body: {
        events: [
          {
            ...identity,
            name: mappingResult.providerEvent,
            time,
            properties,
          },
        ],
      },
    };
  },

  async deliver(
    payload: ProviderPayload,
    creds: ProviderCredentials,
    http: HttpClient,
  ): Promise<DeliveryResult> {
    const restEndpoint = creds["rest_endpoint"] ?? "";
    // Re-run the SAME allowlist check as credentialsSchema at send time —
    // the two-phase check the brief calls for (identical shape to SLACK's
    // deliver()), so a connection row that somehow ended up with a
    // mutated/invalid rest_endpoint can never reach the network.
    if (!isAllowedBrazeEndpoint(restEndpoint)) {
      return {
        ok: false,
        httpStatus: 0,
        responseBody: "",
        errorMessage: `rest_endpoint failed host allowlist check (${BRAZE_ENDPOINT_ERROR_MESSAGE})`,
        retriable: false,
      };
    }
    const apiKey = creds["rest_api_key"] ?? "";

    const res = await http.request({
      method: "POST",
      url: `${restEndpoint}/users/track`,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(payload.body),
    });

    return classifyBrazeResponse(res);
  },
};
