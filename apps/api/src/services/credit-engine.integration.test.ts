process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
import {
  addCredits,
  spendCredits,
  getBalance,
  getAllBalances,
  InsufficientCreditsError,
} from "./credit-engine";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_ce_${RUN_ID}`;
const SUB_ID = `sub_ce_${RUN_ID}`;

describe("credit-engine multi-currency", () => {
  let goldId: string;
  let gemId: string;

  afterAll(async () => {
    await drizzle.db
      .delete(drizzle.schema.projects)
      .where(eq(drizzle.schema.projects.id, PROJECT_ID));
  });

  it("sets up project, subscriber, currencies", async () => {
    await drizzle.db
      .insert(drizzle.schema.projects)
      .values({ id: PROJECT_ID, name: `CE ${RUN_ID}` });
    await drizzle.db.insert(drizzle.schema.subscribers).values({
      id: SUB_ID,
      projectId: PROJECT_ID,
      rovenueId: `rov_${RUN_ID}`,
    });
    goldId = (
      await drizzle.virtualCurrencyRepo.createVirtualCurrency(drizzle.db, {
        projectId: PROJECT_ID,
        code: "GLD",
        name: "Coins",
      })
    ).id;
    gemId = (
      await drizzle.virtualCurrencyRepo.createVirtualCurrency(drizzle.db, {
        projectId: PROJECT_ID,
        code: "GEM",
        name: "Gems",
      })
    ).id;
    expect(goldId).toBeTruthy();
  });

  it("grants and spends within one currency, isolated from another", async () => {
    await addCredits({ subscriberId: SUB_ID, currencyId: goldId, amount: 100 });
    await addCredits({ subscriberId: SUB_ID, currencyId: gemId, amount: 5 });
    await spendCredits({ subscriberId: SUB_ID, currencyId: goldId, amount: 40 });

    expect(await getBalance(SUB_ID, goldId)).toBe(60);
    expect(await getBalance(SUB_ID, gemId)).toBe(5);

    const all = await getAllBalances(SUB_ID);
    const map = Object.fromEntries(all.map((b) => [b.currencyId, b.balance]));
    expect(map[goldId]).toBe(60);
    expect(map[gemId]).toBe(5);
  });

  it("throws InsufficientCreditsError when spending over balance", async () => {
    await expect(
      spendCredits({ subscriberId: SUB_ID, currencyId: gemId, amount: 999 }),
    ).rejects.toBeInstanceOf(InsufficientCreditsError);
  });

  it("serializes concurrent spends on the same currency (no overdraft)", async () => {
    await addCredits({ subscriberId: SUB_ID, currencyId: goldId, amount: 40 }); // -> 100
    const results = await Promise.allSettled([
      spendCredits({ subscriberId: SUB_ID, currencyId: goldId, amount: 70 }),
      spendCredits({ subscriberId: SUB_ID, currencyId: goldId, amount: 70 }),
    ]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r) => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(await getBalance(SUB_ID, goldId)).toBe(30);
  });
});
