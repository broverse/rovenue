// =============================================================
// Task 6: the credit-pack revenue metrics finally read money
// =============================================================
//
// services/metrics/credits.ts's `readKpis` (Postgres, revenue_events
// filtered `type = 'CREDIT_PURCHASE'`) and `readPackages` (ClickHouse,
// raw_revenue_events filtered the same way) have returned zero since the
// day they were written: nothing in the repository ever wrote
// CREDIT_PURCHASE — every one-time Apple/Google purchase, consumable or
// not, was recorded as INITIAL (see receipt-verify.ts). Task 6 makes
// `oneTimeRevenueTypeFor` the thing that writes it.
//
// Every existing unit test for credits.ts mocks ClickHouse
// (credits.test.ts) or exercises Postgres alone
// (credits.liability-daily.integration.test.ts); schema-contract.
// integration.test.ts calls the real `getCreditsRollup` but seeds NO
// rows on purpose (it is a schema-validity check, not a data check — see
// its header). None of them can catch "the filter matches nothing" the
// way a mock always agrees with itself. This test writes a real
// CREDIT_PURCHASE row to BOTH stores (Postgres via the actual repository
// `createRevenueEvent` uses in production, ClickHouse via a direct
// `raw_revenue_events` insert standing in for the outbox->Kafka->CH
// pipeline) and asserts the dashboard's own entry point,
// `getCreditsRollup`, reports real money — not a re-typed copy of the
// query asserting on itself.
//
// Fixed host port: CH_HOST_PORT = 8236 (not parallel-safe; see
// tests/host-port-allocations.test.ts — not used by any other
// integration test as of this writing).

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { createClient, type ClickHouseClient } from "@clickhouse/client";
import { drizzle } from "@rovenue/db";
import { __resetClickHouseForTests } from "../src/lib/clickhouse";
import { env } from "../src/lib/env";
import { getCreditsRollup } from "../src/services/metrics/credits";

const CH_HOST_PORT = 8236;
const CH_USER = "rovenue";
const CH_PASSWORD = "rovenue_test";
const PURCHASE_AMOUNT_USD = 9.99;
const WINDOW_DAYS = 7;

const RUN_ID = Date.now();
const PROJECT_ID = `prj_credits_${RUN_ID}`;
const SUBSCRIBER_ID = `sub_credits_${RUN_ID}`;
const PRODUCT_ID = `prod_credits_${RUN_ID}`;
const PURCHASE_ID = `pur_credits_${RUN_ID}`;
const STORE_TRANSACTION_ID = `txn_credits_${RUN_ID}`;

let clickhouse: StartedTestContainer;
let ch: ClickHouseClient;

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
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `waitFor timed out after ${timeoutMs}ms${
      lastErr ? `: ${(lastErr as Error).message}` : ""
    }`,
  );
}

