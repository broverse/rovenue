// =============================================================
// import_jobs.kind — integration tests (real Postgres)
// =============================================================
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance
// (the docker-compose dev stack on host port 5433 satisfies this).
// Mirrors the setup idiom in packages/db/tests/import-jobs.test.ts.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import * as schema from "../src/drizzle/schema";

// ---------------------------------------------------------------------------
// Env bootstrap (mirrors apps/api/tests/setup.ts approach)
// ---------------------------------------------------------------------------
process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

// ---------------------------------------------------------------------------
// DB connection owned by this test file
// ---------------------------------------------------------------------------

let pool: Pool;
let db: ReturnType<typeof drizzleClient<typeof schema>>;

beforeAll(() => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  db = drizzleClient(pool, { schema });
});

afterAll(async () => {
  await pool.end();
});

describe("import_jobs.kind", () => {
  it("has both kinds on the enum", async () => {
    const rows = await db.execute(sql`
      SELECT e.enumlabel FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'ImportJobKind'
      ORDER BY e.enumsortorder
    `);
    expect(rows.rows.map((r: any) => r.enumlabel)).toEqual([
      "HISTORY",
      "GOOGLE_TOKEN_ENRICHMENT",
    ]);
  });

  it("defaults existing rows to HISTORY and is NOT NULL", async () => {
    const rows = await db.execute(sql`
      SELECT is_nullable, column_default
      FROM information_schema.columns
      WHERE table_name = 'import_jobs' AND column_name = 'kind'
    `);
    expect(rows.rows[0]).toMatchObject({ is_nullable: "NO" });
    expect(String((rows.rows[0] as any).column_default)).toContain("HISTORY");
  });

  // Task 3 declares a TypeScript string union `ImportJobKind = "HISTORY" |
  // "GOOGLE_TOKEN_ENRICHMENT"` in packages/shared/src/import/canonical.ts.
  // packages/shared must not depend on @rovenue/db, so that union is a
  // deliberate duplication of this Postgres enum rather than a derivation
  // from it — nothing else would catch the two drifting apart when a third
  // kind is added to one and not the other. packages/shared doesn't exist
  // yet as of this task, so this asserts against a literal list; once
  // canonical.ts exists, keep this list in step with it by hand.
  const EXPECTED_IMPORT_JOB_KINDS = ["HISTORY", "GOOGLE_TOKEN_ENRICHMENT"] as const;

  it("enum labels equal the canonical ImportJobKind union, in order", async () => {
    const rows = await db.execute(sql`
      SELECT e.enumlabel FROM pg_enum e
      JOIN pg_type t ON t.oid = e.enumtypid
      WHERE t.typname = 'ImportJobKind'
      ORDER BY e.enumsortorder
    `);
    expect(rows.rows.map((r: any) => r.enumlabel)).toEqual([
      ...EXPECTED_IMPORT_JOB_KINDS,
    ]);
  });
});
