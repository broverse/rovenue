import { SUBSCRIPTION_BRIDGE_EVENT_KEYS } from "@rovenue/shared";
import { getKafka } from "../../lib/kafka";
import { logger } from "../../lib/logger";
import {
  buildIntegrationsDeliverJobId,
  INTEGRATIONS_DELIVER_QUEUE_NAME,
  type IntegrationsDeliverJob,
} from "../../queues/integrations";
import { fanoutTopics } from "../integrations/registry";
import type {
  FanoutTopic,
  RevenueEventKind,
  RovenueEventEnvelope,
} from "../integrations/types";
import type { ConnectionCache } from "./connection-cache";

export const FANOUT_CONSUMER_GROUP = "rovenue-integrations-fanout";

// Populated at module load from the provider registry's deduped topic
// union (Task 3's `fanoutTopics()`). Exported as a read-only snapshot for
// logging/tests only — `startIntegrationsFanout` re-calls `fanoutTopics()`
// itself at start time (see below), so a provider registered after this
// module loaded (e.g. Task 7's CUSTOM_WEBHOOK) is picked up on the next
// process start with no further changes to this file.
//
// IMPORTANT: `rovenue.billing` is deliberately NEVER a member of this set.
// That topic carries Rovenue-cloud's own internal billing events
// (`billing.invoice.paid`, `billing.usage_lock.*`) — never customer-facing
// integration fan-out. No provider's `topics` may include it; if one ever
// does, this comment is the tripwire to revert that.
export const FANOUT_TOPICS: readonly FanoutTopic[] = fanoutTopics();

const log = logger.child("integrations-fanout");

// =============================================================
// toFanoutEnvelope — normalize an outbox message into the envelope
// =============================================================
//
// The outbox dispatcher publishes `{ eventId, eventType, aggregateId,
// createdAt, payload }` on every fanout topic — `payload` is shaped
// per-domain (ClickHouse-shaped revenue row, flat paywall event, raw
// credit-ledger row, ...), NOT a RovenueEventEnvelope. The producer
// payloads can't change (CH Kafka-engine tables / other consumers read
// those exact field names), so this function maps each topic's wrapper
// shape into the shared envelope. Crucially, `outboxEventId` is always
// taken from the wrapper's `eventId` (the outbox row id, or — for
// PAYWALL_EVENT rows — a content-derived hash; see
// workers/outbox-dispatcher.ts's shapePaywallEventMessage) — providers
// hard-require it and dedup on it. Returns null for (topic, eventType)
// pairs that don't map to a known envelope shape.

interface OutboxWrapper {
  eventId?: unknown;
  eventType?: unknown;
  createdAt?: unknown;
  payload?: unknown;
}

const asStr = (v: unknown): string | undefined =>
  typeof v === "string" ? v : undefined;

function toRevenueEnvelope(
  w: OutboxWrapper & { eventId: string },
  payload: Record<string, unknown>,
): RovenueEventEnvelope | null {
  if (w.eventType !== "revenue.event.recorded") return null;

  const projectId = payload.projectId;
  if (typeof projectId !== "string" || projectId.length === 0) return null;

  const subscriberId =
    typeof payload.subscriberId === "string" ? payload.subscriberId : undefined;

  return {
    outboxEventId: w.eventId,
    projectId,
    eventType: "revenue.event.recorded",
    occurredAt:
      asStr(payload.eventDate) ?? asStr(w.createdAt) ?? new Date().toISOString(),
    revenueEventKind: payload.type as RevenueEventKind | undefined,
    // The original transaction amount + currency (Meta/TikTok value fields).
    amount: asStr(payload.amount),
    currency: asStr(payload.currency),
    subscriberId,
    productId: asStr(payload.productId),
    // No PII in the outbox payload (by design); externalId = subscriberId
    // gives the platforms a stable match key. Email/phone enrichment is a
    // follow-up in the delivery worker.
    identityContext: subscriberId ? { externalId: subscriberId } : undefined,
    // Lift ONLY the scalar `reason` discriminator (e.g. distinguishes a
    // win-back revenue.REACTIVATION from applyRefundReversed's accounting
    // reversal). Never spread `metadata` itself — it also carries
    // presentedContext (placementId/paywallId/variantId/experimentKey),
    // which must not widen every customer's webhook body.
    revenueEventReason:
      payload.metadata !== null &&
      typeof payload.metadata === "object" &&
      !Array.isArray(payload.metadata)
        ? asStr((payload.metadata as Record<string, unknown>).reason)
        : undefined,
  };
}

