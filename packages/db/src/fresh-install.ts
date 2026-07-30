import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";

/** Everything this runner needs from a `pg` connection. Accepting the
 *  capability rather than the class lets callers pass a pooled client
 *  (the migrate CLI) or a standalone `Client` (the vitest globalSetup,
 *  which holds one connection open to a database it just created). */
export type MigrationClient = Pick<PoolClient, "query">;

// =============================================================
// Fresh-install migration runner
// =============================================================
//
// The migration chain has a TimescaleDB → pg_partman cutover at
// migrations 0014 / 0018. Production databases came up on the
// `timescale/timescaledb:2.17.2-pg16` image, applied 0001–0017
// against the extension, then 0018 dropped it; the deploy unit then
// swapped the image to `postgres:16-bookworm + pg_partman`.
//
// Fresh installs run against the new image directly and do NOT have
// the TimescaleDB extension binaries available, so the timescale-era
// migrations cannot execute. This module walks the journal
// entry-by-entry, skipping the legacy entries when the extension is
// unavailable while still recording them in
// `drizzle.__drizzle_migrations` so a later `db:migrate` is a no-op.
//
// Why we do not use drizzle-orm's bulk migrator here:
// drizzle's algorithm reads the most-recent `created_at` from the
// bookkeeping table and skips every journal entry with an earlier
// timestamp. That makes "skip a few migrations in the middle" impossible
// via marker rows alone — inserting a marker for 0014 would also cause
// 0000–0013 to be skipped, leaving the schema empty.
//
// That difference is also why this runner MUST NOT be pointed at a
// database created by the upgrade path. It dedupes by content hash,
// and a migration file edited after it was applied no longer hashes to
// its recorded value — drizzle's watermark ignores that, this runner
// would re-apply it. `migrate.ts` owns the routing decision; see the
// install marker below.
//
// Detection is driven by `pg_available_extensions`, NOT by NODE_ENV
// or any flag:
//   * timescale image present  → runs the full chain like `db:migrate`
//   * timescale image absent   → skips legacy entries, applies the rest
//   * already-applied entries  → idempotent (hashes deduped)

// Migrations that require the TimescaleDB extension binaries. We pair
// each "create" with the matching "drop" so the schema lands in the
// same final state as the upgrade path:
//   0001          → CREATE EXTENSION timescaledb
//   0002–0004     → create_hypertable on revenue / credit / webhooks
//   0005          → CREATE MATERIALIZED VIEW … WITH (timescaledb.continuous)
//   0006–0007     → compression + retention policies (TSL-gated)
//   0009          → exposure_events hypertable
//   0010          → PeerDB publication that lists exposure_events as a
//                   member (would fail on a fresh DB without 0009)
//   0014          → remove_continuous_aggregate_policy + DROP MV daily_mrr
// 0011 (DROP PUBLICATION IF EXISTS) and 0012 (DROP TABLE IF EXISTS
// exposure_events) are safe to run on a fresh DB and are NOT skipped.
const TIMESCALE_LEGACY_TAGS: ReadonlySet<string> = new Set([
  "0001_timescaledb_extension",
  "0002_hypertable_revenue_events",
  "0003_hypertable_credit_ledger",
  "0004_hypertable_outgoing_webhooks",
  "0005_cagg_daily_mrr",
  "0006_compression_policies",
  "0007_retention_policies",
  "0009_exposure_events",
  "0010_postgres_publication",
  "0014_drop_daily_mrr_cagg",
  // 0019 registers pg_partman parents starting 2024-01-01, but 0015–0017
  // already pre-created 60 monthly partitions for the same range. partman
  // cannot reconcile the two and aborts with "would overlap partition".
  // The fresh-install partitioned tables already cover 2024–2028; the
  // partition-maintenance worker will refuse to act on tables not in
  // partman.part_config — that is the intended behaviour. Operators who
  // want partman-managed premake/retention on a dev install can run
  // `partman.create_parent(...)` manually after seeding.
  "0019_install_pg_partman",
]);

