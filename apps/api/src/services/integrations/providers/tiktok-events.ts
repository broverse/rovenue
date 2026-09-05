import { z } from "zod";
import type {
  IntegrationProvider,
  RovenueEventEnvelope,
  ConnectionConfig,
  ProviderCredentials,
  MapEventResult,
  ProviderPayload,
  HttpClient,
  DeliveryResult,
} from "../types";
import type { RovenueEventKey } from "@rovenue/shared";
import {
  applyEventMapping,
  DEFAULT_EVENT_MAPPING,
  deriveRevenueEventKey,
} from "../event-mapping";
import {
  hashPii,
  normalizeEmail,
  normalizePhone,
  normalizeExternalId,
} from "../hash-pii";

// ---------------------------------------------------------------------------
// deriveEventKey
// ---------------------------------------------------------------------------

function deriveEventKey(
  envelope: RovenueEventEnvelope,
): RovenueEventKey | undefined {
  if (envelope.eventType === "subscription.trial.started") {
    return "subscription.trial.started";
  }
  if (envelope.eventType === "subscriber.identified") {
    return "subscriber.identified";
  }
  return deriveRevenueEventKey(envelope);
}

// ---------------------------------------------------------------------------
// buildUser — TikTok user object (scalars, not arrays)
// ---------------------------------------------------------------------------

type TikTokUser = {
  email?: string;
  phone?: string;
  external_id?: string;
  ip?: string;
  user_agent?: string;
  ttclid?: string;
  ttp?: string;
};

function buildUser(envelope: RovenueEventEnvelope): TikTokUser | undefined {
  const ctx = envelope.identityContext;
  const user: TikTokUser = {};

  const em = hashPii(normalizeEmail(ctx?.email));
  if (em) user.email = em;

  const ph = hashPii(normalizePhone(ctx?.phone));
  if (ph) user.phone = ph;

  const extId = normalizeExternalId(ctx?.externalId);
  if (extId) user.external_id = hashPii(extId) as string;

  if (ctx?.ip) user.ip = ctx.ip;
  if (ctx?.userAgent) user.user_agent = ctx.userAgent;
  if (ctx?.ttclid) user.ttclid = ctx.ttclid;
  if (ctx?.ttp) user.ttp = ctx.ttp;

  if (Object.keys(user).length === 0) return undefined;
  return user;
}

// ---------------------------------------------------------------------------
// Default event mapping
// ---------------------------------------------------------------------------

// eventCatalog = exactly the keys of defaultEventMapping in
// event-mapping.ts's DEFAULT_EVENT_MAPPING.
const eventCatalog: readonly RovenueEventKey[] = [
  "revenue.INITIAL",
  "revenue.TRIAL_CONVERSION",
  "revenue.RENEWAL",
  "revenue.CREDIT_PURCHASE",
  // Task 9 (2026-09-04): maps to "CompletePayment", not "Subscribe" — see
  // event-mapping.ts's Task 9 citation block. revenue.REACTIVATION is
  // deliberately NOT added here: it is a lifecycle signal, and this
  // catalog stays narrow so a lifecycle event can never masquerade as a
  // conversion.
  "revenue.NON_RENEWING_PURCHASE",
  "subscription.trial.started",
  "subscriber.identified",
];

// Field ids mirror what validateCredentials/deliver/mapEvent read off creds
// (pixel_code + access_token) — also what the existing route/provider unit
// tests send. .catchall(z.string()) so unrelated extra string keys never
// fail validation, while keeping the inferred type Record<string, string>
// (a .passthrough() object types loose keys as `unknown`, which doesn't
// satisfy IntegrationProvider["credentialsSchema"]).
const credentialsSchema = z
  .object({
    pixel_code: z.string().min(1),
    access_token: z.string().min(1),
  })
  .catchall(z.string());

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const tiktokEventsProvider: IntegrationProvider = {
  id: "TIKTOK_EVENTS",

  topics: ["rovenue.revenue"],
  eventCatalog,
  allowMultipleConnections: false,
  credentialsSchema,

  defaultEventMapping: DEFAULT_EVENT_MAPPING.TIKTOK_EVENTS,

  async validateCredentials(
    creds: ProviderCredentials,
    http: HttpClient,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    const token = creds["access_token"] ?? "";
    const pixelCode = creds["pixel_code"] ?? "";
    const url = "https://business-api.tiktok.com/open_api/v1.3/event/track/";
    const res = await http.request({
      method: "POST",
      url,
      headers: {
        "content-type": "application/json",
        "Access-Token": token,
      },
      body: JSON.stringify({
        event_source: "web",
        event_source_id: pixelCode,
        data: [],
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
    creds: ProviderCredentials,
  ): MapEventResult {
    // outboxEventId is the SOLE provider-side idempotency boundary (it is
    // stamped into TikTok's `event_id` for dedup; the DB unique index was
    // intentionally dropped). In the real path it is a non-empty cuid2, but
    // a future producer (e.g. a backfill building its own envelope) could
    // pass an empty id and silently degrade dedup to "every send unique".
    // Fail loudly so the delivery falls into the existing retry/dead-letter
    // path instead of double-sending.
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
      providerId: "TIKTOK_EVENTS",
      eventKey,
      enabledEvents: config.enabledEvents,
      override: config.eventMapping,
    });

    if (mappingResult.kind === "skip") {
      return { skip: true, reason: mappingResult.reason };
    }

    const user = buildUser(envelope);
    if (!user) {
      return { skip: true, reason: "no_user_data" };
    }

    const properties: Record<string, unknown> = {};
    const amount = envelope.amount ? parseFloat(envelope.amount) : undefined;
    if (amount !== undefined && !isNaN(amount)) {
      properties.value = amount;
      properties.currency = envelope.currency ?? "USD";
    }

    const dataEntry: Record<string, unknown> = {
      event: mappingResult.providerEvent,
      event_time: Math.floor(new Date(envelope.occurredAt).getTime() / 1000),
      event_id: envelope.outboxEventId,
      user,
      properties,
    };

    const pixelCode = creds["pixel_code"] ?? "";
    const body: Record<string, unknown> = {
      event_source: "web",
      event_source_id: pixelCode,
      data: [dataEntry],
    };

    if (config.testEventCode) {
      body.test_event_code = config.testEventCode;
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
    const token = creds["access_token"] ?? "";
    const url = "https://business-api.tiktok.com/open_api/v1.3/event/track/";

    const res = await http.request({
      method: "POST",
      url,
      headers: {
        "content-type": "application/json",
        "Access-Token": token,
      },
      body: JSON.stringify(payload.body),
    });

    const retriable = res.status === 429 || res.status >= 500;
    const ok = res.status >= 200 && res.status < 300;

    return {
      ok,
      httpStatus: res.status,
      responseBody: res.body,
      errorMessage: ok ? undefined : `tiktok http ${res.status}`,
      retriable,
    };
  },
};
