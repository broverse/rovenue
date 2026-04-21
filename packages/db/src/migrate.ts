import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getPool } from "./drizzle/pool";

// =============================================================
// drizzle-kit migration runner
// =============================================================
//
// Applies every SQL file in ./drizzle/migrations/ to the
// configured DATABASE_URL. Replaces `prisma migrate deploy` in
// the deployment pipeline. drizzle-orm keeps its own __drizzle_
// migrations tracking table alongside Prisma's _prisma_migrations
// — both coexist; they track disjoint migration sets.
//
// Usage:
//   pnpm --filter @rovenue/db db:migrate
//
// The CLI entrypoint below invokes the migrator when this module
// is executed directly (tsx packages/db/src/migrate.ts) and
// bails with a non-zero exit code on failure so CI/CD can gate.

async function run(): Promise<void> {
  const pool = getPool();
  const db = drizzle(pool);
  await migrate(db, {
    migrationsFolder: new URL("../drizzle/migrations", import.meta.url)
      .pathname,
  });
  await pool.end();
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("drizzle migrate failed:", err);
  process.exit(1);
});
