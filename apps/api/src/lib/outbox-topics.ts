// =============================================================
// outbox aggregateType → Kafka topic
// =============================================================
//
// The single source of truth for "which topic does an outbox_events row
// publish to". The outbox dispatcher (workers/outbox-dispatcher.ts) uses it
// to route and to provision topics; the integrations backfill/redeliver path
// (services/integrations/backfill.ts) uses it to reconstruct the fan-out
// envelope for a stored row exactly the way the live consumer would.
//
// Type-only import of OutboxEvent, so this module has no runtime
// dependencies at all — anything may import it without pulling in kafkajs,
// Drizzle or Redis.

import type { OutboxEvent } from "@rovenue/db";

export type OutboxAggregateType = OutboxEvent["aggregateType"];

export const AGGREGATE_TO_TOPIC: Record<OutboxAggregateType, string> = {
  EXPOSURE: "rovenue.exposures",
  REVENUE_EVENT: "rovenue.revenue",
  CREDIT_LEDGER: "rovenue.credit",
  BILLING: "rovenue.billing",
  NOTIFICATION: "rovenue.notifications",
  FUNNEL: "rovenue.funnel",
  PAYWALL_EVENT: "rovenue.paywall_events",
  SUBSCRIPTION: "rovenue.subscription",
};

/** Topic for an aggregateType read back from the DB as a plain string.
 *  Returns undefined for a value this build doesn't know about. */
export function topicForAggregateType(aggregateType: string): string | undefined {
  return AGGREGATE_TO_TOPIC[aggregateType as OutboxAggregateType];
}
