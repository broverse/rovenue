// =============================================================
// CH Kafka Engine parity — integration test
// =============================================================
//
// End-to-end proof that the outbox → Redpanda → ClickHouse
// Kafka Engine → MV → SummingMergeTree pipeline works as a unit.
//
// Shape:
//   1. Spin a testcontainers Network.
//   2. Start Redpanda on the network (alias "redpanda") with dual
//      listeners: INTERNAL (for CH container-to-container) and
//      EXTERNAL (for the Node test and the outbox-dispatcher
//      under test, which runs in-process).
//   3. Start ClickHouse on the same network, wire the Kafka
//      broker list to `redpanda:9092` (the INTERNAL listener).
//   4. Shell out to the CH migration runner (not exported as a
//      library — see plan G.1 note, Option A). This creates
//      `exposures_queue` (Kafka Engine), `raw_exposures`
//      (ReplacingMergeTree), `mv_exposures_to_raw`, and the
//      `mv_experiment_daily` → `mv_experiment_daily_target`
//      SummingMergeTree rollup.
//   5. Insert an outbox row via the shared dev Postgres (same
//      pattern as the Phase D integration test — we reuse the
//      local dev DB rather than spinning a testcontainers
//      Postgres to keep runtime under 2 min).
//   6. Run the dispatcher in the background. It picks up the
//      outbox row, publishes to `rovenue.exposures`, CH consumes
//      via the Kafka Engine, the MV inserts into raw_exposures,
//      and the second MV rolls up into mv_experiment_daily_target.
//   7. Poll `raw_exposures FINAL` until the row shows up, then
//      assert the rollup has exactly one exposure.
//
// NOT parallel-safe: binds host port 19094 (broker) — do not run
// alongside the Phase D outbox-dispatcher integration test (which
// takes 19093) or the G.2 replay idempotency test.
//
// DATABASE_URL fallback: we reuse the shared dev-compose Postgres
// (rovenue/rovenue @ localhost:5433) for outbox inserts, matching
// the Phase D integration test. The setup.ts default points at
// :5432 with a `postgres` role that doesn't exist on dev laptops,
// so we explicitly overwrite DATABASE_URL here before `@rovenue/db`
// is imported by the dispatcher.

// Force to the dev-compose Postgres, overriding tests/setup.ts's
// bogus default. If the developer already set DATABASE_URL on the
// command line (e.g. in CI), respect that.
if (
  !process.env.DATABASE_URL ||
  process.env.DATABASE_URL.includes("localhost:5432/rovenue_test")
) {
  process.env.DATABASE_URL =
    "postgresql://rovenue:rovenue@localhost:5433/rovenue";
}

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GenericContainer,
  Network,
  type StartedNetwork,
  type StartedTestContainer,
} from "testcontainers";
import { createClient } from "@clickhouse/client";
import { Kafka } from "kafkajs";
import { sql } from "drizzle-orm";
import { drizzle, getDb } from "@rovenue/db";
import {
  runOutboxDispatcher,
  stopOutboxDispatcher,
} from "../src/workers/outbox-dispatcher";
import { getResolvedBrokers } from "../src/lib/kafka";

const execFileP = promisify(execFile);

let network: StartedNetwork;
let redpanda: StartedTestContainer;
let clickhouse: StartedTestContainer;
let brokerUrl: string;
let chUrl: string;

// Container-side external listener port must equal host mapped
// port so the advertised bootstrap address resolves from the
// host. Fixed port (no dynamic mapping) because Redpanda needs
// the advertised address at container start.
const BROKER_EXTERNAL_PORT = 19094;
const CH_HOST_PORT = 8223;

