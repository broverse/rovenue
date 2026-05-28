import type { IntegrationProviderId, RovenueEventKey } from "@rovenue/shared";

export type ProviderId = IntegrationProviderId;

export type RovenueEventType =
  | "revenue.event.recorded"
  | "subscription.trial.started"
  | "subscriber.identified";

export type RevenueEventKind =
  | "INITIAL"
  | "TRIAL_CONVERSION"
  | "RENEWAL"
  | "CREDIT_PURCHASE"
  | "REFUND"
  | "CANCELLATION";

export interface IdentityContext {
  email?: string;
  phone?: string;
  externalId?: string;
  ip?: string;
  userAgent?: string;
  fbp?: string;
  fbc?: string;
  ttclid?: string;
  ttp?: string;
}

export interface RovenueEventEnvelope {
  outboxEventId: string;
  projectId: string;
  eventType: RovenueEventType;
  occurredAt: string;
  revenueEventKind?: RevenueEventKind;
  amount?: string;
  currency?: string;
  subscriberId?: string;
  productId?: string;
  identityContext?: IdentityContext;
  eventSourceUrl?: string;
}

export interface ConnectionConfig {
  connectionId: string;
  projectId: string;
  enabledEvents: RovenueEventKey[];
  eventMapping: Record<string, { eventName?: string; skip?: true }>;
  actionSource: "app" | "website" | "system_generated";
  testEventCode?: string;
}

export interface ProviderPayload {
  eventKey: RovenueEventKey;
  providerEvent: string;
  body: unknown;
}

export type MapEventSkipReason =
  | "no_mapping"
  | "filtered_by_event_scope"
  | "no_user_data";

export type MapEventResult =
  | ProviderPayload
  | { skip: true; reason: MapEventSkipReason };

export interface DeliveryResult {
  ok: boolean;
  httpStatus: number;
  responseBody: string;
  errorMessage?: string;
  retriable: boolean;
}

export interface ProviderCredentials {
  [k: string]: string;
}

export interface HttpClient {
  request(input: {
    method: "GET" | "POST";
    url: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{ status: number; body: string }>;
}

export interface IntegrationProvider {
  id: ProviderId;
  defaultEventMapping: Partial<Record<RovenueEventKey, string>>;
  validateCredentials(
    creds: ProviderCredentials,
    http: HttpClient,
  ): Promise<{ ok: true } | { ok: false; reason: string }>;
  mapEvent(
    envelope: RovenueEventEnvelope,
    config: ConnectionConfig,
    creds: ProviderCredentials,
  ): MapEventResult;
  deliver(
    payload: ProviderPayload,
    creds: ProviderCredentials,
    http: HttpClient,
  ): Promise<DeliveryResult>;
}
