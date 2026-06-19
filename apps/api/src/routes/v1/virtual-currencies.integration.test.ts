process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
import { buildBalancesMap } from "./virtual-currencies";
import { addCredits, getBalance } from "../../services/credit-engine";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_vcv1_${RUN_ID}`;
const SUB_ID = `sub_vcv1_${RUN_ID}`;

describe("v1 virtual-currencies helpers", () => {
  afterAll(async () => {
    await drizzle.db
      .delete(drizzle.schema.projects)
      .where(eq(drizzle.schema.projects.id, PROJECT_ID));
  });

  it("builds a code-keyed balances map", async () => {
    // Seed project + subscriber
    await drizzle.db.insert(drizzle.schema.projects).values({
      id: PROJECT_ID,
      name: `vc-test-${RUN_ID}`,
    });
    await drizzle.db.insert(drizzle.schema.subscribers).values({
      id: SUB_ID,
      projectId: PROJECT_ID,
      rovenueId: `rovid_${RUN_ID}`,
      appUserId: `app_${RUN_ID}`,
    });

    // Seed a virtual currency
    const [emr] = await drizzle.db
      .insert(drizzle.schema.virtualCurrencies)
      .values({
        projectId: PROJECT_ID,
        code: "EMR",
        name: "Emeralds",
      })
      .returning();

    if (!emr) throw new Error("Currency seed failed");

    // Grant some credits
    await addCredits({ subscriberId: SUB_ID, currencyId: emr.id, amount: 70 });

    const map = await buildBalancesMap(PROJECT_ID, SUB_ID);
    expect(map.EMR).toBe(70);
    expect(await getBalance(SUB_ID, emr.id)).toBe(70);
  });
});
