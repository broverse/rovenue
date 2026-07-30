import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getPool } from "./drizzle/pool";
import {
  bookkeepingExists,
  ensureBookkeeping,
  hasMigrationHistory,
  isFreshInstallDatabase,
  runFreshInstall,
} from "./fresh-install";

// =============================================================
// drizzle-kit migration runner
// =============================================================
//
// Applies every SQL file in ./drizzle/migrations/ to the
// configured DATABASE_URL. drizzle-orm tracks applied migrations
// in the __drizzle_migrations metadata table it creates on first
// run.
//
// Usage:
//   pnpm --filter @rovenue/db db:migrate
//
// Two histories, one command
// --------------------------
// The journal contains a TimescaleDB era (0001–0017) that can only be
// replayed on the `timescale/timescaledb:2.17.2-pg16` image. The image
// this repo ships (deploy/postgres — vanilla PG 16 + pg_partman) has no
// `timescaledb.control`, so a brand-new database cannot run the chain
// as written; before this dispatcher existed, a fresh self-host install
// or a clean CI environment failed on 0001 with
// "extension control file not found".
//
// So this entrypoint routes:
//
//   * database with no migration history      → fresh-install runner
//   * database marked as a fresh install      → fresh-install runner
//   * database with history and no marker     → drizzle's migrator
//
// The third case is every deployment that predates this change, and it
// runs exactly the code it ran before. That separation is load-bearing
// rather than merely tidy: the fresh runner dedupes by content hash,
// while drizzle's migrator dedupes by a `created_at` watermark and
// ignores hashes entirely. Four migration files in this repo were
// edited after they were applied (0070, 0081, 0093, 0099), so their
// recorded hashes no longer match the files on disk. drizzle's
// watermark skips them; a hash-based runner would re-apply them. Never
// point the fresh runner at an upgrade-path database.
//
// Plan 3 — legacy hypertable drop gate
// -----------------------------------
// Migrations 0015a / 0016a / 0017a are gated on the GUC
// `rovenue.plan3_legacy_drop_verified='1'`. We set it on a single
// dedicated client (not the pool) so the SET propagates to the
// migrator's queries — the migrator opens its own connection from
// a Drizzle wrapper, and `SET` is session-local. The env var
// PLAN3_LEGACY_DROP_VERIFIED=1 is the operator's opt-in switch:
// it MUST NOT be set automatically by the deploy pipeline. The
// gate exists so the data copy (migrate-hypertable-to-partitioned.ts)
// can be verified for byte-for-byte row-count parity before the
// legacy table is irrecoverably dropped.
//
// The gate does not apply on the fresh-install path: there is no
// legacy table to lose, so the runner sets the GUC itself.

/** Which runner a database needs. See the routing table above. */
async function needsFreshInstall(): Promise<boolean> {
  const pool = getPool();
  const client = await pool.connect();
  try {
    if (!(await bookkeepingExists(client))) {
      return true;
    }
    await ensureBookkeeping(client);
    if (await isFreshInstallDatabase(client)) {
      return true;
    }
    return !(await hasMigrationHistory(client));
  } finally {
    client.release();
  }
}

async function runDrizzleMigrator(): Promise<void> {
  const pool = getPool();
  const legacyDropVerified = process.env.PLAN3_LEGACY_DROP_VERIFIED === "1";

  if (legacyDropVerified) {
    const client = await pool.connect();
    try {
      await client.query(`SET rovenue.plan3_legacy_drop_verified = '1'`);
      const db = drizzle(client);
      await migrate(db, {
        migrationsFolder: new URL("../drizzle/migrations", import.meta.url)
          .pathname,
      });
    } finally {
      client.release();
    }
  } else {
    const db = drizzle(pool);
    await migrate(db, {
      migrationsFolder: new URL("../drizzle/migrations", import.meta.url)
        .pathname,
    });
  }
}

async function run(): Promise<void> {
  const fresh = await needsFreshInstall();

  if (fresh) {
    // eslint-disable-next-line no-console
    console.log("fresh install detected — applying the full journal");
    const pool = getPool();
    const client = await pool.connect();
    try {
      await runFreshInstall(client);
    } finally {
      client.release();
    }
  } else {
    await runDrizzleMigrator();
  }

  await getPool().end();
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("drizzle migrate failed:", err);
  process.exit(1);
});
