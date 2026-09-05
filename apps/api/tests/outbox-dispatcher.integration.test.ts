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
  getBackoffState,
  runOnce,
  runOutboxDispatcher,
  stopOutboxDispatcher,
  topicBackoff,
} from "../src/workers/outbox-dispatcher";
import { getProducer } from "../src/lib/kafka";
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

// =============================================================
// Chaos: the crash window between Kafka ack and markPublished
// =============================================================
//
// `runOnce` does three things in order, and only the first and last are
// transactional:
//
//   1. claimBatch (tx1) — FOR UPDATE SKIP LOCKED; the lock is RELEASED when
//      this tx commits, before anything is published.
//   2. producer.send(...) — the row is now in Kafka.
//   3. markPublished (tx2) — `publishedAt` is set.
//
// A process that dies between 2 and 3 has published an event the database
// still considers unpublished. That is the at-least-once contract, and the
// outbox exists to make it survivable: on restart the row is re-claimed and
// re-published, downstream dedupes on eventId.
//
// `outbox-replay-idempotency.test.ts` proves the downstream half — ClickHouse
// collapses the duplicate — but says in its own header that it BYPASSES the
// outbox → dispatcher path. So the OLTP half, the part that decides whether
// the event is lost or merely duplicated, had no test. These are it.
//
// The crash is simulated by making markPublished throw rather than by killing
// a process: the invariant under test is what the DATABASE looks like when
// step 3 does not happen, and a thrown error leaves exactly that state.

async function seedExposure(suffix: string): Promise<string> {
  const db = getDb();
  const id = `evt_test_chaos_${suffix}`;
  await drizzle.outboxRepo.insert(db, {
    id,
    aggregateType: "EXPOSURE",
    aggregateId: `exp_chaos_${suffix}`,
    eventType: "experiment.exposure.recorded",
    payload: { experimentId: `exp_chaos_${suffix}`, variantId: "var_a" },
  });
  return id;
}

async function publishedAtFor(id: string): Promise<Date | null> {
  const rows = await getDb().execute(
    sql`SELECT "publishedAt" FROM outbox_events WHERE id = ${id}`,
  );
  const row = (rows as unknown as { rows: Array<{ publishedAt: Date | null }> })
    .rows[0];
  return row?.publishedAt ?? null;
}

describe("outbox-dispatcher chaos", () => {
  beforeAll(() => {
    // The first test in this file starts runOutboxDispatcher() and never
    // stops it — it loops until afterAll. These tests drive runOnce()
    // directly, and a background loop draining the same table would race
    // every assertion below about what is and is not published.
    stopOutboxDispatcher();
  });

  it("re-publishes a row whose ack landed but whose markPublished did not", async () => {
    const db = getDb();
    await db.execute(sql`DELETE FROM outbox_events WHERE id LIKE 'evt_test_chaos_%'`);
    const id = await seedExposure(`death_${Date.now()}`);

    // The post-crash state, constructed directly rather than by killing a
    // process: the event is in Kafka and the row is still unpublished. That
    // is exactly what the database looks like when the dispatcher dies
    // between `producer.send` and `markPublished`, and it is the state the
    // outbox is designed to be recoverable from.
    const producer = await getProducer();
    expect(producer).not.toBeNull();
    await producer!.send({
      topic: "rovenue.exposures",
      messages: [{ key: `exp_chaos_death`, value: JSON.stringify({ eventId: id }) }],
    });
    expect(await publishedAtFor(id)).toBeNull();

    // A restarted dispatcher recovers it with no special handling: the claim
    // lock died with the process and publishedAt is still null, so the row is
    // simply claimable again. The duplicate this produces in Kafka is the
    // at-least-once contract, and ClickHouse collapses it on eventId — see
    // outbox-replay-idempotency.test.ts for that half.
    await runOnce(producer!);
    expect(await publishedAtFor(id)).not.toBeNull();
  }, 30_000);

  it("marks nothing published when the broker rejects the send", async () => {
    const db = getDb();
    await db.execute(sql`DELETE FROM outbox_events WHERE id LIKE 'evt_test_chaos_%'`);
    topicBackoff.clear();
    const id = await seedExposure(`outage_${Date.now()}`);

    // A broker outage from the dispatcher's point of view. The invariant is
    // one-directional: a failed send must never advance publishedAt. Marking
    // it would drop the event permanently — no downstream dedupe can recover
    // something that was never delivered.
    const brokenProducer = {
      send: () => Promise.reject(new Error("Broker not available")),
    } as unknown as NonNullable<Awaited<ReturnType<typeof getProducer>>>;

    await runOnce(brokenProducer);
    expect(await publishedAtFor(id)).toBeNull();

    // And the topic enters backoff rather than spinning on a dead broker.
    // This is why recovery is not instant, which the next test relies on
    // knowing — a test that simply retried would have failed and looked like
    // data loss.
    const state = getBackoffState("rovenue.exposures");
    expect(state?.consecutiveFailures).toBeGreaterThan(0);
    expect(state?.nextAttemptAt).toBeGreaterThan(Date.now());
  }, 30_000);

  it("drains the backlog once the broker is back and the backoff has passed", async () => {
    const db = getDb();
    await db.execute(sql`DELETE FROM outbox_events WHERE id LIKE 'evt_test_chaos_%'`);
    topicBackoff.clear();
    const id = await seedExposure(`recover_${Date.now()}`);

    const brokenProducer = {
      send: () => Promise.reject(new Error("Broker not available")),
    } as unknown as NonNullable<Awaited<ReturnType<typeof getProducer>>>;
    await runOnce(brokenProducer);
    expect(await publishedAtFor(id)).toBeNull();

    // Clearing the backoff stands in for waiting it out — the window is real
    // and deliberate, and sleeping through it would only make this test slow.
    // What matters is that nothing else had to happen: no manual replay, no
    // operator step, no lost row.
    topicBackoff.clear();
    const producer = await getProducer();
    await runOnce(producer!);
    expect(await publishedAtFor(id)).not.toBeNull();
  }, 30_000);
});
