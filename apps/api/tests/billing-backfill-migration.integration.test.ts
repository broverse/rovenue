import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GenericContainer } from "testcontainers";
import { Pool } from "pg";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const MIGRATIONS_DIR = join(
  __dirname,
  "../../../packages/db/drizzle/migrations",
);

// Migrations that require TimescaleDB, pg_partman, or other extensions
// not present in the plain postgres:16-alpine test image. These are
// purely infrastructure migrations (not schema migrations) and are safe
// to skip for a test that only exercises projects + billing_subscriptions.
const SKIP_MIGRATIONS = new Set([
  "0001_timescaledb_extension.sql", // CREATE EXTENSION timescaledb
  "0002_hypertable_revenue_events.sql", // create_hypertable
  "0003_hypertable_credit_ledger.sql", // create_hypertable
  "0004_hypertable_outgoing_webhooks.sql", // create_hypertable
  "0005_cagg_daily_mrr.sql", // timescaledb.continuous
  "0006_compression_policies.sql", // timescaledb compression
  "0007_retention_policies.sql", // timescaledb retention
  "0009_exposure_events.sql", // create_hypertable (also creates exposure_events table)
  "0010_postgres_publication.sql", // CREATE PUBLICATION references exposure_events (from 0009)
  "0011_drop_publication.sql", // DROP PUBLICATION (from 0010)
  "0012_drop_exposure_events.sql", // DROP TABLE exposure_events (from 0009)
  "0014_drop_daily_mrr_cagg.sql", // drop_materialized_view timescaledb
  "0015_partition_revenue_events.sql", // renames hypertable (not present)
  "0015a_drop_revenue_events_legacy.sql", // drops renamed hypertable
  "0016_partition_credit_ledger.sql", // renames hypertable
  "0016a_drop_credit_ledger_legacy.sql", // drops renamed hypertable
  "0017_partition_outgoing_webhooks.sql", // renames hypertable
  "0017a_drop_outgoing_webhooks_legacy.sql", // drops renamed hypertable
  "0018_drop_timescaledb_extension.sql", // DROP EXTENSION timescaledb
  "0019_install_pg_partman.sql", // CREATE EXTENSION pg_partman
]);

describe("backfill migration 0042", () => {
  let pool: Pool;
  let container: Awaited<ReturnType<typeof GenericContainer.prototype.start>>;

  beforeAll(async () => {
    container = await new GenericContainer("postgres:16-alpine")
      .withEnvironment({
        POSTGRES_PASSWORD: "test",
        POSTGRES_USER: "test",
        POSTGRES_DB: "test",
      })
      .withExposedPorts(5432)
      .start();

    pool = new Pool({
      host: container.getHost(),
      port: container.getMappedPort(5432),
      user: "test",
      password: "test",
      database: "test",
    });

    // Apply all migrations up to and including 0040 (pre-billing world),
    // skipping extension-dependent migrations that require TimescaleDB or
    // pg_partman (not available on the plain postgres:16-alpine test image).
    const allFiles = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();
    const preBillingFiles = allFiles.filter((f) => {
      const num = parseInt(f.slice(0, 4), 10);
      return num <= 40 && !SKIP_MIGRATIONS.has(f);
    });
    for (const f of preBillingFiles) {
      const sql = readFileSync(join(MIGRATIONS_DIR, f), "utf-8");
      await pool.query(sql);
    }

    // Seed 3 legacy projects (pre-billing world).
    // Migration 0030 dropped `slug`; projects never had an `ownerId` column
    // (ownership is tracked via project_members). Only insert known columns.
    await pool.query(`
      INSERT INTO projects (id, name, "createdAt", "updatedAt")
      VALUES
        ('proj_a', 'A', NOW(), NOW()),
        ('proj_b', 'B', NOW(), NOW()),
        ('proj_c', 'C', NOW(), NOW());
    `);

    // Apply 0041 (creates billing tables) then 0042 (backfill)
    const m41 = readFileSync(
      join(MIGRATIONS_DIR, "0041_empty_scarlet_spider.sql"),
      "utf-8",
    );
    await pool.query(m41);
    const m42 = readFileSync(
      join(MIGRATIONS_DIR, "0042_billing_backfill.sql"),
      "utf-8",
    );
    await pool.query(m42);
  }, 90_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  it("creates one billing_subscriptions row per pre-existing project", async () => {
    const { rows } = await pool.query<{
      project_id: string;
      state: string;
      tier: string;
    }>(`
      SELECT project_id, state, tier
      FROM billing_subscriptions
      ORDER BY project_id;
    `);
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.project_id)).toEqual([
      "proj_a",
      "proj_b",
      "proj_c",
    ]);
    rows.forEach((r) => {
      expect(r.state).toBe("free");
      expect(r.tier).toBe("free");
    });
  });

  it("is idempotent — re-running 0042 produces no duplicates", async () => {
    const m42 = readFileSync(
      join(MIGRATIONS_DIR, "0042_billing_backfill.sql"),
      "utf-8",
    );
    await pool.query(m42);
    const { rows } = await pool.query(
      "SELECT COUNT(*)::int AS n FROM billing_subscriptions",
    );
    expect(rows[0].n).toBe(3);
  });
});