beforeAll(async () => {
  // --- Postgres side: a project/subscriber/product/purchase, then the
  // SAME repository call receipt-verify.ts and the importer use to write
  // revenue — proves the write path, not a hand-typed row shape. ---
  await drizzle.db.insert(drizzle.schema.projects).values({
    id: PROJECT_ID,
    name: `Credits ${RUN_ID}`,
  });
  await drizzle.db.insert(drizzle.schema.subscribers).values({
    id: SUBSCRIBER_ID,
    projectId: PROJECT_ID,
    rovenueId: `rv_credits_${RUN_ID}`,
  });
  await drizzle.db.insert(drizzle.schema.products).values({
    id: PRODUCT_ID,
    projectId: PROJECT_ID,
    identifier: "com.app.coins.credits_test",
    type: "CONSUMABLE",
    storeIds: { apple: "com.app.coins.credits_test" },
    displayName: "500 Gold Coins",
  });
  const eventDate = new Date();
  await drizzle.db.insert(drizzle.schema.purchases).values({
    id: PURCHASE_ID,
    projectId: PROJECT_ID,
    subscriberId: SUBSCRIBER_ID,
    productId: PRODUCT_ID,
    store: "APP_STORE",
    storeTransactionId: STORE_TRANSACTION_ID,
    originalTransactionId: STORE_TRANSACTION_ID,
    status: "ACTIVE",
    environment: "PRODUCTION",
    purchaseDate: eventDate,
    originalPurchaseDate: eventDate,
    priceAmount: PURCHASE_AMOUNT_USD.toString(),
    priceCurrency: "USD",
  });
  await drizzle.revenueEventRepo.createRevenueEvent(drizzle.db, {
    projectId: PROJECT_ID,
    subscriberId: SUBSCRIBER_ID,
    purchaseId: PURCHASE_ID,
    productId: PRODUCT_ID,
    type: "CREDIT_PURCHASE",
    amount: PURCHASE_AMOUNT_USD.toString(),
    currency: "USD",
    amountUsd: PURCHASE_AMOUNT_USD.toString(),
    store: "APP_STORE",
    eventDate,
    dedupeKey: `apple:${STORE_TRANSACTION_ID}:purchase`,
  });

  // --- ClickHouse side: a real, migrated ClickHouse, with the same
  // economic event written directly into raw_revenue_events (standing in
  // for the outbox dispatcher's Kafka publish, which this test does not
  // need to prove — that path has its own coverage, e.g.
  // outbox-revenue-credit-replay.integration.test.ts). ---
  clickhouse = await new GenericContainer(
    "clickhouse/clickhouse-server:24.3-alpine",
  )
    .withExposedPorts({ container: 8123, host: CH_HOST_PORT })
    .withEnvironment({
      CLICKHOUSE_DB: "default",
      CLICKHOUSE_USER: CH_USER,
      CLICKHOUSE_PASSWORD: CH_PASSWORD,
      CLICKHOUSE_DEFAULT_ACCESS_MANAGEMENT: "1",
    })
    .start();
  const chUrl = `http://localhost:${CH_HOST_PORT}`;

  let stableSuccesses = 0;
  await waitFor(async () => {
    const probe = createClient({
      url: chUrl,
      username: CH_USER,
      password: CH_PASSWORD,
    });
    try {
      const res = await probe.query({
        query: "SELECT 1 AS ok",
        format: "JSONEachRow",
      });
      const rows = (await res.json()) as Array<{ ok: number }>;
      if (rows[0]?.ok === 1) {
        stableSuccesses++;
        return stableSuccesses >= 3;
      }
      stableSuccesses = 0;
      return false;
    } finally {
      await probe.close();
    }
  }, 45_000);

  // Apply every ClickHouse migration so the schema under test is the real
  // one (verbatim pattern from clickhouse-revenue-type-contract.
  // integration.test.ts / mrr-clickhouse-only.integration.test.ts).
  const { createHash } = await import("node:crypto");
  const { readFile, readdir } = await import("node:fs/promises");
  const { join } = await import("node:path");

  const bootstrap = createClient({
    url: chUrl,
    username: CH_USER,
    password: CH_PASSWORD,
    database: "default",
    request_timeout: 60_000,
  });
  await bootstrap.command({ query: "CREATE DATABASE IF NOT EXISTS rovenue" });
  await bootstrap.command({
    query: `CREATE TABLE IF NOT EXISTS rovenue._migrations (
      filename String,
      sha256 FixedString(64),
      applied_at DateTime64(3, 'UTC') DEFAULT now64(3, 'UTC')
    ) ENGINE = ReplacingMergeTree(applied_at) ORDER BY filename`,
  });
  await bootstrap.close();

  const mig = createClient({
    url: chUrl,
    username: CH_USER,
    password: CH_PASSWORD,
    database: "rovenue",
    request_timeout: 60_000,
  });
  const migrationsDir = join(
    process.cwd(),
    "..",
    "..",
    "packages",
    "db",
    "clickhouse",
    "migrations",
  );
  const files = (await readdir(migrationsDir))
    .filter((f) => f.endsWith(".sql"))
    .sort();
  for (const filename of files) {
    const content = await readFile(join(migrationsDir, filename), "utf8");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const statements = content
      .split(/;\s*$/m)
      .map((s) => {
        const lines = s.split("\n");
        const i = lines.findIndex(
          (l) => l.trim().length > 0 && !l.trim().startsWith("--"),
        );
        return i >= 0 ? lines.slice(i).join("\n").trim() : "";
      })
      .filter((s) => s.length > 0);
    for (const statement of statements) {
      await mig.command({ query: statement });
      // No Kafka broker in this test (raw_revenue_events is written
      // directly below, bypassing the queue+materialized-view it feeds),
      // but the Kafka-engine table itself still needs to exist as an
      // object before a later migration's materialized view can select
      // from it — same wait as clickhouse-revenue-type-contract.
      // integration.test.ts / mrr-clickhouse-only.integration.test.ts.
      if (statement.includes("ENGINE = Kafka")) {
        const m = /CREATE TABLE IF NOT EXISTS (\S+)/.exec(statement);
        if (m) {
          const [dbN, tN] = m[1]!.includes(".")
            ? (m[1]!.split(".") as [string, string])
            : ["rovenue", m[1]!];
          await waitFor(async () => {
            const res = await mig.query({
              query: `SELECT count() AS c FROM system.tables WHERE database='${dbN}' AND name='${tN}'`,
              format: "JSONEachRow",
            });
            const rows = (await res.json()) as Array<{
              c: string | number;
            }>;
            return Number(rows[0]?.c ?? 0) >= 1;
          }, 15_000);
          await new Promise((r) => setTimeout(r, 3_000));
        }
      }
    }
    await mig.insert({
      table: "_migrations",
      values: [{ filename, sha256 }],
      format: "JSONEachRow",
    });
  }
  await mig.close();

  ch = createClient({
    url: chUrl,
    username: CH_USER,
    password: CH_PASSWORD,
    database: "rovenue",
    request_timeout: 60_000,
  });

  const eventId = `evt_credits_${RUN_ID}`;
  await ch.insert({
    table: "raw_revenue_events",
    values: [
      {
        eventId,
        revenueEventId: `rev_${eventId}`,
        projectId: PROJECT_ID,
        subscriberId: SUBSCRIBER_ID,
        purchaseId: PURCHASE_ID,
        productId: PRODUCT_ID,
        type: "CREDIT_PURCHASE",
        store: "APP_STORE",
        amount: PURCHASE_AMOUNT_USD.toFixed(4),
        amountUsd: PURCHASE_AMOUNT_USD.toFixed(4),
        currency: "USD",
        eventDate: eventDate.toISOString().replace("T", " ").slice(0, 23),
        ingestedAt: eventDate.toISOString().replace("T", " ").slice(0, 23),
        _version: 1,
      },
    ],
    format: "JSONEachRow",
  });

  // `env` is parsed once at import; a later process.env write alone is
  // invisible to lib/clickhouse.ts's already-built singleton. Mutate the
  // shared env object directly and drop the memoised client — the same
  // workaround schema-contract.integration.test.ts uses.
  const mEnv = env as {
    CLICKHOUSE_URL?: string;
    CLICKHOUSE_USER?: string;
    CLICKHOUSE_PASSWORD?: string;
  };
  mEnv.CLICKHOUSE_URL = chUrl;
  mEnv.CLICKHOUSE_USER = CH_USER;
  mEnv.CLICKHOUSE_PASSWORD = CH_PASSWORD;
  process.env.CLICKHOUSE_URL = chUrl;
  process.env.CLICKHOUSE_USER = CH_USER;
  process.env.CLICKHOUSE_PASSWORD = CH_PASSWORD;
  __resetClickHouseForTests();
}, 180_000);

