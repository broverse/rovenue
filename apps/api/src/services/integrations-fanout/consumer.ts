import { getKafka } from "../../lib/kafka";
import { logger } from "../../lib/logger";
import {
  buildIntegrationsDeliverJobId,
  INTEGRATIONS_DELIVER_QUEUE_NAME,
  type IntegrationsDeliverJob,
} from "../../queues/integrations";
import type { RovenueEventEnvelope } from "../integrations/types";
import type { ConnectionCache } from "./connection-cache";

export const FANOUT_CONSUMER_GROUP = "integrations-fanout";
export const FANOUT_TOPICS = ["rovenue.revenue", "rovenue.billing"] as const;

const log = logger.child("integrations-fanout");

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
      let envelope: RovenueEventEnvelope;
      try {
        const parsed = JSON.parse(raw) as {
          payload?: RovenueEventEnvelope;
        } & RovenueEventEnvelope;
        // Support both bare envelopes and outbox-dispatcher-wrapped
        // envelopes ({ ..., payload: RovenueEventEnvelope }).
        envelope =
          parsed.payload && typeof parsed.payload === "object"
            ? parsed.payload
            : parsed;
      } catch (err) {
        log.error("parse_failed", {
          err: err instanceof Error ? err.message : String(err),
          rawPreview: raw.slice(0, 200),
        });
        return;
      }
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
