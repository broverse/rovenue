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
// deriveEventKey — identical pattern to braze.ts / onesignal.ts / amplitude.ts
// / mixpanel.ts / appsflyer.ts / adjust.ts / firebase-ga4.ts: the seven
// subscription.* RovenueEventType values are already spelled identically to
// their RovenueEventKey counterparts, so only revenue.* still goes through
// the shared `deriveRevenueEventKey` (kind -> `revenue.${kind}`).
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
// ITERABLE (step-credentials.tsx, locked in the Task 2 controller context):
// api_key (secret) + optional region. .catchall(z.string()) so unrelated
// extra string keys never fail validation, while keeping the inferred type
// Record<string, string>.
// ---------------------------------------------------------------------------

const credentialsSchema = z
  .object({
    api_key: z.string().min(1),
    region: z.enum(["us", "eu"]).optional(),
  })
  .catchall(z.string());

// ---------------------------------------------------------------------------
// Endpoints — Iterable's REST API is split by data-residency region, same
// shape as AMPLITUDE/MIXPANEL: `api.iterable.com` (default / US) or
// `api.eu.iterable.com` (EU). Locked by the task-6 controller context.
// ---------------------------------------------------------------------------

const ITERABLE_ENDPOINTS = {
  us: "https://api.iterable.com",
  eu: "https://api.eu.iterable.com",
} as const;

function resolveRegion(creds: ProviderCredentials): keyof typeof ITERABLE_ENDPOINTS {
  return creds["region"] === "eu" ? "eu" : "us";
}

function buildTrackPurchaseUrl(creds: ProviderCredentials): string {
  return `${ITERABLE_ENDPOINTS[resolveRegion(creds)]}/api/commerce/trackPurchase`;
}

function buildEventsTrackUrl(creds: ProviderCredentials): string {
  return `${ITERABLE_ENDPOINTS[resolveRegion(creds)]}/api/events/track`;
}

function buildListsUrl(creds: ProviderCredentials): string {
  return `${ITERABLE_ENDPOINTS[resolveRegion(creds)]}/api/lists`;
}

const ITERABLE_UNKNOWN_PRODUCT_ID = "unknown";
const ITERABLE_ITEM_QUANTITY = 1;

// ---------------------------------------------------------------------------
// Identity resolution — per the Task 6 brief/context: Iterable is a
// user-keyed (email/userId) platform, not a device- or app-id-keyed one like
// most Wave-1/Wave-2 providers, so there is no subscriberId fallback (a
// Rovenue-internal id is neither a valid Iterable userId nor an email, and
// sending it as either would either silently create a garbage profile or be
// rejected). Order: $iterableUserId (an explicit Iterable identify() call)
// wins when present; otherwise the subscriber's email — read from the
// delivery-time ENRICHED identityContext.email first (populated from
// subscriberAttributes.$email by enrichEnvelope when the envelope itself
// didn't already carry one), falling back to subscriberAttributes.$email
// directly for callers that construct an envelope without going through
// enrichEnvelope (e.g. this file's own unit tests). No email is ever
// invented — only ever read from these two existing sources.
// ---------------------------------------------------------------------------

type IterableIdentity = { userId: string } | { email: string };

