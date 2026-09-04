// =============================================================
// Contract test: v_revenue_lifetime_subscriber's purchased-bucket
// `IN (...)` allow-list vs. REVENUE_TYPES_LIFETIME_PURCHASED
// (@rovenue/shared).
//
// The view is a SQL file (packages/db/clickhouse/migrations) and cannot
// import the TypeScript grouping constant, so this test — run against a
// REAL testcontainer ClickHouse with every migration applied — is the
// only thing that ever holds the two in step. Mocking ClickHouse here
// would only assert that a mock agrees with itself; see
// packages/shared/src/revenue-types.ts for the rest of the contract.
//
// Fixed host port: CH_HOST_PORT = 8235 (not parallel-safe; not used by
// any other integration test as of this writing).
// =============================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { ALL_REVENUE_TYPES, REVENUE_TYPES_LIFETIME_PURCHASED } from "@rovenue/shared";

let clickhouse: StartedTestContainer;
let ch: ClickHouseClient;
const CH_HOST_PORT = 8235;
const CENTS_PER_ROW = 1000; // one $10.00 row per type, in cents

async function waitFor(fn: () => Promise<boolean>, timeoutMs: number): Promise<void> {
  const start = Date.now();
  let lastErr: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      if (await fn()) return;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms${lastErr ? `: ${(lastErr as Error).message}` : ""}`);
}

async function insertRawRevenueEvent(
  client: ClickHouseClient,
  opts: { projectId: string; subscriberId: string; type: string; amountUsd: number },
): Promise<void> {
  const eventId = `evt_${opts.type}_${opts.projectId}`;
  await client.insert({
    table: "raw_revenue_events",
    values: [
      {
        eventId,
        revenueEventId: `rev_${eventId}`,
        projectId: opts.projectId,
        subscriberId: opts.subscriberId,
        purchaseId: `pur_${eventId}`,
        productId: `prod_${eventId}`,
        type: opts.type,
        store: "APP_STORE",
        amount: opts.amountUsd.toFixed(4),
        amountUsd: opts.amountUsd.toFixed(4),
        currency: "USD",
        eventDate: "2026-09-04 00:00:00.000",
        ingestedAt: "2026-09-04 00:00:00.000",
        _version: 1,
      },
    ],
    format: "JSONEachRow",
  });
}

beforeAll(async () => {
  clickhouse = await new GenericContainer("clickhouse/clickhouse-server:24.3-alpine")
    .withExposedPorts({ container: 8123, host: CH_HOST_PORT })
    .withEnvironment({
      CLICKHOUSE_DB: "default",
      CLICKHOUSE_USER: "rovenue",
      CLICKHOUSE_PASSWORD: "rovenue_test",
      CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: "1",
    })
    .start();
  const chUrl = `http://localhost:${CH_HOST_PORT}`;

  let stable = 0;
  await waitFor(async () => {
    try {
      const c = createClient({ url: chUrl, username: "rovenue", password: "rovenue_test" });
      const res = await c.query({ query: "SELECT 1 AS ok", format: "JSONEachRow" });
      const rows = (await res.json()) as Array<{ ok: number }>;
      await c.close();
      if (rows[0]?.ok === 1) { stable++; return stable >= 3; }
      stable = 0; return false;
    } catch { stable = 0; return false; }
  }, 45_000);

  // --- migration runner (verbatim from mrr-clickhouse-only.integration.test.ts /
  // revenue-aggregates-idempotency.integration.test.ts) — applies EVERY .sql file
  // under packages/db/clickhouse/migrations, in order, including 0024. ---
  const { createHash } = await import("node:crypto");
  const { readFile, readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const bootstrap = createClient({ url: chUrl, username: "rovenue", password: "rovenue_test", database: "default", request_timeout: 60_000 });
  await bootstrap.command({ query: "CREATE DATABASE IF NOT EXISTS rovenue" });
  await bootstrap.command({
    query: `CREATE TABLE IF NOT EXISTS rovenue._migrations (filename String, sha256 FixedString(64), applied_at DateTime64(3,'UTC') DEFAULT now64(3,'UTC')) ENGINE = ReplacingMergeTree(applied_at) ORDER BY filename`,
  });
  await bootstrap.close();

  const chMig = createClient({ url: chUrl, username: "rovenue", password: "rovenue_test", database: "rovenue", request_timeout: 60_000 });
  const migrationsDir = join(process.cwd(), "..", "..", "packages", "db", "clickhouse", "migrations");
  const files = (await readdir(migrationsDir)).filter((f) => f.endsWith(".sql")).sort();
  for (const filename of files) {
    const content = await readFile(join(migrationsDir, filename), "utf8");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const statements = content.split(/;\s*$/m).map((s) => {
      const lines = s.split("\n");
      const i = lines.findIndex((l) => l.trim().length > 0 && !l.trim().startsWith("--"));
      return i >= 0 ? lines.slice(i).join("\n").trim() : "";
    }).filter((s) => s.length > 0);
    for (const statement of statements) {
      await chMig.command({ query: statement });
      if (statement.includes("ENGINE = Kafka")) {
        const m = /CREATE TABLE IF NOT EXISTS (\S+)/.exec(statement);
        if (m) {
          const [dbN, tN] = m[1]!.includes(".") ? m[1]!.split(".") : ["rovenue", m[1]!];
          await waitFor(async () => {
            const res = await chMig.query({ query: `SELECT count() AS c FROM system.tables WHERE database='${dbN}' AND name='${tN}'`, format: "JSONEachRow" });
            const rows = (await res.json()) as Array<{ c: string | number }>;
            return Number(rows[0]?.c ?? 0) >= 1;
          }, 15_000);
          await new Promise((r) => setTimeout(r, 3_000));
        }
      }
    }
    await chMig.insert({ table: "_migrations", values: [{ filename, sha256 }], format: "JSONEachRow" });
  }
  await chMig.close();

  ch = createClient({ url: chUrl, username: "rovenue", password: "rovenue_test", database: "rovenue", request_timeout: 60_000 });
}, 300_000);

afterAll(async () => {
  await ch?.close();
  await clickhouse?.stop();
});

describe("v_revenue_lifetime_subscriber vs. REVENUE_TYPES_LIFETIME_PURCHASED", () => {
  it("counts every type the grouping says it should", async () => {
    const projectId = `ctr_${Date.now()}`;
    const subscriberId = "s1";

    // One $10 row of EVERY enum value, so a dropped type shows up as a
    // $10 shortfall attributable by name.
    for (const type of ALL_REVENUE_TYPES) {
      await insertRawRevenueEvent(ch, { projectId, subscriberId, type, amountUsd: 10 });
    }

    const res = await ch.query({
      query: `SELECT toString(lifetime_dollars_purchased_cents) AS c
              FROM rovenue.v_revenue_lifetime_subscriber
              WHERE projectId = {p:String} AND subscriberId = {s:String}`,
      query_params: { p: projectId, s: subscriberId },
      format: "JSONEachRow",
    });
    const row = ((await res.json()) as Array<{ c: string }>)[0];

    const expected = REVENUE_TYPES_LIFETIME_PURCHASED.length * CENTS_PER_ROW;
    const actual = Number(row?.c ?? 0);

    expect(
      actual,
      `view total ${actual} != ${expected}; the view's IN list has drifted from ` +
        `REVENUE_TYPES_LIFETIME_PURCHASED (${REVENUE_TYPES_LIFETIME_PURCHASED.join(",")})`,
    ).toBe(expected);
  }, 120_000);
});
