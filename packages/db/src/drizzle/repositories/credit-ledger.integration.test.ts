process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../client";
import { projects, subscribers } from "../schema";
import * as vcRepo from "./virtual-currencies";
import * as creditLedgerRepo from "./credit-ledger";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_cl_${RUN_ID}`;
const SUB_ID = `sub_cl_${RUN_ID}`;

describe("credit-ledger per-currency", () => {
  afterAll(async () => {
    // credit_ledger is append-only; insertCreditLedger above created ledger rows
    // so cascade delete needs the bypass flag.
    await creditLedgerRepo.withLedgerDeleteAuthorized(getDb(), async (tx) => {
      await tx.delete(projects).where(eq(projects.id, PROJECT_ID));
    });
  });

  it("tracks balance independently per currency", async () => {
    const db = getDb();
    await db.insert(projects).values({ id: PROJECT_ID, name: `CL ${RUN_ID}` });
    await db.insert(subscribers).values({
      id: SUB_ID,
      projectId: PROJECT_ID,
      rovenueId: `rov_${RUN_ID}`,
    });
    const gold = await vcRepo.createVirtualCurrency(db, {
      projectId: PROJECT_ID,
      code: "GLD",
      name: "Coins",
    });
    const gem = await vcRepo.createVirtualCurrency(db, {
      projectId: PROJECT_ID,
      code: "GEM",
      name: "Gems",
    });

    await creditLedgerRepo.insertCreditLedger(db, {
      projectId: PROJECT_ID,
      subscriberId: SUB_ID,
      currencyId: gold.id,
      type: "BONUS",
      amount: 100,
      balance: 100,
    });
    await creditLedgerRepo.insertCreditLedger(db, {
      projectId: PROJECT_ID,
      subscriberId: SUB_ID,
      currencyId: gem.id,
      type: "BONUS",
      amount: 5,
      balance: 5,
    });

    const goldBal = await creditLedgerRepo.findLatestBalance(db, SUB_ID, gold.id);
    expect(goldBal?.balance).toBe(100);
    const gemBal = await creditLedgerRepo.findLatestBalance(db, SUB_ID, gem.id);
    expect(gemBal?.balance).toBe(5);

    const all = await creditLedgerRepo.findAllBalances(db, SUB_ID);
    expect(all).toHaveLength(2);
    const map = Object.fromEntries(all.map((b) => [b.currencyId, b.balance]));
    expect(map[gold.id]).toBe(100);
    expect(map[gem.id]).toBe(5);
  });
});