afterAll(async () => {
  await ch?.close();
  await clickhouse?.stop();
  // Cascades to subscribers/purchases/revenue_events via their
  // onDelete: "cascade" FKs onto projects.id.
  await drizzle.db
    .delete(drizzle.schema.projects)
    .where(eq(drizzle.schema.projects.id, PROJECT_ID));
});

describe("getCreditsRollup — credit-pack revenue is no longer zero", () => {
  it("reports credit-pack revenue that a consumable purchase produced", async () => {
    // credits.ts's readKpis (Postgres) and readPackages (ClickHouse) both
    // filter `type = 'CREDIT_PURCHASE'`, and — before Task 6 — nothing in
    // the repository had ever written that type, so both of these
    // dashboard numbers were always zero. This is the assertion that
    // says they are not any more.
    const result = await getCreditsRollup({
      projectId: PROJECT_ID,
      windowDays: WINDOW_DAYS,
    });

    expect(Number(result.kpis.revenue28dUsd)).toBeCloseTo(
      PURCHASE_AMOUNT_USD,
      2,
    );

    expect(result.packages).toHaveLength(1);
    expect(result.packages[0]).toMatchObject({
      productId: PRODUCT_ID,
      identifier: "com.app.coins.credits_test",
      displayName: "500 Gold Coins",
      sold: 1,
    });
    expect(Number(result.packages[0]!.revenueUsd)).toBeCloseTo(
      PURCHASE_AMOUNT_USD,
      2,
    );
  });
}, 60_000);
