import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../packages/db/src/drizzle/client";
import {
  billingPaymentMethods,
  projects,
  user,
} from "../../packages/db/src/drizzle/schema";
import {
  insertPaymentMethod,
  listPaymentMethodsForProject,
  findDefaultPaymentMethod,
  setDefaultPaymentMethod,
  deletePaymentMethod,
} from "../../packages/db/src/drizzle/repositories/billing-payment-methods";

const TEST_PROJECT_ID = "proj_test_pm_repo";
const OWNER_ID = "usr_demo";

async function setup() {
  await db.delete(billingPaymentMethods)
    .where(eq(billingPaymentMethods.projectId, TEST_PROJECT_ID));
  await db.delete(projects).where(eq(projects.id, TEST_PROJECT_ID));
  await db
    .insert(user)
    .values({
      id: OWNER_ID,
      name: "Demo User",
      email: "demo@rovenue.dev",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();
  await db.insert(projects).values({
    id: TEST_PROJECT_ID,
    slug: "test-pm-repo",
    name: "Test PM",
    ownerId: OWNER_ID,
  });
}

describe("billing-payment-methods repository", () => {
  beforeEach(setup);
  afterAll(setup);

  it("insertPaymentMethod adds a row", async () => {
    const row = await insertPaymentMethod(db, {
      projectId: TEST_PROJECT_ID,
      stripePaymentMethodId: "pm_test_1",
      brand: "visa",
      last4: "4242",
      expMonth: 12,
      expYear: 2030,
      isDefault: true,
    });
    expect(row.id).toMatch(/^[a-z0-9]+$/);
    expect(row.last4).toBe("4242");
  });

  it("listPaymentMethodsForProject returns inserted rows", async () => {
    await insertPaymentMethod(db, {
      projectId: TEST_PROJECT_ID,
      stripePaymentMethodId: "pm_test_1",
      brand: "visa",
      last4: "4242",
      expMonth: 12,
      expYear: 2030,
      isDefault: true,
    });
    await insertPaymentMethod(db, {
      projectId: TEST_PROJECT_ID,
      stripePaymentMethodId: "pm_test_2",
      brand: "mastercard",
      last4: "5555",
      expMonth: 6,
      expYear: 2028,
      isDefault: false,
    });
    const rows = await listPaymentMethodsForProject(db, TEST_PROJECT_ID);
    expect(rows).toHaveLength(2);
  });

  it("findDefaultPaymentMethod returns the default row", async () => {
    await insertPaymentMethod(db, {
      projectId: TEST_PROJECT_ID,
      stripePaymentMethodId: "pm_test_3",
      brand: "visa",
      last4: "1111",
      expMonth: 1,
      expYear: 2031,
      isDefault: true,
    });
    const def = await findDefaultPaymentMethod(db, TEST_PROJECT_ID);
    expect(def?.last4).toBe("1111");
  });

  it("setDefaultPaymentMethod swaps the default exclusively", async () => {
    const a = await insertPaymentMethod(db, {
      projectId: TEST_PROJECT_ID,
      stripePaymentMethodId: "pm_a",
      brand: "visa",
      last4: "aaaa",
      expMonth: 1,
      expYear: 2030,
      isDefault: true,
    });
    const b = await insertPaymentMethod(db, {
      projectId: TEST_PROJECT_ID,
      stripePaymentMethodId: "pm_b",
      brand: "visa",
      last4: "bbbb",
      expMonth: 1,
      expYear: 2030,
      isDefault: false,
    });
    await setDefaultPaymentMethod(db, TEST_PROJECT_ID, b.id);
    const rows = await listPaymentMethodsForProject(db, TEST_PROJECT_ID);
    expect(rows.find((r) => r.id === a.id)!.isDefault).toBe(false);
    expect(rows.find((r) => r.id === b.id)!.isDefault).toBe(true);
  });

  it("deletePaymentMethod removes the row", async () => {
    const r = await insertPaymentMethod(db, {
      projectId: TEST_PROJECT_ID,
      stripePaymentMethodId: "pm_test_4",
      brand: "visa",
      last4: "9999",
      expMonth: 12,
      expYear: 2030,
      isDefault: false,
    });
    await deletePaymentMethod(db, r.id);
    const rows = await listPaymentMethodsForProject(db, TEST_PROJECT_ID);
    expect(rows).toHaveLength(0);
  });

  it("two defaults in the same project conflicts on the partial index", async () => {
    await insertPaymentMethod(db, {
      projectId: TEST_PROJECT_ID,
      stripePaymentMethodId: "pm_def_1",
      brand: "visa",
      last4: "1234",
      expMonth: 1,
      expYear: 2030,
      isDefault: true,
    });
    await expect(
      insertPaymentMethod(db, {
        projectId: TEST_PROJECT_ID,
        stripePaymentMethodId: "pm_def_2",
        brand: "visa",
        last4: "5678",
        expMonth: 1,
        expYear: 2030,
        isDefault: true,
      }),
    ).rejects.toThrow();
  });
});
