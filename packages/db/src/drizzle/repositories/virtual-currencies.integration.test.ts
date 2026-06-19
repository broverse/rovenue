process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../client";
import { projects } from "../schema";
import * as vcRepo from "./virtual-currencies";

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
