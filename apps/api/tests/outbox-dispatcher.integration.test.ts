// NOT parallel-safe: binds host port 19093. If a developer's dev compose
// holds 19092/19093 or parallel Vitest shards run, this test will
// EADDRINUSE. Single shard + no local redpanda on 19093 is a hard
// requirement. Dynamic port mapping conflicts with Redpanda's
// --advertise-kafka-addr which must be set at container start — see the
// dual-listener dance below. Phase G may swap for a simpler single
// listener + getMappedPort() once we're willing to restart the container
// after discovering the port.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { Kafka } from "kafkajs";
import { sql } from "drizzle-orm";
import { drizzle, getDb } from "@rovenue/db";
import {
  runOutboxDispatcher,
  stopOutboxDispatcher,
} from "../src/workers/outbox-dispatcher";
import { getResolvedBrokers } from "../src/lib/kafka";

let redpanda: StartedTestContainer;
let brokerUrl: string;

// Two-stage broker-address dance:
//
// Redpanda is told to advertise `PLAINTEXT://localhost:<externalPort>`
// so a client connecting from the host via the mapped external
// listener port gets back a usable bootstrap URL. We pick the
// externalPort on the host at random (testcontainers allocates one)
// and the container binds its EXTERNAL listener to the same port
// number — this way the advertised address matches whether the
// client connects to the mapped port or directly.

beforeAll(async () => {
  // Container-side external listener port must equal host mapped
  // port so the advertised bootstrap address resolves from the host.
  // Redpanda supports multi-listener configs; we use INTERNAL on
  // 29092 (cluster-internal) and EXTERNAL on the dynamic host port.
  const externalPort = 19093;
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
}, 60_000);

afterAll(async () => {
  stopOutboxDispatcher();
  await redpanda?.stop();
});

describe("outbox-dispatcher integration", () => {
  it("publishes an EXPOSURE row to rovenue.exposures", async () => {
    // 0. Prove the dispatcher-under-test will connect to our
    //    testcontainer broker, not a stale value from `.env`. If the
    //    late-binding in lib/kafka.ts regresses, this fails fast rather
    //    than silently testing the developer's dev-compose Redpanda.
    expect(getResolvedBrokers()).toBe(brokerUrl);

    // 1. Insert a row via the repo.
    const db = getDb();
    // Drain any stale unpublished test rows left from previous runs
    // so the dispatcher doesn't race this one and emit an old row
    // first. Production DBs never see `evt_test_*` so this is safe.
    await db.execute(sql`DELETE FROM outbox_events WHERE id LIKE 'evt_test_%'`);
    // Use unique ids per run so re-runs against a persistent dev DB
    // don't collide on the primary key.
    const id = `evt_test_${Date.now()}`;
    const aggregateId = `exp_e2e_${Date.now()}`;
    await drizzle.outboxRepo.insert(db, {
      id,
      aggregateType: "EXPOSURE",
      aggregateId,
      eventType: "experiment.exposure.recorded",
      payload: { experimentId: aggregateId, variantId: "var_a" },
    });

    // 2. Start the dispatcher in the background.
    void runOutboxDispatcher();

    // 3. Consume from rovenue.exposures.
    const kafka = new Kafka({ clientId: "test", brokers: [brokerUrl] });
    const consumer = kafka.consumer({ groupId: `test-${Date.now()}` });
    await consumer.connect();
    await consumer.subscribe({ topic: "rovenue.exposures", fromBeginning: true });

    const received = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timeout")), 10_000);
      void consumer.run({
        eachMessage: async ({ message }) => {
          clearTimeout(timer);
          resolve(message.value?.toString() ?? "");
        },
      });
    });

    expect(JSON.parse(received)).toMatchObject({
      eventId: id,
      aggregateId,
      payload: expect.objectContaining({ experimentId: aggregateId }),
    });

    await consumer.disconnect();
  }, 30_000);
});
