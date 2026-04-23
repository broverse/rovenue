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

// Late-binding broker resolver. `env` is parsed once at module load,
// so integration tests that mutate `process.env.KAFKA_BROKERS` after
// import (e.g. to point at a dynamically-started testcontainer) need
// us to re-read the live value per call. Prod still gets the validated
// default from the Zod schema via `env.KAFKA_BROKERS`.
function resolveBrokers(): string | undefined {
  const live = process.env.KAFKA_BROKERS;
  if (live && live.trim().length > 0) return live;
  return env.KAFKA_BROKERS;
}

export function getKafka(): Kafka | null {
  const brokers = resolveBrokers();
  if (!brokers) return null;
  return new Kafka({
    clientId: "rovenue-api",
    brokers: brokers.split(",").map((s) => s.trim()),
    logLevel: logLevel.WARN,
    retry: { retries: 5, initialRetryTime: 200 },
  });
}

// Introspection helper — used by integration tests to prove the
// dispatcher under test is hitting the expected broker (e.g. a
// testcontainer) and not the developer's local dev-compose Redpanda.
export function getResolvedBrokers(): string | null {
  return resolveBrokers() ?? null;
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
