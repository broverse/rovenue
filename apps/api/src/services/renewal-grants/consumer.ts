import { getKafka } from "../../lib/kafka";
import { logger } from "../../lib/logger";
import { AGGREGATE_TO_TOPIC } from "../../lib/outbox-topics";
import {
  RENEWAL_GRANT_EVENT_TYPES,
  buildRenewalGrantJobId,
  type RenewalGrantJob,
} from "../../queues/renewal-grants";

// =============================================================
// renewal-grants Kafka consumer
// =============================================================
//
// A SECOND consumer group on rovenue.revenue, independent of
// rovenue-integrations-fanout, so a slow or failing grant cannot stall
// integration delivery and vice versa.
//
// This consumer does no work of its own: it parses, filters and
// enqueues. The grant runs in the BullMQ worker because THAT is where
// retries live. The fanout consumer next door logs its errors and
// returns, which commits the offset and drops the message — correct
// there, because BullMQ behind it owns the retry. Doing the same here
// would silently lose a subscriber's credits.

const log = logger.child("renewal-grants-consumer");

export const RENEWAL_GRANT_CONSUMER_GROUP = "rovenue-renewal-grants";

const REVENUE_TOPIC = AGGREGATE_TO_TOPIC.REVENUE_EVENT;

function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function toRenewalGrantJob(
  raw: unknown,
): { job: RenewalGrantJob; outboxEventId: string } | null {
  if (typeof raw !== "object" || raw === null) return null;
  const envelope = raw as Record<string, unknown>;

  // The wire field is `eventId` — workers/outbox-dispatcher.ts's generic
  // (non-paywall) branch writes `{ eventId: row.id, eventType, aggregateId,
  // createdAt, payload }` for every topic including rovenue.revenue.
  // `outboxEventId` only exists as the internal RovenueEventEnvelope field
  // name the integrations-fanout consumer assigns AFTER parsing this exact
  // wrapper — it is never present on the raw Kafka message itself.
  const outboxEventId = str(envelope.eventId);
  const payload = envelope.payload;
  if (!outboxEventId || typeof payload !== "object" || payload === null) {
    return null;
  }

  const p = payload as Record<string, unknown>;
  const type = str(p.type);
  if (!type || !RENEWAL_GRANT_EVENT_TYPES.includes(type)) return null;

  const revenueEventId = str(p.revenueEventId);
  const projectId = str(p.projectId);
  const subscriberId = str(p.subscriberId);
  const productId = str(p.productId);
  if (!revenueEventId || !projectId || !subscriberId || !productId) return null;

  return {
    outboxEventId,
    job: { revenueEventId, projectId, subscriberId, productId, type },
  };
}

export interface RenewalGrantConsumerDeps {
  enqueue: (job: RenewalGrantJob, jobId: string) => Promise<void>;
}

export async function startRenewalGrantConsumer(
  deps: RenewalGrantConsumerDeps,
): Promise<{ stop: () => Promise<void> }> {
  const kafka = getKafka();
  if (!kafka) {
    log.warn("KAFKA_BROKERS not set — renewal grant consumer disabled");
    return { stop: async () => {} };
  }

  const consumer = kafka.consumer({ groupId: RENEWAL_GRANT_CONSUMER_GROUP });
  await consumer.connect();
  await consumer.subscribe({ topic: REVENUE_TOPIC, fromBeginning: false });

  await consumer.run({
    eachMessage: async ({ message }) => {
      const rawValue = message.value?.toString() ?? "";
      if (!rawValue) return;

      let parsed: ReturnType<typeof toRenewalGrantJob>;
      try {
        parsed = toRenewalGrantJob(JSON.parse(rawValue));
      } catch (err) {
        // Unparseable JSON can never become parseable — committing the
        // offset is right. A grant that merely FAILED must not take this
        // path; that is why enqueue below is allowed to throw.
        log.error("parse_failed", {
          err: err instanceof Error ? err.message : String(err),
          rawPreview: rawValue.slice(0, 200),
        });
        return;
      }

      if (!parsed) return;

      // Deliberately NOT wrapped in try/catch. A failed enqueue must
      // reject so kafkajs does not advance the offset and the message is
      // redelivered.
      await deps.enqueue(
        parsed.job,
        buildRenewalGrantJobId(parsed.outboxEventId),
      );
    },
  });

  log.info("started", {
    topic: REVENUE_TOPIC,
    groupId: RENEWAL_GRANT_CONSUMER_GROUP,
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
