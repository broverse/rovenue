// =============================================================
// subscribers identity schema — integration tests
// =============================================================
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance
// (the docker-compose dev stack on host port 5433 satisfies this).
// Pattern mirrors the sibling webhook-events integration suite.

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getDb } from "../client";

describe("subscribers identity schema", () => {
  it("has rovenueId, identifiedAt columns and a nullable appUserId", async () => {
    const db = getDb();
    // db.execute() with a raw sql template returns the pg QueryResult object;
    // the row data lives in result.rows (mirrors the sibling integration suites).
    const result = await db.execute(sql`
      SELECT column_name, is_nullable
      FROM information_schema.columns
      WHERE table_name = 'subscribers'
        AND column_name IN ('rovenueId', 'appUserId', 'identifiedAt')
      ORDER BY column_name
    `);
    const rows = (result as unknown as { rows: Array<{ column_name: string; is_nullable: string }> }).rows;
    const byName = Object.fromEntries(
      rows.map((r) => [r.column_name, r.is_nullable]),
    );
    expect(byName.rovenueId).toBe("NO");
    expect(byName.appUserId).toBe("YES");
    expect(byName.identifiedAt).toBe("YES");
  });

  it("backfilled rovenueId from appUserId for pre-existing rows", async () => {
    const db = getDb();
    const result = await db.execute(sql`
      SELECT count(*)::int AS n FROM subscribers WHERE "rovenueId" IS NULL
    `);
    const rows = (result as unknown as { rows: Array<{ n: number }> }).rows;
    expect(rows[0].n).toBe(0);
  });
});
