import { Kafka, logLevel, type Producer } from "kafkajs";
import { env } from "./env";
import { logger } from "./logger";

// =============================================================
// kafkajs singletons
// =============================================================
//
// getProducer — idempotent producer (enableIdempotence=true) so
// retries after a network blip don't double-publish. The Kafka
// broker de-duplicates on (producerId, sequence) per partition.
//
// getAdmin — used only by assertTopic() at boot to create the
// Redpanda topics if absent. Redpanda has auto-create off by
// default in our compose config, so this is load-bearing.
//
// Both return null when KAFKA_BROKERS is unset (dev convenience);
// the dispatcher worker checks for null and exits cleanly.

let producerPromise: Promise<Producer> | null = null;

export function getKafka(): Kafka | null {
  if (!env.KAFKA_BROKERS) return null;
  return new Kafka({
    clientId: "rovenue-api",
    brokers: env.KAFKA_BROKERS.split(",").map((s) => s.trim()),
    logLevel: logLevel.WARN,
    retry: { retries: 5, initialRetryTime: 200 },
  });
}

export async function getProducer(): Promise<Producer | null> {
  const kafka = getKafka();
  if (!kafka) return null;
  if (!producerPromise) {
    const p = kafka.producer({
      idempotent: true,
      maxInFlightRequests: 1,
      allowAutoTopicCreation: false,
    });
    producerPromise = p.connect().then(() => p);
  }
  return producerPromise;
}

export async function assertTopic(topic: string): Promise<void> {
  const kafka = getKafka();
  if (!kafka) return;
  const admin = kafka.admin();
  try {
    await admin.connect();
    const existing = await admin.listTopics();
    if (existing.includes(topic)) return;
    await admin.createTopics({
      topics: [
        {
          topic,
          numPartitions: 3,
          replicationFactor: 1, // single-node Redpanda
          configEntries: [
            { name: "retention.ms", value: String(7 * 24 * 3600 * 1000) },
            { name: "compression.type", value: "zstd" },
          ],
        },
      ],
    });
    logger.info("kafka: created topic", { topic });
  } finally {
    await admin.disconnect();
  }
}

export async function disconnectKafka(): Promise<void> {
  if (!producerPromise) return;
  try {
    const p = await producerPromise;
    await p.disconnect();
  } finally {
    producerPromise = null;
  }
}
