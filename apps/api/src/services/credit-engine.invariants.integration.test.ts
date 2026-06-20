import { afterAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { getDb, creditLedger, projects, subscribers, virtualCurrencies } from "@rovenue/db";

const RUN_ID = Date.now();
const P = `prj_ledinv_${RUN_ID}`;
const S = `sub_ledinv_${RUN_ID}`;
const C = `vc_ledinv_${RUN_ID}`;

async function seed() {
  const db = getDb();
  await db.insert(projects).values({ id: P, name: "ledinv" });
  await db.insert(subscribers).values({ id: S, projectId: P, rovenueId: `rv_${RUN_ID}` });
  await db.insert(virtualCurrencies).values({ id: C, projectId: P, code: "GOLD", name: "Gold" });
}

/** Walk the error cause chain and join all messages. Drizzle wraps PG errors
 *  in DrizzleQueryError; the constraint/trigger text lives on `.cause`. */
function flatMessages(err: unknown): string {
  const parts: string[] = [];
  let cursor: unknown = err;
  while (cursor && typeof cursor === "object") {
    const m = (cursor as { message?: unknown }).message;
    if (typeof m === "string") parts.push(m);
    cursor = (cursor as { cause?: unknown }).cause;
  }
  return parts.join(" | ");
}

describe("credit_ledger invariants", () => {
  afterAll(async () => {
    const db = getDb();
    // credit_ledger is now append-only at the DB level (trigger rejects DELETE).
    // Disable the trigger for test cleanup only, then re-enable.
    await db.execute(
      sql`ALTER TABLE "credit_ledger" DISABLE TRIGGER "credit_ledger_append_only"`,
    );
    await db.delete(creditLedger).where(sql`"projectId" = ${P}`);
    await db.execute(
      sql`ALTER TABLE "credit_ledger" ENABLE TRIGGER "credit_ledger_append_only"`,
    );
    await db.delete(virtualCurrencies).where(sql`id = ${C}`);
    await db.delete(subscribers).where(sql`id = ${S}`);
    await db.delete(projects).where(sql`id = ${P}`);
  });

  it("rejects a negative balance via CHECK", async () => {
    await seed();
    const db = getDb();
    let captured: unknown;
    try {
      await db.insert(creditLedger).values({
        projectId: P, subscriberId: S, currencyId: C,
        type: "SPEND", amount: -5, balance: -5,
      });
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeDefined();
    expect(flatMessages(captured)).toMatch(/credit_ledger_balance_non_negative|violates check/i);
  });

  it("rejects UPDATE on an existing ledger row (append-only trigger)", async () => {
    const db = getDb();
    const [row] = await db.insert(creditLedger).values({
      projectId: P, subscriberId: S, currencyId: C,
      type: "PURCHASE", amount: 10, balance: 10,
    }).returning();
    let captured: unknown;
    try {
      await db.update(creditLedger).set({ balance: 999 }).where(sql`id = ${row.id}`);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeDefined();
    expect(flatMessages(captured)).toMatch(/append-only|credit_ledger is append-only/i);
  });

  it("rejects un-flagged DELETE on a ledger row (append-only trigger)", async () => {
    const db = getDb();
    // Insert a valid row (positive balance) to attempt deleting.
    const [row] = await db.insert(creditLedger).values({
      projectId: P, subscriberId: S, currencyId: C,
      type: "PURCHASE", amount: 20, balance: 20,
    }).returning();
    let captured: unknown;
    try {
      // Plain DELETE with no bypass flag — the trigger must reject it.
      await db.delete(creditLedger).where(sql`id = ${row.id}`);
    } catch (err) {
      captured = err;
    }
    expect(captured).toBeDefined();
    expect(flatMessages(captured)).toMatch(/append-only/i);
    // afterAll cleans up this row via the authorized trigger-disable path.
  });
});
