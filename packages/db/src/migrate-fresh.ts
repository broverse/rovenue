import { getPool } from "./drizzle/pool";
import { runFreshInstall } from "./fresh-install";

// =============================================================
// Fresh-install runner — explicit entrypoint
// =============================================================
//
// `db:migrate` now auto-detects a fresh database and routes here on
// its own, so this command is rarely the one you want. It stays as an
// escape hatch for the case where the detection is wrong — e.g. an
// operator restoring a schema-only dump that has bookkeeping rows but
// no marker, and who has confirmed the migration files were not edited
// since they were applied.
//
// Do NOT run this against a database built by the timescale→partman
// upgrade path. It dedupes by content hash where drizzle dedupes by a
// `created_at` watermark, so any migration file edited after it was
// applied gets re-applied. See the routing note in migrate.ts.
//
// Usage:
//   pnpm --filter @rovenue/db db:migrate:fresh

async function run(): Promise<void> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    await runFreshInstall(client);
  } finally {
    client.release();
    await pool.end();
  }
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("drizzle migrate:fresh failed:", err);
  process.exit(1);
});
