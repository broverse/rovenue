// =============================================================
// addCredits dedupeOnReference — concurrent double-grant race
//
// Two concurrent addCredits calls for the same purchase reference
// must produce exactly ONE ledger row. credit_ledger is a declarative
// RANGE PARTITION on createdAt, so a unique index on
// (subscriberId, referenceType, referenceId) is impossible — the
// dedup must happen INSIDE the per-subscriber advisory lock, where
// check-then-insert is serialised and therefore atomic.
// =============================================================

import { afterAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { getDb, projects, subscribers, drizzle } from "@rovenue/db";
import { addCredits, getBalance } from "../src/services/credit-engine";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_creditdedup_${RUN_ID}`;
const SUB_ID = `sub_creditdedup_${RUN_ID}`;
const PURCHASE_ID = `pur_creditdedup_${RUN_ID}`;

describe("addCredits dedupeOnReference", () => {
  afterAll(async () => {
    await getDb().delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  it("inserts exactly one ledger row under concurrent same-reference grants", async () => {
    const db = getDb();
    await db.insert(projects).values({ id: PROJECT_ID, name: `Credit Dedup ${RUN_ID}` });
    await db.insert(subscribers).values({
      id: SUB_ID,
      projectId: PROJECT_ID,
      rovenueId: `rov_${RUN_ID}`,
      appUserId: `app_${RUN_ID}`,
    });

    const currency = await drizzle.virtualCurrencyRepo.createVirtualCurrency(db, {
      projectId: PROJECT_ID,
      code: "GLD",
      name: "Coins",
    });

    const grant = () =>
      addCredits({
        subscriberId: SUB_ID,
        currencyId: currency.id,
        amount: 100,
        referenceType: "purchase",
        referenceId: PURCHASE_ID,
        description: "Credits for test",
        dedupeOnReference: true,
      });

    await Promise.all([grant(), grant()]);

    const rows = await db
      .select({ id: drizzle.schema.creditLedger.id })
      .from(drizzle.schema.creditLedger)
      .where(
        and(
          eq(drizzle.schema.creditLedger.subscriberId, SUB_ID),
          eq(drizzle.schema.creditLedger.referenceType, "purchase"),
          eq(drizzle.schema.creditLedger.referenceId, PURCHASE_ID),
        ),
      );

    expect(rows).toHaveLength(1);
    expect(await getBalance(SUB_ID, currency.id)).toBe(100);
  });
});
