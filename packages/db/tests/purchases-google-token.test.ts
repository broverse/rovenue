// =============================================================
// purchases.googlePurchaseToken — schema/migration integration test
// (real Postgres)
// =============================================================
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance
// (the docker-compose dev stack on host port 5433 satisfies this).

import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import { drizzle } from "../src";

// ---------------------------------------------------------------------------
// Env bootstrap (mirrors packages/db/tests/import-jobs.test.ts)
// ---------------------------------------------------------------------------
process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

describe("purchases.googlePurchaseToken", () => {
  it("exists, is nullable, and is text", async () => {
    const rows = await drizzle.db.execute(sql`
      SELECT data_type, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'purchases'
        AND column_name = 'googlePurchaseToken'
    `);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ data_type: "text", is_nullable: "YES" });
  });

  it("has a partial index for enrichment lookup", async () => {
    const rows = await drizzle.db.execute(sql`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'purchases'
        AND indexname = 'purchases_google_token_enrichment_idx'
    `);
    expect(rows.rows).toHaveLength(1);
  });
});
