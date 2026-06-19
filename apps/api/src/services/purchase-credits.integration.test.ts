process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
import { grantPurchaseCurrencies } from "./purchase-credits";
import { getBalance } from "./credit-engine";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_rc_${RUN_ID}`;
const SUB_ID = `sub_rc_${RUN_ID}`;
const PRODUCT_ID = `prod_rc_${RUN_ID}`;

describe("grantPurchaseCurrencies", () => {
  let goldId: string;
  let gemId: string;

  afterAll(async () => {
    await drizzle.db
      .delete(drizzle.schema.projects)
      .where(eq(drizzle.schema.projects.id, PROJECT_ID));
  });

  it("grants all bundle currencies and is idempotent on replay", async () => {
    await drizzle.db
      .insert(drizzle.schema.projects)
      .values({ id: PROJECT_ID, name: `RC ${RUN_ID}` });
    await drizzle.db.insert(drizzle.schema.subscribers).values({
      id: SUB_ID,
      projectId: PROJECT_ID,
      rovenueId: `rov_${RUN_ID}`,
    });
    await drizzle.db.insert(drizzle.schema.products).values({
      id: PRODUCT_ID,
      projectId: PROJECT_ID,
      identifier: `pack_${RUN_ID}`,
      type: "CONSUMABLE",
      storeIds: {},
      displayName: "Starter Pack",
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
    await drizzle.productCurrencyGrantRepo.setProductGrants(
      drizzle.db,
      PRODUCT_ID,
      [
        { currencyId: goldId, amount: 1000 },
        { currencyId: gemId, amount: 5 },
      ],
    );

    const purchaseId = `pur_${RUN_ID}`;
    await grantPurchaseCurrencies({
      subscriberId: SUB_ID,
      productId: PRODUCT_ID,
      purchaseId,
      productIdentifier: `pack_${RUN_ID}`,
    });
    // Replay (at-least-once outbox / webhook retry).
    await grantPurchaseCurrencies({
      subscriberId: SUB_ID,
      productId: PRODUCT_ID,
      purchaseId,
      productIdentifier: `pack_${RUN_ID}`,
    });

    expect(await getBalance(SUB_ID, goldId)).toBe(1000);
    expect(await getBalance(SUB_ID, gemId)).toBe(5);
  });
});
