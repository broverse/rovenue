process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../client";
import { projects } from "../schema";
import * as vcRepo from "./virtual-currencies";
import * as pcgRepo from "./product-currency-grants";
import { products } from "../schema";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_vc_${RUN_ID}`;

describe("virtual-currencies repo", () => {
  afterAll(async () => {
    await getDb().delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  it("creates, lists, finds by code, renames, archives", async () => {
    const db = getDb();
    await db.insert(projects).values({ id: PROJECT_ID, name: `VC ${RUN_ID}` });

    const emr = await vcRepo.createVirtualCurrency(db, {
      projectId: PROJECT_ID,
      code: "EMR",
      name: "Zümrüt",
    });
    expect(emr.code).toBe("EMR");

    const byCode = await vcRepo.findVirtualCurrencyByCode(db, PROJECT_ID, "EMR");
    expect(byCode?.id).toBe(emr.id);

    const renamed = await vcRepo.renameVirtualCurrency(
      db,
      PROJECT_ID,
      emr.id,
      "Emerald",
    );
    expect(renamed?.name).toBe("Emerald");

    expect(await vcRepo.countActiveVirtualCurrencies(db, PROJECT_ID)).toBe(1);

    const archived = await vcRepo.archiveVirtualCurrency(db, PROJECT_ID, emr.id);
    expect(archived?.archivedAt).not.toBeNull();
    expect(await vcRepo.countActiveVirtualCurrencies(db, PROJECT_ID)).toBe(0);

    const active = await vcRepo.listVirtualCurrencies(db, PROJECT_ID);
    expect(active).toHaveLength(0);
    const all = await vcRepo.listVirtualCurrencies(db, PROJECT_ID, {
      includeArchived: true,
    });
    expect(all).toHaveLength(1);
  });
});

describe("product-currency-grants repo", () => {
  const PRODUCT_ID = `prod_pcg_${RUN_ID}`;

  it("replaces grants atomically and lists them", async () => {
    const db = getDb();
    // PROJECT_ID row created in the repo describe above runs first within the
    // same file; recreate defensively in case of isolated execution.
    await db
      .insert(projects)
      .values({ id: PROJECT_ID, name: `VC ${RUN_ID}` })
      .onConflictDoNothing();
    await db.insert(products).values({
      id: PRODUCT_ID,
      projectId: PROJECT_ID,
      identifier: `pack_${RUN_ID}`,
      type: "CONSUMABLE",
      storeIds: {},
      displayName: "Starter Pack",
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

    await pcgRepo.setProductGrants(db, PRODUCT_ID, [
      { currencyId: gold.id, amount: 1000 },
      { currencyId: gem.id, amount: 5 },
    ]);
    let grants = await pcgRepo.listProductGrants(db, PRODUCT_ID);
    expect(grants).toHaveLength(2);

    // Replace: now only gold, different amount.
    await pcgRepo.setProductGrants(db, PRODUCT_ID, [
      { currencyId: gold.id, amount: 2000 },
    ]);
    grants = await pcgRepo.listProductGrants(db, PRODUCT_ID);
    expect(grants).toHaveLength(1);
    expect(grants[0]?.amount).toBe(2000);
  });
});