// 0015 / 0016 / 0017 RENAME the original (non-partitioned) table to a
// `_legacy_hypertable` companion, then create a new range-partitioned
// table at the original name. On the upgrade path the rename clears
// the original PK constraint name; on a fresh install the original
// table still owns `<table>_pkey`, so the CREATE collides.
//
// Pre-step: drop the original table outright before applying. The
// upgrade-path RENAME line is then redundant but harmless against
// the CASCADE-cleared slot (it errors with "does not exist", which
// we filter via IF EXISTS rewriting below).
const PARTITION_RENAME_TAGS: ReadonlyMap<string, string> = new Map([
  ["0015_partition_revenue_events", "revenue_events"],
  ["0016_partition_credit_ledger", "credit_ledger"],
  ["0017_partition_outgoing_webhooks", "outgoing_webhooks"],
]);

// 0015a / 0016a / 0017a drop a `<table>_legacy_hypertable` that only
// exists on the upgrade path. On a fresh install the rename above was
// replaced with a DROP, so these are no-ops and we mark them applied.
const LEGACY_HYPERTABLE_DROP_TAGS: ReadonlySet<string> = new Set([
  "0015a_drop_revenue_events_legacy",
  "0016a_drop_credit_ledger_legacy",
  "0017a_drop_outgoing_webhooks_legacy",
]);

const MIGRATIONS_DIR = new URL("../drizzle/migrations/", import.meta.url);

type JournalEntry = {
  idx: number;
  tag: string;
  when: number;
  breakpoints?: boolean;
};

async function loadJournal(): Promise<JournalEntry[]> {
  const journalUrl = new URL("meta/_journal.json", MIGRATIONS_DIR);
  const raw = await readFile(journalUrl, "utf8");
  const parsed = JSON.parse(raw) as { entries: JournalEntry[] };
  return [...parsed.entries].sort((a, b) => a.idx - b.idx);
}

async function readMigrationSql(tag: string): Promise<string> {
  const sqlUrl = new URL(`${tag}.sql`, MIGRATIONS_DIR);
  return readFile(sqlUrl, "utf8");
}

async function timescaleAvailable(client: MigrationClient): Promise<boolean> {
  const result = await client.query(
    `SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb' LIMIT 1`,
  );
  return (result.rowCount ?? 0) > 0;
}

// -------------------------------------------------------------
// Install marker
// -------------------------------------------------------------
//
// Records that a database was built by THIS runner rather than by the
// timescale→partman upgrade path. `migrate.ts` reads it to route every
// subsequent run, which is what makes an interrupted fresh install
// resumable: without the marker, a half-populated bookkeeping table is
// indistinguishable from a long-lived production database, and the
// resume would be handed to drizzle's watermark migrator — which would
// then try to `CREATE EXTENSION timescaledb` on an image that has none.
//
// The marker is written BEFORE any migration runs, so a crash at any
// point still leaves the database routable back to this runner.

export const INSTALL_MODE_FRESH = "fresh";

