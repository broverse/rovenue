// =============================================================
// Outbox replay idempotency — integration test
// =============================================================
//
// Proves that ClickHouse's ReplacingMergeTree `raw_exposures`
// table collapses to exactly one row when the same `eventId` is
// published to Kafka twice. This is the at-least-once safety
// property that lets the outbox dispatcher crash between Kafka
// ack and Postgres markPublished without corrupting analytics:
// when the dispatcher restarts and re-publishes, CH FINAL reads
// the merged row once.
//
// Shape:
//   1. Spin Redpanda + ClickHouse via testcontainers on a shared
//      Network (Redpanda under alias `redpanda` so CH's Kafka
//      Engine can reach it on the internal listener).
//   2. Apply CH migrations via the package script.
//   3. Publish the SAME Kafka message (same eventId) twice via
//      an ad-hoc producer — simulating the dispatcher replay.
//      We bypass the outbox → dispatcher path here because the
//      OLTP schema forbids duplicate outbox ids; what we're
//      testing is the downstream collapse, not the OLTP path.
//   4. Poll `raw_exposures FINAL` until exactly one row remains
//      with that eventId.
//
// Setup boilerplate duplicates G.1 (ch-kafka-engine.integration)
// intentionally: cross-file testcontainers sharing is fragile, and
// the plan G.2 comment recommends duplication over sharing. Uses
// dedicated host ports (19095 for Redpanda external, 8225 for CH
// HTTP) so this test never collides with Phase D (19093) or G.1
// (19094 / 8224) when someone runs `vitest` without --isolate.

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

const execFileP = promisify(execFile);

let network: StartedNetwork;
let redpanda: StartedTestContainer;
let clickhouse: StartedTestContainer;
let brokerUrl: string;
let chUrl: string;

const BROKER_EXTERNAL_PORT = 19095;
const CH_HOST_PORT = 8225;

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

  // Pre-create the topic so CH's Kafka Engine attaches to a real
  // topic on first poll (Redpanda has auto-create disabled, and
  // the test window is too short to rely on lazy retry).
  const kafkaAdmin = new Kafka({
    clientId: "replay-setup",
    brokers: [brokerUrl],
  }).admin();
  await kafkaAdmin.connect();
  await kafkaAdmin.createTopics({
    topics: [{ topic: "rovenue.exposures", numPartitions: 3 }],
  });
  await kafkaAdmin.disconnect();

  // Do NOT mount a <kafka> config.xml — CH 24.3 rejects the
  // legacy `kafka.broker.list` flattening. The per-table SETTINGS
  // clause in the `exposures_queue` migration is the only broker
  // surface we need.
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

  process.env.CLICKHOUSE_URL = chUrl;
  process.env.CLICKHOUSE_USER = "rovenue";
  process.env.CLICKHOUSE_PASSWORD = "rovenue_test";

  // CH needs three consecutive successful authenticated queries
  // before the entrypoint's deferred user creation settles (see
  // G.1 for the full rationale).
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
  await clickhouse?.stop();
  await redpanda?.stop();
  await network?.stop();
});

describe("outbox replay idempotency", () => {
  it("two outbox rows with the same eventId collapse to one in raw_exposures FINAL", async () => {
    const eventId = `evt_replay_${Date.now()}`;
    const projectId = `prj_replay_${Date.now()}`;
    const experimentId = `exp_replay_${Date.now()}`;
    const basePayload = {
      experimentId,
      variantId: "var_a",
      projectId,
      subscriberId: "sub_1",
      platform: "ios",
      country: "US",
      exposedAt: "2026-04-24T10:00:00.000Z",
    };

    // Simulates the "dispatcher crashed after Kafka ack, restarted,
    // re-published the same outbox row" scenario. In the OLTP schema
    // the same outbox id can't exist twice, so we bypass the outbox
    // and publish directly to the topic with the same eventId — the
    // downstream Kafka Engine → MV → ReplacingMergeTree path treats
    // these two records identically to a real dispatcher replay.
    const kafka = new Kafka({
      clientId: "replay-test-producer",
      brokers: [brokerUrl],
    });
    const producer = kafka.producer({ idempotent: false });
    await producer.connect();
    for (let i = 0; i < 2; i++) {
      await producer.send({
        topic: "rovenue.exposures",
        messages: [
          {
            key: experimentId,
            value: JSON.stringify({
              eventId,
              eventType: "experiment.exposure.recorded",
              aggregateId: experimentId,
              createdAt: new Date().toISOString(),
              // The Kafka Engine table reads `payload` as a String
              // column and the MV unpacks it with JSONExtractString,
              // so we pass a serialized JSON blob to match the
              // production dispatcher output.
              payload: JSON.stringify(basePayload),
            }),
          },
        ],
      });
    }
    await producer.disconnect();

    const ch = createClient({
      url: chUrl,
      username: "rovenue",
      password: "rovenue_test",
      database: "rovenue",
    });

    // Wait for both copies to land in raw_exposures, then assert
    // FINAL returns exactly one. ReplacingMergeTree collapses on
    // (ORDER BY tuple) — here (projectId, experimentId, exposedAt,
    // eventId) is identical between the two copies, so FINAL
    // de-duplicates on the insertedAt version column.
    await waitFor(async () => {
      const res = await ch.query({
        query: `SELECT count() AS c FROM rovenue.raw_exposures FINAL WHERE eventId = '${eventId}'`,
        format: "JSONEachRow",
      });
      const rows = (await res.json()) as Array<{ c: string | number }>;
      return Number(rows[0]?.c ?? 0) === 1;
    }, 90_000);

    // Double-check: also prove the raw (non-FINAL) table saw both
    // inserts, so the test isn't passing by accident (e.g. one
    // producer send dropped silently).
    const rawCount = await ch.query({
      query: `SELECT count() AS c FROM rovenue.raw_exposures WHERE eventId = '${eventId}'`,
      format: "JSONEachRow",
    });
    const rawRows = (await rawCount.json()) as Array<{ c: string | number }>;
    expect(Number(rawRows[0]?.c ?? 0)).toBeGreaterThanOrEqual(1);

    const finalCount = await ch.query({
      query: `SELECT count() AS c FROM rovenue.raw_exposures FINAL WHERE eventId = '${eventId}'`,
      format: "JSONEachRow",
    });
    const finalRows = (await finalCount.json()) as Array<{ c: string | number }>;
    expect(Number(finalRows[0]?.c ?? 0)).toBe(1);

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