beforeAll(async () => {
  network = await new Network().start();

  redpanda = await new GenericContainer("redpandadata/redpanda:v24.2.13")
    .withNetwork(network)
    .withNetworkAliases("redpanda")
    .withCommand([
      "redpanda",
      "start",
      "--smp=1",
      "--memory=512M",
      "--overprovisioned",
      "--node-id=0",
      "--check=false",
      `--kafka-addr=INTERNAL://0.0.0.0:9092,EXTERNAL://0.0.0.0:${BROKER_EXTERNAL_PORT}`,
      `--advertise-kafka-addr=INTERNAL://redpanda:9092,EXTERNAL://localhost:${BROKER_EXTERNAL_PORT}`,
    ])
    .withExposedPorts({
      container: BROKER_EXTERNAL_PORT,
      host: BROKER_EXTERNAL_PORT,
    })
    .start();
  brokerUrl = `localhost:${BROKER_EXTERNAL_PORT}`;

  // Pre-create the `rovenue.exposures` topic BEFORE CH boots its
  // Kafka Engine consumer against it. Redpanda has auto-create off
  // in our config, and librdkafka inside CH will silently skip
  // missing topics until it next polls — the test window is too
  // tight to rely on that retry, so we create the topic here and
  // let CH attach to a real topic on first boot.
  const kafkaAdmin = new Kafka({
    clientId: "ch-parity-setup",
    brokers: [brokerUrl],
  }).admin();
  await kafkaAdmin.connect();
  await kafkaAdmin.createTopics({
    topics: [{ topic: "rovenue.exposures", numPartitions: 3 }],
  });
  await kafkaAdmin.disconnect();

  // CH must talk to Redpanda over the cluster-internal listener
  // (redpanda:9092) — the advertised EXTERNAL address resolves
  // to localhost, which inside the CH container would mean the
  // CH container itself.
  // Note: we deliberately do NOT mount a <kafka> config.xml
  // snippet here. CH 24.3's cppkafka rejects `kafka.broker.list`
  // from global config (the librdkafka property name is
  // `metadata.broker.list` / `bootstrap.servers`). The
  // `exposures_queue` CREATE TABLE already names the broker via
  // its SETTINGS clause, which is the only config surface we
  // actually need for the test — and which matches the live
  // dev-compose setup.
  clickhouse = await new GenericContainer("clickhouse/clickhouse-server:24.3-alpine")
    .withNetwork(network)
    .withNetworkAliases("clickhouse")
    .withExposedPorts({ container: 8123, host: CH_HOST_PORT })
    .withEnvironment({
      CLICKHOUSE_DB: "default",
      CLICKHOUSE_USER: "rovenue",
      CLICKHOUSE_PASSWORD: "rovenue_test",
      CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: "1",
    })
    .start();
  chUrl = `http://localhost:${CH_HOST_PORT}`;

  // Late-binding env for the dispatcher and (via child_process
  // env inheritance) for the CH migration runner.
  process.env.KAFKA_BROKERS = brokerUrl;
  process.env.CLICKHOUSE_URL = chUrl;
  process.env.CLICKHOUSE_USER = "rovenue";
  process.env.CLICKHOUSE_PASSWORD = "rovenue_test";

  // Wait for CH HTTP interface to reliably accept authenticated
  // SELECT queries. The official image's entrypoint creates the
  // custom user in a second pass after first boot — we need
  // three consecutive successful authenticated queries before
  // we trust the server has settled, otherwise the migration
  // runner races the mid-restart window and hits ECONNRESET.
  let stableSuccesses = 0;
  await waitFor(async () => {
    try {
      const ch = createClient({
        url: chUrl,
        username: "rovenue",
        password: "rovenue_test",
      });
      const res = await ch.query({
        query: "SELECT 1 AS ok",
        format: "JSONEachRow",
      });
      const rows = (await res.json()) as Array<{ ok: number }>;
      await ch.close();
      if (rows[0]?.ok === 1) {
        stableSuccesses++;
        return stableSuccesses >= 3;
      }
      stableSuccesses = 0;
      return false;
    } catch {
      stableSuccesses = 0;
      return false;
    }
  }, 45_000);

  // Apply CH migrations 0001→0003 by shelling out to the
  // package script — the runner is a top-level module, not a
  // library function, so we run it as-is. Inherits the env we
  // set above.
  await execFileP(
    "pnpm",
    ["--filter", "@rovenue/db", "db:clickhouse:migrate"],
    {
      env: {
        ...process.env,
        CLICKHOUSE_URL: chUrl,
        CLICKHOUSE_USER: "rovenue",
        CLICKHOUSE_PASSWORD: "rovenue_test",
      },
      timeout: 60_000,
    },
  );
}, 180_000);

afterAll(async () => {
  stopOutboxDispatcher();
  await clickhouse?.stop();
  await redpanda?.stop();
  await network?.stop();
});

describe("CH Kafka Engine parity", () => {
  it("raw_exposures and mv_experiment_daily_target receive outbox events", async () => {
    // Prove the dispatcher under test is going to hit our
    // testcontainer broker, not a stale .env value.
    expect(getResolvedBrokers()).toBe(brokerUrl);

    const db = getDb();
    // Drain any stale parity rows from prior runs against the
    // shared dev DB so the dispatcher claims only our fresh row.
    await db.execute(
      sql`DELETE FROM outbox_events WHERE id LIKE 'evt_parity_%'`,
    );

    const id = `evt_parity_${Date.now()}`;
    const projectId = `prj_parity_${Date.now()}`;
    const experimentId = `exp_parity_${Date.now()}`;
    await drizzle.outboxRepo.insert(db, {
      id,
      aggregateType: "EXPOSURE",
      aggregateId: experimentId,
      eventType: "experiment.exposure.recorded",
      payload: {
        experimentId,
        variantId: "var_a",
        projectId,
        subscriberId: "sub_1",
        platform: "ios",
        country: "US",
        exposedAt: "2026-04-24T10:00:00.000Z",
      },
    });

    void runOutboxDispatcher();

    const ch = createClient({
      url: chUrl,
      username: "rovenue",
      password: "rovenue_test",
      database: "rovenue",
    });

    // Poll raw_exposures FINAL — the Kafka Engine + MV pipeline
    // has noticeable latency on cold start (CH discovers the
    // topic, group joins, librdkafka first poll). 90s is the ceiling
    // we've observed on a laptop; CI should be well under.
    await waitFor(async () => {
      const res = await ch.query({
        query: `SELECT count() AS c FROM rovenue.raw_exposures FINAL WHERE eventId = '${id}'`,
        format: "JSONEachRow",
      });
      const rows = (await res.json()) as Array<{ c: string | number }>;
      return Number(rows[0]?.c ?? 0) === 1;
    }, 90_000);

    // Rollup assertion. SummingMergeTree may not have merged yet,
    // so sum() across parts is how we read — exactly like the
    // experiments/results endpoint does.
    const rollup = await ch.query({
      query: `SELECT sum(exposures) AS e FROM rovenue.mv_experiment_daily_target WHERE projectId = '${projectId}'`,
      format: "JSONEachRow",
    });
    const rollupRows = (await rollup.json()) as Array<{ e: string | number }>;
    expect(Number(rollupRows[0]?.e ?? 0)).toBe(1);

    await ch.close();
  }, 180_000);
});

async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      if (await fn()) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(
    `waitFor timed out after ${timeoutMs}ms${
      lastErr ? `: ${(lastErr as Error).message}` : ""
    }`,
  );
}
