// =============================================================
// bindAppUserId — integration tests
//
// Hits a real migrated Postgres (docker-compose dev stack on host
// port 5433 or a .env.test override). Each test run uses a unique
// RUN_ID suffix so concurrent runs don't collide, and afterAll
// cleans up the project row (cascade removes subscribers).
// =============================================================

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, projects, subscribers, CreditLedgerType, drizzle } from "@rovenue/db";
import { bindAppUserId } from "../src/services/identify";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_identify_${RUN_ID}`;

let SEED_CURRENCY_ID: string;

describe("bindAppUserId", () => {
  beforeAll(async () => {
    await getDb()
      .insert(projects)
      .values({ id: PROJECT_ID, name: `Identify Test ${RUN_ID}` });
    const currency = await drizzle.virtualCurrencyRepo.createVirtualCurrency(getDb(), {
      projectId: PROJECT_ID,
      code: "GLD",
      name: "Coins",
    });
    SEED_CURRENCY_ID = currency.id;
  });

  afterAll(async () => {
    await getDb().delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  beforeEach(async () => {
    // Remove all subscribers for this project between tests so each
    // case starts from a clean slate.
    await getDb()
      .delete(subscribers)
      .where(eq(subscribers.projectId, PROJECT_ID));
  });

  async function insertSub(rovenueId: string, appUserId: string | null) {
    const [row] = await getDb()
      .insert(subscribers)
      .values({ projectId: PROJECT_ID, rovenueId, appUserId })
      .returning();
    return row!;
  }

  it("attaches the label when the appUserId is unused (no transfer)", async () => {
    const self = await insertSub("rov_1", null);
    const res = await bindAppUserId(PROJECT_ID, "rov_1", "user_1");
    expect(res.transferred).toBe(false);
    expect(res.subscriberId).toBe(self.id);
    const after = await drizzle.subscriberRepo.findSubscriberById(
      getDb(),
      self.id,
    );
    expect(after?.appUserId).toBe("user_1");
    expect(after?.identifiedAt).not.toBeNull();
  });

  it("is idempotent when the same label is already set", async () => {
    await insertSub("rov_2", "user_2");
    const res = await bindAppUserId(PROJECT_ID, "rov_2", "user_2");
    expect(res.transferred).toBe(false);
  });

  it("auto-transfers assets from the prior holder to this device", async () => {
    const other = await insertSub("rov_old", "user_3");
    const self = await insertSub("rov_new", null);

    // Seed 50 credits on the prior holder.
    await drizzle.creditLedgerRepo.insertCreditLedger(getDb(), {
      projectId: PROJECT_ID,
      subscriberId: other.id,
      currencyId: SEED_CURRENCY_ID,
      type: CreditLedgerType.BONUS,
      amount: 50,
      balance: 50,
      referenceType: "seed",
      referenceId: "seed",
      description: "seed",
    });

    const res = await bindAppUserId(PROJECT_ID, "rov_new", "user_3");

    expect(res.transferred).toBe(true);
    expect(res.subscriberId).toBe(self.id);

    const selfAfter = await drizzle.subscriberRepo.findSubscriberById(
      getDb(),
      self.id,
    );
    expect(selfAfter?.appUserId).toBe("user_3");

    const otherAfter = await drizzle.subscriberRepo.findSubscriberById(
      getDb(),
      other.id,
    );
    expect(otherAfter?.deletedAt).not.toBeNull();
    expect(otherAfter?.mergedInto).toBe(self.id);

    const bal = await drizzle.creditLedgerRepo.findLatestBalance(
      getDb(),
      self.id,
      SEED_CURRENCY_ID,
    );
    expect(bal?.balance).toBe(50);
  });

  it("binds onto the canonical live row when the device row was already merged", async () => {
    // R2 is the live canonical row (no appUserId yet).
    const r2 = await insertSub("rov_canonical", null);
    // R1 is a soft-deleted device row already merged into R2.
    const [r1] = await getDb()
      .insert(subscribers)
      .values({
        projectId: PROJECT_ID,
        rovenueId: "rov_merged_device",
        appUserId: null,
        deletedAt: new Date(),
        mergedInto: r2.id,
      })
      .returning();

    const res = await bindAppUserId(PROJECT_ID, "rov_merged_device", "userX");

    // The label must land on R2 (the live row), NOT R1.
    expect(res.subscriberId).toBe(r2.id);

    const r2After = await drizzle.subscriberRepo.findSubscriberById(
      getDb(),
      r2.id,
    );
    expect(r2After?.appUserId).toBe("userX");

    const r1After = await drizzle.subscriberRepo.findSubscriberById(
      getDb(),
      r1!.id,
    );
    expect(r1After?.appUserId).toBeNull();
    expect(r1After?.deletedAt).not.toBeNull();
  });

  it("throws when the device row (rovenueId) does not exist", async () => {
    await expect(
      bindAppUserId(PROJECT_ID, "rov_missing", "user_x"),
    ).rejects.toThrow(/not found/i);
  });
});