export async function ensureBookkeeping(client: MigrationClient): Promise<void> {
  await client.query(`CREATE SCHEMA IF NOT EXISTS "drizzle"`);
  await client.query(`
    CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);
  await client.query(`
    CREATE TABLE IF NOT EXISTS "drizzle"."__rovenue_install" (
      singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
      mode text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

/** True when this database was created by the fresh-install runner. */
export async function isFreshInstallDatabase(
  client: MigrationClient,
): Promise<boolean> {
  const result = await client.query<{ mode: string }>(
    `SELECT mode FROM "drizzle"."__rovenue_install" LIMIT 1`,
  );
  return result.rows[0]?.mode === INSTALL_MODE_FRESH;
}

/** True when any migration bookkeeping exists, i.e. the database has
 *  been migrated before by either path. */
export async function hasMigrationHistory(
  client: MigrationClient,
): Promise<boolean> {
  const result = await client.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM "drizzle"."__drizzle_migrations"`,
  );
  return Number(result.rows[0]?.count ?? "0") > 0;
}

/** Does the bookkeeping table exist at all? Separated from
 *  `hasMigrationHistory` so the caller can probe a virgin database
 *  without provoking an undefined-table error. */
export async function bookkeepingExists(client: MigrationClient): Promise<boolean> {
  const result = await client.query(
    `SELECT to_regclass('drizzle.__drizzle_migrations') IS NOT NULL AS present`,
  );
  return result.rows[0]?.present === true;
}

async function markFreshInstall(client: MigrationClient): Promise<void> {
  await client.query(
    `INSERT INTO "drizzle"."__rovenue_install" ("mode") VALUES ($1)
     ON CONFLICT (singleton) DO NOTHING`,
    [INSTALL_MODE_FRESH],
  );
}

async function alreadyApplied(
  client: MigrationClient,
  hash: string,
): Promise<boolean> {
  const result = await client.query<{ id: number }>(
    `SELECT id FROM "drizzle"."__drizzle_migrations" WHERE hash = $1 LIMIT 1`,
    [hash],
  );
  return (result.rowCount ?? 0) > 0;
}

async function recordApplied(
  client: MigrationClient,
  hash: string,
  when: number,
): Promise<void> {
  await client.query(
    `INSERT INTO "drizzle"."__drizzle_migrations" ("hash", "created_at") VALUES ($1, $2)`,
    [hash, when],
  );
}

async function applyMigration(
  client: MigrationClient,
  entry: JournalEntry,
  sql: string,
  hash: string,
): Promise<void> {
  // drizzle's own format splits each .sql at this marker. We keep the
  // same semantics so every statement runs in its own execute() call.
  const statements = sql
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  await client.query("BEGIN");
  try {
    for (const stmt of statements) {
      await client.query(stmt);
    }
    await recordApplied(client, hash, entry.when);
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

/**
 * Apply the whole journal to a database that the upgrade path never
 * touched. Idempotent: already-applied entries are skipped by hash, so
 * an interrupted run resumes cleanly.
 */
export async function runFreshInstall(client: MigrationClient): Promise<void> {
  await ensureBookkeeping(client);
  await markFreshInstall(client);

  const skipTimescale = !(await timescaleAvailable(client));
  if (skipTimescale) {
    // eslint-disable-next-line no-console
    console.log(
      "TimescaleDB unavailable — legacy migrations will be marked applied without running:",
    );
  }

  // Plan 3 gate: the legacy-hypertable drops are gated on this GUC.
  // On a fresh DB the renamed tables don't exist, so the DROP is a
  // safe no-op and we can opt-in unconditionally.
  await client.query(`SET rovenue.plan3_legacy_drop_verified = '1'`);

  const entries = await loadJournal();
  for (const entry of entries) {
    const sql = await readMigrationSql(entry.tag);
    // drizzle hashes the raw, un-split SQL with SHA-256 (see
    // node_modules/drizzle-orm/migrator.js#readMigrationFiles).
    const hash = createHash("sha256").update(sql).digest("hex");

    if (await alreadyApplied(client, hash)) {
      continue;
    }

    const isLegacy = skipTimescale && TIMESCALE_LEGACY_TAGS.has(entry.tag);
    const isLegacyDrop =
      skipTimescale && LEGACY_HYPERTABLE_DROP_TAGS.has(entry.tag);
    if (isLegacy || isLegacyDrop) {
      await recordApplied(client, hash, entry.when);
      // eslint-disable-next-line no-console
      console.log(`  ${entry.tag}: marked applied (legacy, not executed)`);
      continue;
    }

    const partitionTable = skipTimescale
      ? PARTITION_RENAME_TAGS.get(entry.tag)
      : undefined;
    if (partitionTable) {
      // Drop the original non-partitioned table BEFORE applying. The
      // rewritten SQL turns the upgrade-path RENAME into an idempotent
      // ALTER … IF EXISTS so it becomes a no-op.
      await client.query(`DROP TABLE IF EXISTS "${partitionTable}" CASCADE`);
      const rewritten = sql.replace(
        new RegExp(`ALTER TABLE "${partitionTable}" RENAME TO[^;]+;`, "g"),
        `ALTER TABLE IF EXISTS "${partitionTable}" RENAME TO "${partitionTable}_legacy_hypertable";`,
      );
      await applyMigration(client, entry, rewritten, hash);
      // eslint-disable-next-line no-console
      console.log(`  ${entry.tag}: applied (fresh-install partition path)`);
      continue;
    }

    await applyMigration(client, entry, sql, hash);
    // eslint-disable-next-line no-console
    console.log(`  ${entry.tag}: applied`);
  }
}
