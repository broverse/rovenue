import { getKafka } from "../../lib/kafka";
import { logger } from "../../lib/logger";
import {
  buildIntegrationsDeliverJobId,
  INTEGRATIONS_DELIVER_QUEUE_NAME,
  type IntegrationsDeliverJob,
} from "../../queues/integrations";
import type {
  RevenueEventKind,
  RovenueEventEnvelope,
} from "../integrations/types";
import type { ConnectionCache } from "./connection-cache";

export const FANOUT_CONSUMER_GROUP = "rovenue-integrations-fanout";
export const FANOUT_TOPICS = ["rovenue.revenue", "rovenue.billing"] as const;

const log = logger.child("integrations-fanout");

// =============================================================
// toFanoutEnvelope — normalize an outbox message into the envelope
// =============================================================
//
// The outbox dispatcher publishes `{ eventId, eventType, aggregateId,
// createdAt, payload }`, where `payload` is the ClickHouse-shaped revenue
// row (field names like `revenueEventId`, `type`, `eventDate`, `amountUsd`)
// — NOT a RovenueEventEnvelope. The producer payload can't change (the CH
// Kafka-engine tables read those exact names), so the consumer maps it here.
// Crucially, `outboxEventId` is taken from the wrapper's `eventId` (the
// outbox row id) — the providers hard-require it and dedup on it. Returns
// null for event types that don't map to ad-platform conversions.

interface OutboxWrapper {
  eventId?: unknown;
  eventType?: unknown;
  createdAt?: unknown;
  payload?: unknown;
}

export function toFanoutEnvelope(parsed: unknown): RovenueEventEnvelope | null {
  if (!parsed || typeof parsed !== "object") return null;
  const w = parsed as OutboxWrapper & Partial<RovenueEventEnvelope>;

  // Already a complete envelope (e.g. a directly-published event).
  if (typeof w.outboxEventId === "string" && typeof w.projectId === "string") {
    return w as RovenueEventEnvelope;
  }

  // Dispatcher-wrapped outbox row.
  if (typeof w.eventId !== "string") return null;
  if (w.eventType !== "revenue.event.recorded") return null; // only revenue maps today
  const p = w.payload;
  if (!p || typeof p !== "object") return null;
  const payload = p as Record<string, unknown>;

  const projectId = payload.projectId;
  if (typeof projectId !== "string" || projectId.length === 0) return null;

  const subscriberId =
    typeof payload.subscriberId === "string" ? payload.subscriberId : undefined;
  const str = (v: unknown): string | undefined =>
    typeof v === "string" ? v : undefined;

  return {
    outboxEventId: w.eventId,
    projectId,
    eventType: "revenue.event.recorded",
    occurredAt:
      str(payload.eventDate) ?? str(w.createdAt) ?? new Date().toISOString(),
    revenueEventKind: payload.type as RevenueEventKind | undefined,
    // The original transaction amount + currency (Meta/TikTok value fields).
    amount: str(payload.amount),
    currency: str(payload.currency),
    subscriberId,
    productId: str(payload.productId),
    // No PII in the outbox payload (by design); externalId = subscriberId
    // gives the platforms a stable match key. Email/phone enrichment is a
    // follow-up in the delivery worker.
    identityContext: subscriberId ? { externalId: subscriberId } : undefined,
  };
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

  const consumer = kafka.consumer({ groupId: FANOUT_CONSUMER_GROUP });
  await consumer.connect();

  for (const topic of FANOUT_TOPICS) {
    await consumer.subscribe({ topic, fromBeginning: false });
  }

  await consumer.run({
    eachMessage: async ({ message }) => {
      const raw = message.value?.toString() ?? "";
      if (!raw) return;
      let envelope: RovenueEventEnvelope | null;
      try {
        envelope = toFanoutEnvelope(JSON.parse(raw));
      } catch (err) {
        log.error("parse_failed", {
          err: err instanceof Error ? err.message : String(err),
          rawPreview: raw.slice(0, 200),
        });
        return;
      }
      // Unmappable event type (e.g. a non-revenue billing event) — skip.
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
    topics: FANOUT_TOPICS,
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
