import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../packages/db/src/drizzle/client";
import {
  billingSubscriptions,
  projects,
  user,
} from "../../packages/db/src/drizzle/schema";
import {
  createFreeBillingSubscription,
  findBillingSubscriptionByProject,
} from "../../packages/db/src/drizzle/repositories/billing-subscriptions";

const TEST_PROJECT_ID = "proj_test_billing_repo";
const OWNER_ID = "usr_demo";

async function seedUser() {
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
}

async function seedProject() {
  await db
    .insert(projects)
    .values({
      id: TEST_PROJECT_ID,
      slug: "test-billing-repo",
      name: "Test Billing Repo",
      ownerId: OWNER_ID,
    })
    .onConflictDoNothing();
}

async function cleanup() {
  await db
    .delete(billingSubscriptions)
    .where(eq(billingSubscriptions.projectId, TEST_PROJECT_ID));
  await db.delete(projects).where(eq(projects.id, TEST_PROJECT_ID));
}

describe("billing-subscriptions repository", () => {
  beforeEach(async () => {
    await cleanup();
    await seedUser();
    await seedProject();
  });
  afterAll(cleanup);

  it("createFreeBillingSubscription inserts a free row", async () => {
    const row = await createFreeBillingSubscription(db, TEST_PROJECT_ID);
    expect(row.state).toBe("free");
    expect(row.tier).toBe("free");
    expect(row.cycle).toBe("monthly");
    expect(row.stripeCustomerId).toBeNull();
    expect(row.stripeSubscriptionId).toBeNull();
    expect(row.projectId).toBe(TEST_PROJECT_ID);
  });

  it("findBillingSubscriptionByProject returns the active row", async () => {
    await createFreeBillingSubscription(db, TEST_PROJECT_ID);
    const found = await findBillingSubscriptionByProject(db, TEST_PROJECT_ID);
    expect(found).not.toBeNull();
    expect(found!.state).toBe("free");
  });

  it("findBillingSubscriptionByProject returns null for unknown project", async () => {
    const found = await findBillingSubscriptionByProject(
      db,
      "proj_does_not_exist",
    );
    expect(found).toBeNull();
  });

  it("createFreeBillingSubscription is unique-per-project (partial index)", async () => {
    await createFreeBillingSubscription(db, TEST_PROJECT_ID);
    await expect(
      createFreeBillingSubscription(db, TEST_PROJECT_ID),
    ).rejects.toThrow();
  });
});
