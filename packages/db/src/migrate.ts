import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getPool } from "./drizzle/pool";
import {
  bookkeepingExists,
  ensureBookkeeping,
  hasMigrationHistory,
  isFreshInstallDatabase,
  runFreshInstall,
  findUnjournaledMigrations,
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
  // A migration file the journal does not list is invisible to BOTH runners:
  // the fresh one iterates the journal, and drizzle's migrator reads the same
  // file. The file sits in the directory looking applied-by-inspection while
  // the schema change never lands. Checked before either runner so the
  // warning is the first thing an operator sees, not something buried under
  // a hundred lines of migration output.
  const unjournaled = await findUnjournaledMigrations();
  if (unjournaled.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `WARNING: ${unjournaled.length} migration file(s) are not in ` +
        `meta/_journal.json and will NOT be applied by any runner:\n` +
        unjournaled.map((t) => `  ${t}`).join("\n") +
        `\nAdd them to the journal (pnpm db:migrate:generate, or by hand) ` +
        `before deploying.`,
    );
  }

  const fresh = await needsFreshInstall();

  if (fresh) {
    // eslint-disable-next-line no-console
    console.log(
      // Not "fresh install detected". This database may have a hundred
      // migrations already applied — the fresh RUNNER is chosen because the
      // database is stamped fresh-install mode, which is permanent by design:
      // it must keep marking the TimescaleDB-era migrations applied without
      // executing them, since the shipped image has no timescaledb.control.
      //
      // The old wording read as "about to reapply everything", which is how
      // two separate people concluded the detection had misfired; one reset a
      // dev Postgres volume over it. The runner prints a summary at the end.
      "fresh-install runner (database is stamped fresh-install mode) — " +
        "already-applied migrations are skipped by content hash",
    );
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