// `subscription.cancel_requested` and `subscription.expired` have real
// producers as of Task 6 (scheduled-actions.ts / expiry-checker.ts). The
// other four — billing_issue / grace_period / uncancelled /
// product_changed — are the Wave-1 narrow store-lifecycle normalization
// keys bridged from STORE_EVENT_TO_PUBLIC_KEY (webhook-processor.ts's
// enqueueOutgoingWebhook). All six share this exact wrapper shape:
// eventKey = eventType, payload passthrough, mandatory projectId.
// (single-sourced as SUBSCRIPTION_BRIDGE_EVENT_KEYS in @rovenue/shared —
// the provider mappers and the dashboard event picker need the same set)
type SubscriptionEventType = (typeof SUBSCRIPTION_BRIDGE_EVENT_KEYS)[number];

function isSubscriptionEventType(v: unknown): v is SubscriptionEventType {
  return (
    typeof v === "string" &&
    (SUBSCRIPTION_BRIDGE_EVENT_KEYS as readonly string[]).includes(v)
  );
}

function toSubscriptionEnvelope(
  w: OutboxWrapper & { eventId: string },
  payload: Record<string, unknown>,
): RovenueEventEnvelope | null {
  if (!isSubscriptionEventType(w.eventType)) return null;
  const eventType = w.eventType;

  const projectId = payload.projectId;
  if (typeof projectId !== "string" || projectId.length === 0) return null;

  const subscriberId =
    typeof payload.subscriberId === "string" ? payload.subscriberId : undefined;

  return {
    outboxEventId: w.eventId,
    projectId,
    eventType,
    eventKey: eventType,
    // cancel_requested stamps `requestedAt`; expired stamps `timestamp`.
    occurredAt:
      asStr(payload.requestedAt) ??
      asStr(payload.timestamp) ??
      asStr(w.createdAt) ??
      new Date().toISOString(),
    subscriberId,
    payload,
  };
}

function toPaywallEnvelope(
  w: OutboxWrapper & { eventId: string },
  payload: Record<string, unknown>,
): RovenueEventEnvelope | null {
  // Real wire shape comes from workers/outbox-dispatcher.ts's
  // shapePaywallEventMessage() — a FLAT payload carrying `projectId`
  // (reshaped from the raw POST /v1/events client envelope).
  if (w.eventType !== "paywall_view" && w.eventType !== "paywall_close") return null;

  const projectId = payload.projectId;
  if (typeof projectId !== "string" || projectId.length === 0) return null;

  const subscriberId =
    typeof payload.subscriberId === "string" ? payload.subscriberId : undefined;

  return {
    outboxEventId: w.eventId,
    projectId,
    eventType: w.eventType,
    eventKey: w.eventType === "paywall_view" ? "paywall.view" : "paywall.close",
    occurredAt:
      asStr(payload.occurredAt) ?? asStr(w.createdAt) ?? new Date().toISOString(),
    subscriberId,
    payload,
  };
}

function toCreditEnvelope(
  w: OutboxWrapper & { eventId: string },
  payload: Record<string, unknown>,
): RovenueEventEnvelope | null {
  // Field names per packages/db/src/drizzle/repositories/credit-ledger.ts:151
  // (insertCreditLedger's outbox emit site): creditLedgerId, projectId,
  // subscriberId, currencyId, type, amount, balance, referenceType,
  // referenceId, createdAt.
  if (w.eventType !== "credit.ledger.appended") return null;

  const projectId = payload.projectId;
  if (typeof projectId !== "string" || projectId.length === 0) return null;

  const subscriberId =
    typeof payload.subscriberId === "string" ? payload.subscriberId : undefined;

  return {
    outboxEventId: w.eventId,
    projectId,
    eventType: "credit.ledger.appended",
    eventKey: "credit.ledger.appended",
    occurredAt:
      asStr(payload.createdAt) ?? asStr(w.createdAt) ?? new Date().toISOString(),
    subscriberId,
    payload,
  };
}

