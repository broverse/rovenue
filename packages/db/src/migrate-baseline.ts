import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { getPool } from "./drizzle/pool";

// =============================================================
// drizzle-kit baseline helper
// =============================================================
//
// One-shot upgrade script for operators who provisioned their
// database with Prisma's `prisma migrate deploy` before Phase
// 7e3 landed. drizzle-orm's migrator tracks applied migrations
// by hash in the __drizzle_migrations table. Since their DB
// already has every table / index / enum the 0000 baseline
// would create, running the migrator directly would fail with
// "relation already exists".
//
// This script:
//   1. Creates the __drizzle_migrations tracking table if absent.
//   2. Hashes drizzle/migrations/0000_<slug>.sql and records it
//      as "applied" without running its DDL.
//
// After this runs, `pnpm db:migrate` applies 0001+ normally.
// Fresh (Prisma-free) installs skip this script entirely and
// run `pnpm db:migrate` from a clean database.

async function run(): Promise<void> {
  const journalUrl = new URL(
    "../drizzle/migrations/meta/_journal.json",
    import.meta.url,
  );
  const journal = JSON.parse(
    await readFile(journalUrl, "utf8"),
  ) as { entries: Array<{ idx: number; tag: string; when: number }> };
  const baseline = journal.entries.find((e) => e.idx === 0);
  if (!baseline) {
    throw new Error("No 0000 baseline entry in _journal.json");
  }

  const sqlUrl = new URL(
    `../drizzle/migrations/${baseline.tag}.sql`,
    import.meta.url,
  );
  const sql = await readFile(sqlUrl, "utf8");
  // drizzle-orm hashes each migration's resolved SQL with SHA-256.
  const hash = createHash("sha256").update(sql).digest("hex");

  const pool = getPool();
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS "__drizzle_migrations" (
        id SERIAL PRIMARY KEY,
        hash text NOT NULL,
        created_at bigint
      );
    `);
    const existing = await pool.query(
      `SELECT id FROM "__drizzle_migrations" WHERE hash = $1`,
      [hash],
    );
    if (existing.rowCount && existing.rowCount > 0) {
      // eslint-disable-next-line no-console
      console.log(
        "Baseline migration already marked applied — nothing to do.",
      );
      return;
    }
    await pool.query(
      `INSERT INTO "__drizzle_migrations" (hash, created_at) VALUES ($1, $2)`,
      [hash, baseline.when],
    );
    // eslint-disable-next-line no-console
    console.log(
      `Marked 0000 baseline (${baseline.tag}) as applied. Future migrations will run as normal.`,
    );
  } finally {
    await pool.end();
  }
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("drizzle baseline failed:", err);
  process.exit(1);
});
