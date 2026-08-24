import type { z } from "zod";
import type { IntegrationProviderId, RovenueEventKey } from "@rovenue/shared";

export type ProviderId = IntegrationProviderId;

// ---------------------------------------------------------------------------
// Fan-out topics — the Kafka topics an outbox-driven integration provider can
// subscribe events from. SINGULAR "rovenue.subscription" per decision;
// CUSTOM_WEBHOOK (Task 7) and retry wiring (Task 9) are NOT part of this set.
// ---------------------------------------------------------------------------

export type FanoutTopic =
  | "rovenue.revenue"
  | "rovenue.subscription"
  | "rovenue.paywall_events"
  | "rovenue.credit";

export interface RetryPolicy {
  attempts: number;
  /** backoffMs[i] = delay before attempt i+2; last entry repeats. */
  backoffMs: readonly number[];
}

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
  topics: readonly FanoutTopic[];
  eventCatalog: readonly RovenueEventKey[];
  allowMultipleConnections: boolean;
  credentialsSchema: z.ZodType<Record<string, string>>;
  /** undefined → DEFAULT_RETRY_POLICY (wired in Task 9). */
  retryPolicy?: RetryPolicy;
  buildCredentialsHint?(creds: ProviderCredentials): string;
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
