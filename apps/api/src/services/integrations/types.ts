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
  | "subscriber.identified"
  | "subscription.cancel_requested"
  | "subscription.expired"
  // Wave-1 narrow store-lifecycle normalization (2026-08-24) — bridged
  // from STORE_EVENT_TO_PUBLIC_KEY, see store-event-normalization.ts.
  | "subscription.billing_issue"
  | "subscription.grace_period"
  | "subscription.uncancelled"
  | "subscription.product_changed"
  | "paywall_view"
  | "paywall_close"
  | "credit.ledger.appended";

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
  /** Public event key; set by toFanoutEnvelope for non-revenue topics.
   *  Revenue events keep deriving `revenue.${revenueEventKind}` (existing path). */
  eventKey?: RovenueEventKey;
  /** Domain payload passthrough for the webhook provider's `data` field. */
  payload?: Record<string, unknown>;
  /** Delivery-time subscriber attribute enrichment (Task 2). Flattened
   *  attribute map + `appUserId` when present. NEVER read by
   *  CUSTOM_WEBHOOK's buildWebhookData — this field (and identityContext
   *  PII) must stay off webhook bodies. */
  subscriberAttributes?: Record<string, string>;
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
  | "no_user_data"
  // APPSFLYER-specific (Wave-1 Task 7): both app_id_ios and app_id_android
  // are configured but the subscriber's `platform` attribute is absent,
  // unrecognized, or "web" — there is no way to pick which AppsFlyer app id
  // the in-app-event API path segment should use. The delivery-log
  // `skip_reason` column is plain text (see integration-deliveries.schema),
  // so a new reason string here needs no migration; the dashboard's
  // deliveries table does not render skipReason today (it isn't even on
  // IntegrationDeliveryRow) — this string flows through unrendered, same as
  // every existing reason, until that surface is built.
  | "no_platform_app_id";

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
