import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getPool } from "./drizzle/pool";

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

async function run(): Promise<void> {
  const pool = getPool();
  const legacyDropVerified =
    process.env.PLAN3_LEGACY_DROP_VERIFIED === "1";

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

  await pool.end();
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("drizzle migrate failed:", err);
  process.exit(1);
});
