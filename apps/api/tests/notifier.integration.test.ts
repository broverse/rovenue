// NOT parallel-safe: binds host port 19094. Mirrors the dual-listener
// dance in outbox-dispatcher.integration.test.ts — see commentary there.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { Kafka } from "kafkajs";
import { logger } from "../src/lib/logger";
import {
  NOTIFICATIONS_DLQ_TOPIC,
  NOTIFICATIONS_TOPIC,
  parseMessage,
  startNotifier,
  type NotifyPayload,
} from "../src/workers/notifier";

let redpanda: StartedTestContainer;
let brokerUrl: string;
const externalPort = 19094;

beforeAll(async () => {
  redpanda = await new GenericContainer("redpandadata/redpanda:v24.2.13")
    .withCommand([
      "redpanda",
      "start",
      "--smp=1",
      "--memory=512M",
      "--overprovisioned",
      "--node-id=0",
      "--check=false",
      `--kafka-addr=INTERNAL://0.0.0.0:29092,EXTERNAL://0.0.0.0:${externalPort}`,
      `--advertise-kafka-addr=INTERNAL://localhost:29092,EXTERNAL://localhost:${externalPort}`,
    ])
    .withExposedPorts({ container: externalPort, host: externalPort })
    .start();
  brokerUrl = `localhost:${externalPort}`;
  process.env.KAFKA_BROKERS = brokerUrl;

  // Pre-create the topics so consumer.subscribe() doesn't race
  // first-publish topic creation in the test.
  const admin = new Kafka({ clientId: "test-admin", brokers: [brokerUrl] }).admin();
  await admin.connect();
  await admin.createTopics({
    topics: [
      { topic: NOTIFICATIONS_TOPIC, numPartitions: 1, replicationFactor: 1 },
      { topic: NOTIFICATIONS_DLQ_TOPIC, numPartitions: 1, replicationFactor: 1 },
    ],
  });
  await admin.disconnect();
}, 60_000);

afterAll(async () => {
  await redpanda?.stop();
});

describe("parseMessage", () => {
  it("accepts a bare NotifyPayload", () => {
    const raw = JSON.stringify({
      eventKey: "security.signin.new_device",
      eventId: "evt-1",
      context: { userAgent: "Chrome" },
    });
    expect(parseMessage(raw)).toMatchObject({ eventKey: "security.signin.new_device" });
  });

  it("unwraps the outbox-dispatcher envelope", () => {
    const raw = JSON.stringify({
      eventId: "outbox-1",
      eventType: "security.signin.new_device",
      aggregateId: "account",
      createdAt: "2026-05-26T10:00:00Z",
      payload: {
        eventKey: "security.signin.new_device",
        eventId: "evt-2",
        context: { userAgent: "Chrome" },
      },
    });
    expect(parseMessage(raw)).toMatchObject({ eventId: "evt-2" });
  });

  it("rejects an empty value", () => {
    expect(() => parseMessage("")).toThrow(/empty/);
  });

  it("rejects invalid json", () => {
    expect(() => parseMessage("not json {")).toThrow(/invalid json/);
  });

  it("rejects payload missing required fields", () => {
    const raw = JSON.stringify({ context: {} });
    expect(() => parseMessage(raw)).toThrow(/payload validation/);
  });
});

describe("notifier worker", () => {
  it("invokes processMessage for a valid published payload", async () => {
    const kafka = new Kafka({ clientId: "notifier-test", brokers: [brokerUrl] });
    const received: NotifyPayload[] = [];
    const running = await startNotifier({
      kafka,
      logger,
      processMessage: async (p) => {
        received.push(p);
      },
    });

    try {
      const producer = kafka.producer();
      await producer.connect();
      await producer.send({
        topic: NOTIFICATIONS_TOPIC,
        messages: [
          {
            value: JSON.stringify({
              eventId: "outbox-good",
              payload: {
                eventKey: "security.signin.new_device",
                eventId: "evt-good-1",
                context: { userAgent: "Chrome", ipAddress: "1.2.3.4" },
              },
            }),
          },
        ],
      });
      await producer.disconnect();

      await waitFor(() => received.length === 1, 15_000);
      expect(received[0]).toMatchObject({
        eventKey: "security.signin.new_device",
        eventId: "evt-good-1",
      });
    } finally {
      await running.stop();
    }
  }, 30_000);

  it("forwards invalid messages to the DLQ topic", async () => {
    const kafka = new Kafka({ clientId: "notifier-test-dlq", brokers: [brokerUrl] });
    const running = await startNotifier({
      kafka,
      logger,
      processMessage: async () => {
        throw new Error("should not be called");
      },
    });

    // Subscribe to DLQ from beginning so the test sees the routed message.
    const dlqConsumer = kafka.consumer({ groupId: `dlq-test-${Date.now()}` });
    await dlqConsumer.connect();
    await dlqConsumer.subscribe({
      topic: NOTIFICATIONS_DLQ_TOPIC,
      fromBeginning: true,
    });

    const received = new Promise<{ value: string; headers: Record<string, string> }>(
      (resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("dlq timeout")), 15_000);
        void dlqConsumer.run({
          eachMessage: async ({ message }) => {
            clearTimeout(timer);
            const headers: Record<string, string> = {};
            for (const [k, v] of Object.entries(message.headers ?? {})) {
              headers[k] = v?.toString() ?? "";
            }
            resolve({ value: message.value?.toString() ?? "", headers });
          },
        });
      },
    );

    try {
      const producer = kafka.producer();
      await producer.connect();
      const badRaw = "not even json {";
      await producer.send({
        topic: NOTIFICATIONS_TOPIC,
        messages: [{ value: badRaw }],
      });
      await producer.disconnect();

      const dlqMsg = await received;
      expect(dlqMsg.value).toBe(badRaw);
      expect(dlqMsg.headers.error).toMatch(/invalid json|payload validation/);
    } finally {
      await dlqConsumer.disconnect();
      await running.stop();
    }
  }, 30_000);
});

async function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("waitFor timed out");
}
