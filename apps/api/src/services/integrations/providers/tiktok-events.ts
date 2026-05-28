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
import { applyEventMapping } from "../event-mapping";
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
  if (
    envelope.eventType === "revenue.event.recorded" &&
    envelope.revenueEventKind
  ) {
    return `revenue.${envelope.revenueEventKind}` as RovenueEventKey;
  }
  return undefined;
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

const defaultEventMapping: IntegrationProvider["defaultEventMapping"] = {
  "revenue.INITIAL": "Subscribe",
  "revenue.TRIAL_CONVERSION": "Subscribe",
  "revenue.RENEWAL": "Subscribe",
  "revenue.CREDIT_PURCHASE": "CompletePayment",
  "subscription.trial.started": "StartTrial",
  "subscriber.identified": "CompleteRegistration",
};

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const tiktokEventsProvider: IntegrationProvider = {
  id: "TIKTOK_EVENTS",

  defaultEventMapping,

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
    return { ok: false, reason: `HTTP ${res.status}: ${res.body}` };
  },

  mapEvent(
    envelope: RovenueEventEnvelope,
    config: ConnectionConfig,
    creds: ProviderCredentials,
  ): MapEventResult {
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
      errorMessage: ok ? undefined : `HTTP ${res.status}`,
      retriable,
    };
  },
};
