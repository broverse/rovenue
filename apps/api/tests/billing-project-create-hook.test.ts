import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../packages/db/src/drizzle/client";
import {
  billingSubscriptions,
  projects,
} from "../../packages/db/src/drizzle/schema";
import { createFreeSubscription } from "../src/services/billing/create-free-subscription";

const PID = "proj_test_hook";

async function cleanup() {
  await db
    .delete(billingSubscriptions)
    .where(eq(billingSubscriptions.projectId, PID));
  await db.delete(projects).where(eq(projects.id, PID));
}

describe("createFreeSubscription service", () => {
  beforeEach(cleanup);
  afterAll(cleanup);

  it("inserts a free row for a project inside a transaction", async () => {
    await db.transaction(async (tx) => {
      await tx.insert(projects).values({
        id: PID,
        slug: "test-hook",
        name: "Test Hook",
        ownerId: "usr_demo",
      });
      await createFreeSubscription(tx, PID);
    });
    const rows = await db
      .select()
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.projectId, PID));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.state).toBe("free");
    expect(rows[0]!.tier).toBe("free");
  });

  it("rolls back when the transaction fails", async () => {
    await expect(
      db.transaction(async (tx) => {
        await tx.insert(projects).values({
          id: PID,
          slug: "test-hook-rollback",
          name: "Test Hook Rollback",
          ownerId: "usr_demo",
        });
        await createFreeSubscription(tx, PID);
        throw new Error("simulated downstream failure");
      }),
    ).rejects.toThrow("simulated downstream failure");
    const rows = await db
      .select()
      .from(billingSubscriptions)
      .where(eq(billingSubscriptions.projectId, PID));
    expect(rows).toHaveLength(0);
    const projectRows = await db
      .select()
      .from(projects)
      .where(eq(projects.id, PID));
    expect(projectRows).toHaveLength(0);
  });
});
