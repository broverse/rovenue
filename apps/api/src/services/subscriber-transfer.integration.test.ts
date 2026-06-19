process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
import { addCredits, getAllBalances } from "./credit-engine";
import { transferSubscriber } from "./subscriber-transfer";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_st_${RUN_ID}`;
const FROM_ID = `sub_st_from_${RUN_ID}`;
const TO_ID = `sub_st_to_${RUN_ID}`;

describe("subscriber-transfer multi-currency", () => {
  let goldId: string;
  let gemId: string;

  afterAll(async () => {
    await drizzle.db
      .delete(drizzle.schema.projects)
      .where(eq(drizzle.schema.projects.id, PROJECT_ID));
  });

  it("sets up project, two subscribers, and two currencies", async () => {
    await drizzle.db
      .insert(drizzle.schema.projects)
      .values({ id: PROJECT_ID, name: `ST ${RUN_ID}` });

    await drizzle.db.insert(drizzle.schema.subscribers).values([
      {
        id: FROM_ID,
        projectId: PROJECT_ID,
        rovenueId: `rov_st_from_${RUN_ID}`,
        appUserId: `user_from_${RUN_ID}`,
      },
      {
        id: TO_ID,
        projectId: PROJECT_ID,
        rovenueId: `rov_st_to_${RUN_ID}`,
        appUserId: `user_to_${RUN_ID}`,
      },
    ]);

    goldId = (
      await drizzle.virtualCurrencyRepo.createVirtualCurrency(drizzle.db, {
        projectId: PROJECT_ID,
        code: "GLD",
        name: "Gold",
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
    expect(gemId).toBeTruthy();
  });

  it("grants two currencies to the FROM subscriber", async () => {
    await addCredits({ subscriberId: FROM_ID, currencyId: goldId, amount: 200 });
    await addCredits({ subscriberId: FROM_ID, currencyId: gemId, amount: 50 });

    const balances = await getAllBalances(FROM_ID);
    const map = Object.fromEntries(
      balances.map((b) => [b.currencyId, b.balance]),
    );
    expect(map[goldId]).toBe(200);
    expect(map[gemId]).toBe(50);
  });

  it("transfers ALL currency balances from FROM to TO", async () => {
    const result = await transferSubscriber(
      PROJECT_ID,
      `user_from_${RUN_ID}`,
      `user_to_${RUN_ID}`,
    );

    // Return contract: creditsTransferred = sum of all currencies moved
    expect(result.creditsTransferred).toBe(250); // 200 gold + 50 gems

    // TO subscriber now holds both balances
    const toBalances = await getAllBalances(TO_ID);
    const toMap = Object.fromEntries(
      toBalances.map((b) => [b.currencyId, b.balance]),
    );
    expect(toMap[goldId]).toBe(200);
    expect(toMap[gemId]).toBe(50);

    // FROM subscriber balances are net 0 for both currencies
    const fromBalances = await getAllBalances(FROM_ID);
    const fromMap = Object.fromEntries(
      fromBalances.map((b) => [b.currencyId, b.balance]),
    );
    expect(fromMap[goldId] ?? 0).toBe(0);
    expect(fromMap[gemId] ?? 0).toBe(0);
  });
});
