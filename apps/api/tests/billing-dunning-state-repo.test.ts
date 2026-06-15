import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../packages/db/src/drizzle/client";
import {
  billingDunningState,
  projects,
  user,
} from "../../packages/db/src/drizzle/schema";
import {
  upsertDunningState,
  findDunningStateForProject,
  clearDunningState,
} from "../../packages/db/src/drizzle/repositories/billing-dunning-state";

const PID = "proj_test_dun";

async function setup() {
  await db.delete(billingDunningState)
    .where(eq(billingDunningState.projectId, PID));
  await db.delete(projects).where(eq(projects.id, PID));
  await db
    .insert(user)
    .values({
      id: "usr_demo",
      name: "Demo User",
      email: "demo@rovenue.io",
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .onConflictDoNothing();
  await db.insert(projects).values({
    id: PID,
    slug: "test-dun",
    name: "Test Dun",
    ownerId: "usr_demo",
  });
}

describe("billing-dunning-state repository", () => {
  beforeEach(setup);
  afterAll(setup);

  it("upsertDunningState inserts on first call", async () => {
    const row = await upsertDunningState(db, {
      projectId: PID,
      firstFailureAt: new Date("2026-05-01T00:00:00Z"),
      attemptCount: 1,
      currentPhase: "retrying",
      lastEmailSentAt: new Date("2026-05-01T00:00:00Z"),
    });
    expect(row.currentPhase).toBe("retrying");
  });

  it("upsertDunningState updates on second call", async () => {
    await upsertDunningState(db, {
      projectId: PID,
      firstFailureAt: new Date("2026-05-01T00:00:00Z"),
      attemptCount: 1,
      currentPhase: "retrying",
      lastEmailSentAt: new Date("2026-05-01T00:00:00Z"),
    });
    const r = await upsertDunningState(db, {
      projectId: PID,
      firstFailureAt: new Date("2026-05-01T00:00:00Z"),
      attemptCount: 4,
      currentPhase: "past_due",
      lastEmailSentAt: new Date("2026-05-21T00:00:00Z"),
    });
    expect(r.attemptCount).toBe(4);
    expect(r.currentPhase).toBe("past_due");
  });

  it("findDunningStateForProject returns null when absent", async () => {
    const r = await findDunningStateForProject(db, PID);
    expect(r).toBeNull();
  });

  it("clearDunningState removes the row", async () => {
    await upsertDunningState(db, {
      projectId: PID,
      firstFailureAt: new Date(),
      attemptCount: 1,
      currentPhase: "retrying",
      lastEmailSentAt: new Date(),
    });
    await clearDunningState(db, PID);
    const r = await findDunningStateForProject(db, PID);
    expect(r).toBeNull();
  });
});
