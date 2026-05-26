import type { Consumer, Kafka, Producer } from "kafkajs";
import { z } from "zod";
import type { Logger } from "../lib/logger";

// =============================================================
// notifier worker
// =============================================================
//
// Kafka consumer for `rovenue.notifications` produced by the
// outbox-dispatcher. Each message is a JSON envelope whose
// `payload` field carries the NotifyPayload shape emitted by
// `emitNotification()`.
//
// Responsibilities here are intentionally narrow:
// - parse the envelope + payload
// - hand off to a caller-provided `processMessage`
// - on any failure (parse OR process), forward the raw message
//   to `rovenue.notifications.dlq` and continue consuming
//
// The actual notification rendering / fan-out lives in
// `processNotification` (Task 9.3); this file only owns the
// transport and the DLQ contract so it can be unit-tested with
// a stub `processMessage`.

export const NOTIFICATIONS_TOPIC = "rovenue.notifications";
export const NOTIFICATIONS_DLQ_TOPIC = "rovenue.notifications.dlq";
export const NOTIFIER_GROUP_ID = "notifier";

export const NotifyPayload = z.object({
  eventKey: z.string().min(1),
  eventId: z.string().min(1),
  projectId: z.string().optional(),
  recipients: z.array(z.string()).optional(),
  context: z.record(z.string(), z.unknown()),
});
export type NotifyPayload = z.infer<typeof NotifyPayload>;

// Outbox-dispatcher wraps each row in an envelope before publishing,
// so the message value is `{ eventId, eventType, aggregateId, createdAt, payload }`.
const NotifyEnvelope = z.object({
  eventId: z.string().optional(),
  eventType: z.string().optional(),
  aggregateId: z.string().optional(),
  createdAt: z.string().optional(),
  payload: NotifyPayload,
});

export interface NotifierDeps {
  kafka: Kafka;
  logger: Logger;
  processMessage: (payload: NotifyPayload) => Promise<void>;
}

export interface RunningNotifier {
  consumer: Consumer;
  producer: Producer;
  stop: () => Promise<void>;
}

export async function startNotifier(deps: NotifierDeps): Promise<RunningNotifier> {
  const log = deps.logger.child("notifier");
  const consumer = deps.kafka.consumer({ groupId: NOTIFIER_GROUP_ID });
  const producer = deps.kafka.producer({
    idempotent: true,
    maxInFlightRequests: 1,
    allowAutoTopicCreation: false,
  });

  await producer.connect();
  await consumer.connect();
  await consumer.subscribe({
    topic: NOTIFICATIONS_TOPIC,
    fromBeginning: false,
  });

  await consumer.run({
    eachMessage: async ({ message }) => {
      const raw = message.value?.toString() ?? "";
      try {
        const parsed = parseMessage(raw);
        await deps.processMessage(parsed);
      } catch (err) {
        log.error("parse_or_process_failed", {
          err: err instanceof Error ? err.message : String(err),
          rawPreview: raw.slice(0, 200),
        });
        try {
          await producer.send({
            topic: NOTIFICATIONS_DLQ_TOPIC,
            messages: [
              {
                value: raw,
                headers: {
                  error: err instanceof Error ? err.message : String(err),
                  failedAt: new Date().toISOString(),
                },
              },
            ],
          });
        } catch (dlqErr) {
          // DLQ send itself failed — log loudly. Re-throwing here
          // would crash the consumer; instead we drop the message
          // on the floor and surface the failure in metrics/logs.
          log.error("dlq_send_failed", {
            err: dlqErr instanceof Error ? dlqErr.message : String(dlqErr),
          });
        }
      }
    },
  });

  log.info("started", { topic: NOTIFICATIONS_TOPIC, groupId: NOTIFIER_GROUP_ID });

  let stopped = false;
  const stop = async (): Promise<void> => {
    if (stopped) return;
    stopped = true;
    try {
      await consumer.disconnect();
    } finally {
      await producer.disconnect();
    }
  };

  return { consumer, producer, stop };
}

// Exported so unit tests can drive the parse path without standing
// up a broker. The notifier accepts both bare payloads (legacy /
// direct producer) and outbox-dispatcher envelopes.
export function parseMessage(raw: string): NotifyPayload {
  if (raw.length === 0) throw new Error("empty message value");
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `invalid json: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Try envelope shape first (outbox-dispatcher's wrapping).
  const envelope = NotifyEnvelope.safeParse(json);
  if (envelope.success) return envelope.data.payload;

  // Fall back to bare payload (test producers / future direct emitters).
  const bare = NotifyPayload.safeParse(json);
  if (bare.success) return bare.data;

  throw new Error(`payload validation failed: ${envelope.error.message}`);
}
