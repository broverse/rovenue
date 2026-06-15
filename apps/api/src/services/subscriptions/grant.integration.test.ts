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
  access,
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
    rovenueId: `app_user_${RUN_ID}${suffix}`,
    appUserId: `app_user_${RUN_ID}${suffix}`,
  });
  return { id };
}

async function seedAccess({
  projectId,
  suffix = "",
}: {
  projectId: string;
  suffix?: string;
}) {
  const db = getDb();
  // cuid2 shape: 24 lowercase alphanumeric — make it deterministic-ish
  // by hashing the suffix into the trailing chars.
  const id = `acsgranttest${String(RUN_ID).padStart(10, "0").slice(-10)}${suffix.padEnd(2, "x").slice(0, 2)}`.padEnd(24, "0").slice(0, 24);
  await db.insert(access).values({
    id,
    projectId,
    identifier: `pro_${RUN_ID}${suffix}`,
    displayName: `Pro Access ${RUN_ID}${suffix}`,
  });
  return { id };
}

async function seedProduct({
  projectId,
  accessIds,
  suffix = "",
}: {
  projectId: string;
  accessIds: string[];
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
    accessIds,
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
    .where(eq(projects.id, `prj_granttest_${RUN_ID}C`));
  await db
    .delete(projects)
    .where(eq(projects.id, `prj_granttest_${RUN_ID}D`));
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
    const prod = await seedProduct({ ...{ projectId: project.id }, accessIds: [(await seedAccess({ projectId: project.id })).id] });
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
    expect(result.priceAmount).toBe("0.0000");
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
    const prod = await seedProduct({ ...{ projectId: project.id, suffix: "A" }, accessIds: [(await seedAccess({ projectId: project.id, suffix: "A" })).id] });

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
    const projectA = await seedProject("C");
    const projectB = await seedProject("D");
    const subB = await seedSubscriber({ projectId: projectB.id, suffix: "D" });
    const prodA = await seedProduct({ ...{ projectId: projectA.id, suffix: "C" }, accessIds: [(await seedAccess({ projectId: projectA.id, suffix: "C" })).id] });

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
    const prod = await seedProduct({ ...{ projectId: project.id, suffix: "custom" }, accessIds: [(await seedAccess({ projectId: project.id, suffix: "custom" })).id] });

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