export function toFanoutEnvelope(
  parsed: unknown,
  topic: FanoutTopic,
): RovenueEventEnvelope | null {
  if (!parsed || typeof parsed !== "object") return null;
  const w = parsed as OutboxWrapper & Partial<RovenueEventEnvelope>;

  // Already a complete envelope (e.g. a directly-published event).
  if (typeof w.outboxEventId === "string" && typeof w.projectId === "string") {
    return w as RovenueEventEnvelope;
  }

  // Dispatcher-wrapped outbox row.
  if (typeof w.eventId !== "string") return null;
  const p = w.payload;
  if (!p || typeof p !== "object") return null;
  const payload = p as Record<string, unknown>;
  const wrapper = w as OutboxWrapper & { eventId: string };

  switch (topic) {
    case "rovenue.revenue":
      return toRevenueEnvelope(wrapper, payload);
    case "rovenue.subscription":
      return toSubscriptionEnvelope(wrapper, payload);
    case "rovenue.paywall_events":
      return toPaywallEnvelope(wrapper, payload);
    case "rovenue.credit":
      return toCreditEnvelope(wrapper, payload);
    default:
      return null;
  }
}

// =============================================================
// ProcessFanoutDeps — injectable dependencies for unit tests
// =============================================================

export interface ProcessFanoutDeps {
  cache: ConnectionCache;
  enqueue: (job: IntegrationsDeliverJob, jobId: string) => Promise<void>;
}

// =============================================================
// processFanoutMessage — pure function (no I/O beyond injected deps)
// =============================================================
//
// For each enabled connection in the project, enqueues one
// IntegrationsDeliverJob into the BullMQ queue. Job IDs use the
// `connectionId:outboxEventId` deduplicated scheme so BullMQ's
// unique-job mechanism prevents double-dispatch on retry.

export async function processFanoutMessage(
  envelope: RovenueEventEnvelope,
  deps: ProcessFanoutDeps,
): Promise<void> {
  const connections = await deps.cache.get(envelope.projectId);
  if (connections.length === 0) return;

  await Promise.all(
    connections.map(async (conn) => {
      if (!conn.isEnabled) return;
      const job: IntegrationsDeliverJob = {
        connectionId: conn.id,
        projectId: conn.projectId,
        providerId: conn.providerId as IntegrationsDeliverJob["providerId"],
        envelope,
      };
      const jobId = buildIntegrationsDeliverJobId(
        conn.id,
        envelope.outboxEventId,
      );
      await deps.enqueue(job, jobId);
    }),
  );
}

// =============================================================
// startIntegrationsFanout — live KafkaJS consumer
// =============================================================
//
// Subscribes to FANOUT_TOPICS and calls processFanoutMessage for
// each inbound message. Parsing errors are logged and dropped
// (the fanout is best-effort; the outbox is the source of truth
// and can be replayed via the backfill worker).

export interface FanoutHandle {
  stop: () => Promise<void>;
}

export async function startIntegrationsFanout(
  deps: ProcessFanoutDeps,
): Promise<FanoutHandle> {
  const kafka = getKafka();
  if (!kafka) {
    log.warn("KAFKA_BROKERS not set — integrations fanout disabled");
    return { stop: async () => {} };
  }

  // Resolved at start time (not module-import time) so a provider
  // registered after this module loaded — e.g. Task 7's CUSTOM_WEBHOOK —
  // is picked up on the next process start without touching this file.
  const topics = fanoutTopics();

  const consumer = kafka.consumer({ groupId: FANOUT_CONSUMER_GROUP });
  await consumer.connect();

  for (const topic of topics) {
    await consumer.subscribe({ topic, fromBeginning: false });
  }

  await consumer.run({
    eachMessage: async ({ topic, message }) => {
      const raw = message.value?.toString() ?? "";
      if (!raw) return;
      let envelope: RovenueEventEnvelope | null;
      try {
        envelope = toFanoutEnvelope(JSON.parse(raw), topic as FanoutTopic);
      } catch (err) {
        log.error("parse_failed", {
          err: err instanceof Error ? err.message : String(err),
          rawPreview: raw.slice(0, 200),
        });
        return;
      }
      // Unmappable (topic, eventType) pair — skip.
      if (!envelope) return;
      try {
        await processFanoutMessage(envelope, deps);
      } catch (err) {
        log.error("fanout_failed", {
          err: err instanceof Error ? err.message : String(err),
          outboxEventId: envelope.outboxEventId,
          projectId: envelope.projectId,
        });
      }
    },
  });

  log.info("started", {
    topics,
    groupId: FANOUT_CONSUMER_GROUP,
    queue: INTEGRATIONS_DELIVER_QUEUE_NAME,
  });

  let stopped = false;
  return {
    stop: async () => {
      if (stopped) return;
      stopped = true;
      await consumer.disconnect();
    },
  };
}
