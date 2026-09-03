process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, describe, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
import { getCreditLiabilityDaily } from "./credits";

// =============================================================
// `liability`'s daily series, against a real ledger
// =============================================================
//
// Two things need real Postgres to be worth anything:
//
//  1. The back-walk reproduces the balances the ledger actually held on
//     each past day.
//  2. Its LAST point equals the gauge `/credits` renders — which is the
//     ledger's own append-only invariant (`balance` is the running sum
//     of `amount`) under test, not an assumption written in a comment.

const RUN_ID = Date.now();
const PROJECT_ID = `prj_liab_${RUN_ID}`;
const SUB_ID = `sub_liab_${RUN_ID}`;
const DAY_MS = 24 * 60 * 60 * 1000;
const GRANT = 100;
const SPEND = -30;
const LATE_GRANT = 25;

/** The gauge's own query — `readOutstandingBalance` is module-private,
 *  so this restates its shape rather than importing it. */
function outstandingSql(projectId: string) {
  return sql`
    SELECT COALESCE(SUM(balance), 0)::text AS outstanding
    FROM (
      SELECT DISTINCT ON ("subscriberId", "currencyId") balance
      FROM ${drizzle.schema.creditLedger}
      WHERE "projectId" = ${projectId}
      ORDER BY "subscriberId", "currencyId", "createdAt" DESC
    ) latest
  `;
}

function windowEndingToday(daysBack: number) {
  const to = new Date();
  to.setUTCHours(23, 59, 59, 999);
  const from = new Date(to.getTime() - daysBack * DAY_MS);
  from.setUTCHours(0, 0, 0, 0);
  return { from, to, days: daysBack + 1 };
}

describe("getCreditLiabilityDaily", () => {
  afterAll(async () => {
    // credit_ledger is append-only at the DB level; the cascade delete
    // needs the authorized transaction to SET LOCAL the bypass flag.
    await drizzle.creditLedgerRepo.withLedgerDeleteAuthorized(
      drizzle.db,
      async (tx) => {
        await tx
          .delete(drizzle.schema.projects)
          .where(eq(drizzle.schema.projects.id, PROJECT_ID));
      },
    );
  });

  it("walks today's balance backwards through the deltas", async () => {
    await drizzle.db
      .insert(drizzle.schema.projects)
      .values({ id: PROJECT_ID, name: `LIAB ${RUN_ID}` });
    await drizzle.db.insert(drizzle.schema.subscribers).values({
      id: SUB_ID,
      projectId: PROJECT_ID,
      rovenueId: `rv_${RUN_ID}`,
    });
    const [currency] = await drizzle.db
      .insert(drizzle.schema.virtualCurrencies)
      .values({ projectId: PROJECT_ID, code: "GLD", name: "Gold" })
      .returning();
    const currencyId = currency!.id;

    // Three dated rows: +100 (D-2), −30 (D-1), +25 (today). Written
    // directly rather than through the engine so the DATES are
    // controlled; `balance` carries the running total the schema
    // documents, which is exactly what the anchor query reads.
    const now = Date.now();
    await drizzle.db.insert(drizzle.schema.creditLedger).values([
      {
        projectId: PROJECT_ID,
        subscriberId: SUB_ID,
        currencyId,
        type: "PURCHASE",
        amount: GRANT,
        balance: GRANT,
        createdAt: new Date(now - 2 * DAY_MS),
      },
      {
        projectId: PROJECT_ID,
        subscriberId: SUB_ID,
        currencyId,
        type: "SPEND",
        amount: SPEND,
        balance: GRANT + SPEND,
        createdAt: new Date(now - 1 * DAY_MS),
      },
      {
        projectId: PROJECT_ID,
        subscriberId: SUB_ID,
        currencyId,
        type: "BONUS",
        amount: LATE_GRANT,
        balance: GRANT + SPEND + LATE_GRANT,
        createdAt: new Date(now),
      },
    ]);

    const rows = await getCreditLiabilityDaily(PROJECT_ID, windowEndingToday(2));

    expect(rows.map((r) => r.n)).toEqual([
      GRANT,
      GRANT + SPEND,
      GRANT + SPEND + LATE_GRANT,
    ]);
  });

  it("ends on exactly the figure the /credits gauge reports", async () => {
    const rows = await getCreditLiabilityDaily(PROJECT_ID, windowEndingToday(2));
    const gauge = await drizzle.db.execute<{ outstanding: string }>(
      outstandingSql(PROJECT_ID),
    );
    expect(rows.at(-1)?.n).toBe(Number(gauge.rows[0]?.outstanding ?? "0"));
  });

  it("carries the balance forward across days with no ledger activity", async () => {
    // A window reaching further back than the first row: the days
    // before any activity read 0, and every quiet day after it repeats
    // the last real balance rather than dropping to 0.
    const rows = await getCreditLiabilityDaily(PROJECT_ID, windowEndingToday(4));
    expect(rows.map((r) => r.n)).toEqual([
      0,
      0,
      GRANT,
      GRANT + SPEND,
      GRANT + SPEND + LATE_GRANT,
    ]);
  });
});
