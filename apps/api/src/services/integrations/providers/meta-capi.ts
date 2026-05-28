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
// buildUserData — returns Meta user_data object (keys are arrays per CAPI spec)
// ---------------------------------------------------------------------------

type MetaUserData = {
  em?: string[];
  ph?: string[];
  external_id?: string[];
  client_ip_address?: string;
  client_user_agent?: string;
  fbp?: string;
  fbc?: string;
};

function buildUserData(
  envelope: RovenueEventEnvelope,
): MetaUserData | undefined {
  const ctx = envelope.identityContext;
  const ud: MetaUserData = {};

  const em = hashPii(normalizeEmail(ctx?.email));
  if (em) ud.em = [em];

  const ph = hashPii(normalizePhone(ctx?.phone));
  if (ph) ud.ph = [ph];

  const extId = normalizeExternalId(ctx?.externalId);
  if (extId) ud.external_id = [hashPii(extId) as string];

  if (ctx?.ip) ud.client_ip_address = ctx.ip;
  if (ctx?.userAgent) ud.client_user_agent = ctx.userAgent;
  if (ctx?.fbp) ud.fbp = ctx.fbp;
  if (ctx?.fbc) ud.fbc = ctx.fbc;

  if (Object.keys(ud).length === 0) return undefined;
  return ud;
}

// ---------------------------------------------------------------------------
// Default event mapping
// ---------------------------------------------------------------------------

const defaultEventMapping: IntegrationProvider["defaultEventMapping"] = {
  "revenue.INITIAL": "Subscribe",
  "revenue.TRIAL_CONVERSION": "Subscribe",
  "revenue.RENEWAL": "Purchase",
  "revenue.CREDIT_PURCHASE": "Purchase",
  "subscription.trial.started": "StartTrial",
  "subscriber.identified": "CompleteRegistration",
};

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const metaCapiProvider: IntegrationProvider = {
  id: "META_CAPI",

  defaultEventMapping,

  async validateCredentials(
    _creds: ProviderCredentials,
    _http: HttpClient,
  ): Promise<{ ok: true } | { ok: false; reason: string }> {
    throw new Error("not implemented yet");
  },

  mapEvent(
    envelope: RovenueEventEnvelope,
    config: ConnectionConfig,
  ): MapEventResult {
    const eventKey = deriveEventKey(envelope);
    if (!eventKey) {
      return { skip: true, reason: "no_mapping" };
    }

    const mappingResult = applyEventMapping({
      providerId: "META_CAPI",
      eventKey,
      enabledEvents: config.enabledEvents,
      override: config.eventMapping,
    });

    if (mappingResult.kind === "skip") {
      return { skip: true, reason: mappingResult.reason };
    }

    const userData = buildUserData(envelope);
    if (!userData) {
      return { skip: true, reason: "no_user_data" };
    }

    const eventData: Record<string, unknown> = {
      event_name: mappingResult.providerEvent,
      event_time: Math.floor(new Date(envelope.occurredAt).getTime() / 1000),
      event_id: envelope.outboxEventId,
      event_source_url: envelope.eventSourceUrl,
      action_source: config.actionSource,
      user_data: userData,
    };

    const amount = envelope.amount ? parseFloat(envelope.amount) : undefined;
    if (amount !== undefined && !isNaN(amount)) {
      eventData.custom_data = {
        value: amount,
        currency: envelope.currency ?? "USD",
      };
    }

    const body: Record<string, unknown> = {
      data: [eventData],
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
    _payload: ProviderPayload,
    _creds: ProviderCredentials,
    _http: HttpClient,
  ): Promise<DeliveryResult> {
    throw new Error("not implemented yet");
  },
};
