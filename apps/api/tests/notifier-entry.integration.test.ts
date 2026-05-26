// NOT parallel-safe: binds host port 19095 (separate from the bare
// notifier transport test on 19094 so the two suites can run in
// the same shard). Mirrors the dual-listener dance from
// outbox-dispatcher.integration.test.ts.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { Kafka } from "kafkajs";
import { LRUCache } from "lru-cache";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import { getDb, drizzle as drizzleNs } from "@rovenue/db";
import { runNotifier, stopNotifier } from "../src/workers/notifier-entry";
import {
  NOTIFICATIONS_DLQ_TOPIC,
  NOTIFICATIONS_TOPIC,
} from "../src/workers/notifier";
import type {
  SendEmailJob,
  SendPushJob,
} from "../src/queues/notifier";
import type { PrefsCache } from "../src/services/notifications/prefs-cache";

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

let redpanda: StartedTestContainer;
let brokerUrl: string;
const externalPort = 19095;

const db = getDb();
const schema = drizzleNs.schema;

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

  const admin = new Kafka({
    clientId: "test-admin",
    brokers: [brokerUrl],
  }).admin();
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
  await stopNotifier();
  await redpanda?.stop();
});

function buildPrefsCache(): PrefsCache {
  return {
    userPrefs: new LRUCache<string, object>({ max: 100, ttl: 60_000 }),
    projectDefaults: new LRUCache<string, object>({ max: 100, ttl: 60_000 }),
    projectMembers: new LRUCache<string, object>({ max: 100, ttl: 60_000 }),
    close: async () => undefined,
  };
}

async function seedUser() {
  const id = createId();
  const now = new Date();
  await db.insert(schema.user).values({
    id,
    name: `user-${id}`,
    email: `${id}@example.test`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

describe("notifier-entry end-to-end", () => {
  it("consumes a published payload, writes a notifications row, enqueues the send-jobs", async () => {
    const userId = await seedUser();

    const emailJobs: SendEmailJob[] = [];
    const pushJobs: SendPushJob[] = [];
    const sendEmailQueue = {
      add: async (job: SendEmailJob) => {
        emailJobs.push(job);
      },
    };
    const sendPushQueue = {
      add: async (job: SendPushJob) => {
        pushJobs.push(job);
      },
    };

    await runNotifier({
      deps: {
        db,
        env: {
          DASHBOARD_URL: "http://localhost:5173",
          UNSUB_SIGNING_KEY: "0".repeat(64),
          UNSUB_MAILTO: "unsubscribe@rovenue.test",
        },
        prefsCache: buildPrefsCache(),
        sendEmailQueue,
        sendPushQueue,
      },
    });

    const eventId = `e2e-${createId()}`;
    const producer = new Kafka({
      clientId: "e2e-producer",
      brokers: [brokerUrl],
    }).producer();
    await producer.connect();
    await producer.send({
      topic: NOTIFICATIONS_TOPIC,
      messages: [
        {
          value: JSON.stringify({
            eventId: `outbox-${eventId}`,
            eventType: "security.signin.new_device",
            aggregateId: "account",
            createdAt: new Date().toISOString(),
            payload: {
              eventKey: "security.signin.new_device",
              eventId,
              recipients: [userId],
              context: {
                userAgent: "Chrome",
                ipAddress: "1.2.3.4",
                whenIso: new Date().toISOString(),
              },
            },
          }),
        },
      ],
    });
    await producer.disconnect();

    // Wait for the notifications row to land.
    const notif = await waitForRow(async () => {
      const rows = await db
        .select()
        .from(schema.notifications)
        .where(eq(schema.notifications.eventId, eventId))
        .limit(1);
      return rows[0];
    }, 15_000);

    expect(notif).toBeDefined();
    expect(notif?.userId).toBe(userId);
    expect(notif?.eventKey).toBe("security.signin.new_device");

    // security.signin.new_device → email (forced) + push + inapp.
    // Email is forced so always queued; user has default push on.
    expect(emailJobs).toHaveLength(1);
    expect(pushJobs.length).toBeGreaterThanOrEqual(1);
  }, 45_000);
});

async function waitForRow<T>(
  fetcher: () => Promise<T | undefined>,
  timeoutMs: number,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const row = await fetcher();
    if (row) return row;
    await new Promise((r) => setTimeout(r, 200));
  }
  return undefined;
}
