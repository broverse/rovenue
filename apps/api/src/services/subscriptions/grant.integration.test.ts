// =============================================================
// grantComp service — integration tests (TDD step 1 — FAILING)
//
// These tests exercise the not-yet-implemented grantComp() service
// in ./grant.ts. They should fail with "Cannot find module './grant'"
// until Task 7 lands.
//
// Infrastructure notes:
//   - No withTestDb / seedProject helpers exist in this codebase.
//     Integration tests use getDb() directly and insert rows inline.
//   - Tests run against the dev Postgres (docker-compose host port 5433)
//     configured in apps/api/tests/setup.ts.
//   - Each test inserts isolated rows keyed by a unique RUN_ID so
//     parallel test runs and re-runs against the dev DB don't collide.
// =============================================================

import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  getDb,
  projects,
  subscribers,
  products,
  purchases,
  subscriberAccess,
  auditLogs,
  outboxEvents,
} from "@rovenue/db";
import { grantComp } from "./grant";

// ---------------------------------------------------------------------------
// Inline seed helpers — follows the pattern of outbox-dispatcher.integration
// ---------------------------------------------------------------------------

const RUN_ID = Date.now();

async function seedProject(suffix = "") {
  const db = getDb();
  const id = `prj_granttest_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `Grant Test Project ${RUN_ID}${suffix}`,
  });
  return { id };
}

async function seedSubscriber({
  projectId,
  suffix = "",
}: {
  projectId: string;
  suffix?: string;
}) {
  const db = getDb();
  const id = `sub_granttest_${RUN_ID}${suffix}`;
  await db.insert(subscribers).values({
    id,
    projectId,
    appUserId: `app_user_${RUN_ID}${suffix}`,
  });
  return { id };
}

async function seedProduct({
  projectId,
  suffix = "",
}: {
  projectId: string;
  suffix?: string;
}) {
  const db = getDb();
  const id = `prod_granttest_${RUN_ID}${suffix}`;
  await db.insert(products).values({
    id,
    projectId,
    identifier: `com.rovenue.test.product_${RUN_ID}${suffix}`,
    type: "SUBSCRIPTION",
    storeIds: {},
    displayName: `Test Product ${RUN_ID}${suffix}`,
  });
  return { id };
}

// ---------------------------------------------------------------------------
// Cleanup — remove all rows inserted by this test run
// ---------------------------------------------------------------------------

afterAll(async () => {
  const db = getDb();
  // Delete projects (cascades to subscribers, products, purchases, etc.)
  await db
    .delete(projects)
    .where(eq(projects.id, `prj_granttest_${RUN_ID}`));
  await db
    .delete(projects)
    .where(eq(projects.id, `prj_granttest_${RUN_ID}A`));
  await db
    .delete(projects)
    .where(eq(projects.id, `prj_granttest_${RUN_ID}B`));
  await db
    .delete(projects)
    .where(eq(projects.id, `prj_granttest_${RUN_ID}custom`));
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("grantComp", () => {
  it("creates a MANUAL purchase with computed expiresDate for a 3mo preset", async () => {
    const project = await seedProject();
    const sub = await seedSubscriber({ projectId: project.id });
    const prod = await seedProduct({ projectId: project.id });
    const db = getDb();

    const result = await grantComp({
      projectId: project.id,
      actorUserId: "user-1",
      input: {
        subscriberId: sub.id,
        productId: prod.id,
        duration: { kind: "preset", preset: "3mo" },
        note: "VIP comp",
      },
    });

    expect(result.store).toBe("MANUAL");
    expect(result.storeTransactionId).toMatch(/^comp_/);
    expect(result.priceAmount).toBe("0");
    expect(result.autoRenewStatus).toBe(false);

    const now = Date.now();
    const expires = result.expiresDate!.getTime();
    const expectedMs = 90 * 24 * 3600 * 1000;
    expect(Math.abs(expires - (now + expectedMs))).toBeLessThan(
      2 * 24 * 3600 * 1000,
    );

    const access = await db
      .select()
      .from(subscriberAccess)
      .where(eq(subscriberAccess.purchaseId, result.id));
    expect(access.length).toBeGreaterThan(0);

    const audits = await db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, result.id));
    expect(audits[0]?.action).toBe("subscription.granted");

    const outbox = await db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, result.id));
    expect(outbox.length).toBe(1);
  });

  it("creates a lifetime grant with expiresDate=null", async () => {
    const project = await seedProject("A");
    const sub = await seedSubscriber({ projectId: project.id, suffix: "A" });
    const prod = await seedProduct({ projectId: project.id, suffix: "A" });

    const result = await grantComp({
      projectId: project.id,
      actorUserId: "user-1",
      input: {
        subscriberId: sub.id,
        productId: prod.id,
        duration: { kind: "preset", preset: "lifetime" },
      },
    });

    expect(result.expiresDate).toBeNull();
  });

  it("rejects a subscriber from another project", async () => {
    const projectA = await seedProject("A");
    const projectB = await seedProject("B");
    const subB = await seedSubscriber({ projectId: projectB.id, suffix: "B" });
    const prodA = await seedProduct({ projectId: projectA.id, suffix: "A" });

    await expect(
      grantComp({
        projectId: projectA.id,
        actorUserId: "user-1",
        input: {
          subscriberId: subB.id,
          productId: prodA.id,
          duration: { kind: "preset", preset: "1mo" },
        },
      }),
    ).rejects.toThrow(/subscriber/i);
  });

  it("rejects a custom expiresAt in the past", async () => {
    const project = await seedProject("custom");
    const sub = await seedSubscriber({ projectId: project.id, suffix: "custom" });
    const prod = await seedProduct({ projectId: project.id, suffix: "custom" });

    await expect(
      grantComp({
        projectId: project.id,
        actorUserId: "user-1",
        input: {
          subscriberId: sub.id,
          productId: prod.id,
          duration: {
            kind: "custom",
            expiresAt: new Date(Date.now() - 1000).toISOString(),
          },
        },
      }),
    ).rejects.toThrow(/future/i);
  });
});
