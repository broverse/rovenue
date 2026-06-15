// =============================================================
// Revenue/credit aggregate idempotency — duplicate eventId must
// not double-count. Inserts the SAME eventId twice directly into
// the raw ReplacingMergeTree tables and asserts each query-time
// view (0012) collapses it to one contribution.
//
// CH-only (no Kafka): FINAL / GROUP BY eventId dedup at query time,
// so no merge wait is required.
//
// Fixed host port: CH_HOST_PORT = 8229 (not parallel-safe).
// =============================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer, type StartedTestContainer } from "testcontainers";
import { createClient, type ClickHouseClient } from "@clickhouse/client";

let clickhouse: StartedTestContainer;
let ch: ClickHouseClient;
const CH_HOST_PORT = 8229;

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

  // --- migration runner (verbatim from mrr-clickhouse-only.integration.test.ts) ---
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

describe("revenue/credit aggregate idempotency", () => {
  it("does not double-count a duplicate eventId", async () => {
    const RUN = Date.now();
    const projectId = `prj_idem_${RUN}`;
    const subscriberId = `sub_idem_${RUN}`;
    const revEventId = `evt_rev_${RUN}`;
    const credEventId = `evt_cred_${RUN}`;

    // Same revenue eventId inserted TWICE (duplicate delivery). _version differs
    // so ReplacingMergeTree keeps the newer; the dollar figure must count ONCE.
    const revRow = (version: number) => ({
      eventId: revEventId,
      revenueEventId: `rev_${RUN}`,
      projectId, subscriberId,
      purchaseId: `pur_${RUN}`, productId: `prod_${RUN}`,
      type: "INITIAL", store: "APP_STORE",
      amount: "5.0000", amountUsd: "5.0000", currency: "USD",
      eventDate: "2026-05-01 00:00:00.000",
      ingestedAt: "2026-05-01 00:00:00.000",
      _version: version,
    });
    await ch.insert({ table: "raw_revenue_events", values: [revRow(1)], format: "JSONEachRow" });
    await ch.insert({ table: "raw_revenue_events", values: [revRow(2)], format: "JSONEachRow" });

    const credRow = (version: number) => ({
      eventId: credEventId,
      creditLedgerId: `cl_${RUN}`,
      projectId, subscriberId,
      type: "PURCHASE", amount: 100, balance: 100,
      referenceType: "purchase", referenceId: `pur_${RUN}`,
      createdAt: "2026-05-01 00:00:00.000",
      ingestedAt: "2026-05-01 00:00:00.000",
      _version: version,
    });
    await ch.insert({ table: "raw_credit_ledger", values: [credRow(1)], format: "JSONEachRow" });
    await ch.insert({ table: "raw_credit_ledger", values: [credRow(2)], format: "JSONEachRow" });

    const one = async (sql: string): Promise<Record<string, string>> => {
      const res = await ch.query({ query: sql, query_params: { pid: projectId, sid: subscriberId }, format: "JSONEachRow" });
      const rows = (await res.json()) as Array<Record<string, string>>;
      return rows[0] ?? {};
    };

    // v_mrr_daily: gross_usd = 5 (counted once), event_count = 1, active_subscribers = 1
    const mrr = await one(`SELECT toString(gross_usd) AS gross_usd, toUInt64(event_count) AS event_count, toUInt64(active_subscribers) AS active_subscribers FROM rovenue.v_mrr_daily WHERE projectId = {pid:String}`);
    expect(Number(mrr.gross_usd)).toBeCloseTo(5, 2);
    expect(Number(mrr.event_count)).toBe(1);
    expect(Number(mrr.active_subscribers)).toBe(1);

    // v_revenue_lifetime_subscriber: purchased = 500 cents (once)
    const life = await one(`SELECT toString(lifetime_dollars_purchased_cents) AS purchased FROM rovenue.v_revenue_lifetime_subscriber WHERE projectId = {pid:String} AND subscriberId = {sid:String}`);
    expect(Number(life.purchased)).toBe(500);

    // v_credit_consumption_daily: granted = 100 (once)
    const cons = await one(`SELECT toString(granted_credits) AS granted, toUInt64(event_count) AS event_count FROM rovenue.v_credit_consumption_daily WHERE projectId = {pid:String}`);
    expect(Number(cons.granted)).toBe(100);
    expect(Number(cons.event_count)).toBe(1);

    // v_credit_balance: total_granted = 100, latest_balance = 100 (once)
    const bal = await one(`SELECT toString(total_granted) AS total_granted, toString(latest_balance) AS latest_balance FROM rovenue.v_credit_balance WHERE projectId = {pid:String} AND subscriberId = {sid:String}`);
    expect(Number(bal.total_granted)).toBe(100);
    expect(Number(bal.latest_balance)).toBe(100);
  }, 120_000);

  // 0013: v_revenue_lifetime_subscriber must round cents (not truncate the
  // binary-float product) and treat CHARGEBACK as a refund, matching v_mrr_daily.
  it("rounds lifetime cents and counts CHARGEBACK as a refund", async () => {
    const RUN = Date.now();
    const projectId = `prj_life_${RUN}`;
    const subscriberId = `sub_life_${RUN}`;

    // $19.99 INITIAL: 19.99 * 100 = 1998.9999... in binary float; round() must
    // recover 1999, whereas the old toUInt64(... * 100) truncates to 1998.
    const purchaseRow = {
      eventId: `evt_life_init_${RUN}`,
      revenueEventId: `rev_init_${RUN}`,
      projectId, subscriberId,
      purchaseId: `pur_${RUN}`, productId: `prod_${RUN}`,
      type: "INITIAL", store: "APP_STORE",
      amount: "19.9900", amountUsd: "19.9900", currency: "USD",
      eventDate: "2026-05-02 00:00:00.000",
      ingestedAt: "2026-05-02 00:00:00.000",
      _version: 1,
    };
    // CHARGEBACK ($5.00) must be included in lifetime_dollars_refunded_cents.
    const chargebackRow = {
      eventId: `evt_life_cb_${RUN}`,
      revenueEventId: `rev_cb_${RUN}`,
      projectId, subscriberId,
      purchaseId: `pur_${RUN}`, productId: `prod_${RUN}`,
      type: "CHARGEBACK", store: "APP_STORE",
      amount: "5.0000", amountUsd: "5.0000", currency: "USD",
      eventDate: "2026-05-03 00:00:00.000",
      ingestedAt: "2026-05-03 00:00:00.000",
      _version: 1,
    };
    await ch.insert({ table: "raw_revenue_events", values: [purchaseRow], format: "JSONEachRow" });
    await ch.insert({ table: "raw_revenue_events", values: [chargebackRow], format: "JSONEachRow" });

    const res = await ch.query({
      query: `SELECT toString(lifetime_dollars_purchased_cents) AS purchased,
                     toString(lifetime_dollars_refunded_cents)  AS refunded
              FROM rovenue.v_revenue_lifetime_subscriber
              WHERE projectId = {pid:String} AND subscriberId = {sid:String}`,
      query_params: { pid: projectId, sid: subscriberId },
      format: "JSONEachRow",
    });
    const life = ((await res.json()) as Array<Record<string, string>>)[0] ?? {};

    // Rounded, not truncated: $19.99 -> 1999 cents (the bug produced 1998).
    expect(Number(life.purchased)).toBe(1999);
    // CHARGEBACK is treated as a refund -> $5.00 = 500 cents.
    expect(Number(life.refunded)).toBe(500);
  }, 120_000);
});