function resolveIdentity(envelope: RovenueEventEnvelope): IterableIdentity | undefined {
  const iterableUserId = envelope.subscriberAttributes?.["$iterableUserId"];
  if (iterableUserId) {
    return { userId: iterableUserId };
  }

  const email = envelope.identityContext?.email ?? envelope.subscriberAttributes?.["$email"];
  if (email) {
    return { email };
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// Monetary field — CROSS-PROVIDER CURRENCY RULING (binding for every
// Wave-2 provider from Task 5 on): never fabricate a currency. For Iterable
// specifically, the ruling resolves differently than OneSignal's: the
// verified `commerce/trackPurchase` contract (RevenueCat's own Iterable
// integration's sample payloads — total/user/items/id/createdAt only, no
// currencyCode anywhere at the top level OR on an item — corroborated by
// every third-party Iterable API client surveyed) has NO currency field to
// populate at all, so there is no "required monetary context" to gate
// `total`/`price` on the way OneSignal gates on `currency` being present.
// `total`/`price` is therefore populated whenever `amount` is present and
// parseable, independent of whether `currency` is known — and `currency`
// itself is never sent, because Iterable's trackPurchase has nowhere to put
// it. Falls back to 0 when amount is absent/unparseable, same as Braze's
// purchase-object `price` (a structurally required numeric field with no
// vendor-documented default).
// ---------------------------------------------------------------------------

function resolvePrice(envelope: RovenueEventEnvelope): number {
  const amount = envelope.amount ? parseFloat(envelope.amount) : undefined;
  return amount !== undefined && !isNaN(amount) ? amount : 0;
}

// ---------------------------------------------------------------------------
// Wire body shapes
// ---------------------------------------------------------------------------

interface IterableTrackPurchaseItem {
  id: string;
  name: string;
  price: number;
  quantity: number;
}

interface IterableTrackPurchaseBody {
  user: IterableIdentity;
  items: IterableTrackPurchaseItem[];
  total: number;
  createdAt: number;
  id: string;
}

interface IterableEventsTrackBody {
  userId?: string;
  email?: string;
  eventName: string;
  id: string;
  createdAt: number;
  dataFields: { rovenue_event: RovenueEventKey; product_id?: string };
}

// ---------------------------------------------------------------------------
// Delivery response classification — per the Task 6 controller context's
// binding classification (Iterable's API returns exactly `200` on success
// for these endpoints, not a wider 2xx range like most other Wave-1/Wave-2
// providers, per every sample response surveyed): 200 is ok. 400 (malformed
// request) and 401 (bad Api-Key) are permanent rejections and must not
// retry. 429 (rate limit) and 5xx are retriable — the standard shape used
// across every other provider in this codebase.
// ---------------------------------------------------------------------------

function classifyIterableResponse(res: { status: number; body: string }): DeliveryResult {
  const { status } = res;
  const retriable = status === 429 || status >= 500;
  const ok = status === 200;
  return {
    ok,
    httpStatus: status,
    responseBody: res.body,
    errorMessage: ok ? undefined : `iterable http ${status}`,
    retriable,
  };
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const iterableProvider: IntegrationProvider = {
  id: "ITERABLE",

  topics: ["rovenue.revenue", "rovenue.subscription"],
  eventCatalog: STANDARD_PROVIDER_EVENT_KEYS,
  allowMultipleConnections: false,
  credentialsSchema,

  defaultEventMapping: DEFAULT_EVENT_MAPPING.ITERABLE,

  // REAL, zero-footprint validation — `GET /api/lists` is a documented,
  // read-only, project-scoped endpoint (returns the project's lists) that
  // fails with 401 on an invalid Api-Key and writes nothing, so no
  // PROVIDER_VALIDATE_NOTES entry is needed (same reasoning as ONESIGNAL's
  // `GET /apps/{app_id}`, unlike BRAZE's real-probe-event validate).
  async validateCredentials(
    creds: ProviderCredentials,
    http: HttpClient,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const apiKey = creds["api_key"] ?? "";

    const res = await http.request({
      method: "GET",
      url: buildListsUrl(creds),
      headers: {
        "Api-Key": apiKey,
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
    // outboxEventId rides `id` on both wire shapes below — Iterable's own
    // provider-side dedup key for both trackPurchase and events/track (per
    // the vendor docs, re-sending the same `id` updates the existing event
    // rather than creating a duplicate). Fail loudly rather than silently
    // ship without it, same invariant as every other provider.
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
      providerId: "ITERABLE",
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

    const createdAt = Date.parse(envelope.occurredAt);

    // REFUND: `revenue.REFUND` never reaches this branch — DEFAULT_EVENT_
    // MAPPING.ITERABLE (event-mapping.ts) intentionally omits it, so
    // applyEventMapping() above already returned `{ skip: true, reason:
    // "no_mapping" }` for it. Rationale (see event-mapping.ts's ITERABLE
    // comment for the full citation): Iterable's own trackPurchase
    // reference documents no negative-total/reversal convention, and
    // RevenueCat's own Iterable integration — a directly comparable
    // subscription-revenue forwarder — routes its "Cancellation" event
    // through the Custom Events API rather than trackPurchase, corroborating
    // that no such convention exists.
    if (eventKey.startsWith(REVENUE_EVENT_KEY_PREFIX)) {
      const price = resolvePrice(envelope);
      const body: IterableTrackPurchaseBody = {
        user: identity,
        items: [
          {
            id: envelope.productId ?? ITERABLE_UNKNOWN_PRODUCT_ID,
            name: envelope.productId ?? mappingResult.providerEvent,
            price,
            quantity: ITERABLE_ITEM_QUANTITY,
          },
        ],
        total: price,
        createdAt,
        id: envelope.outboxEventId,
      };

      return {
        eventKey,
        providerEvent: mappingResult.providerEvent,
        body,
      };
    }

    const body: IterableEventsTrackBody = {
      ...("userId" in identity ? { userId: identity.userId } : { email: identity.email }),
      eventName: mappingResult.providerEvent,
      id: envelope.outboxEventId,
      createdAt,
      dataFields: {
        rovenue_event: eventKey,
        ...(envelope.productId ? { product_id: envelope.productId } : {}),
      },
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
    const apiKey = creds["api_key"] ?? "";
    const isRevenue = payload.eventKey.startsWith(REVENUE_EVENT_KEY_PREFIX);
    const url = isRevenue ? buildTrackPurchaseUrl(creds) : buildEventsTrackUrl(creds);

    const res = await http.request({
      method: "POST",
      url,
      headers: {
        "content-type": "application/json",
        "Api-Key": apiKey,
      },
      body: JSON.stringify(payload.body),
    });

    return classifyIterableResponse(res);
  },
};
