// =============================================================
// findSubscriberIdentityById — integration test
// =============================================================
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance
// (the docker-compose dev stack on host port 5433 satisfies this).
// Pattern mirrors the sibling subscribers.churn-risk.integration.test.ts.
//
// Task 1 of the integrations Wave-1 plan: a minimal, soft-delete-aware
// projection ({ appUserId, attributes }) used by outbound integrations
// (AppsFlyer/Adjust/Firebase/Mixpanel/Amplitude id resolution) that
// avoids pulling the full Subscriber row.

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb } from "../client";
import { projects, subscribers } from "../schema";
import { findSubscriberIdentityById } from "./subscribers";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_identity_proj_${RUN_ID}`;

describe("findSubscriberIdentityById", () => {
  let liveId: string;
  let softDeletedId: string;

  beforeAll(async () => {
    const db = getDb();
    await db.insert(projects).values({ id: PROJECT_ID, name: `Identity Proj ${RUN_ID}` });

    const [live] = await db
      .insert(subscribers)
      .values({
        projectId: PROJECT_ID,
        rovenueId: `r-live-${RUN_ID}`,
        appUserId: "app-user-live",
        attributes: { $appsflyerId: "af-123", $adjustId: "adj-456" },
      })
      .returning();
    liveId = live!.id;

    const [softDeleted] = await db
      .insert(subscribers)
      .values({
        projectId: PROJECT_ID,
        rovenueId: `r-deleted-${RUN_ID}`,
        appUserId: "app-user-deleted",
        attributes: {},
        deletedAt: new Date(),
      })
      .returning();
    softDeletedId = softDeleted!.id;
  });

  afterAll(async () => {
    const db = getDb();
    await db.delete(subscribers).where(eq(subscribers.projectId, PROJECT_ID));
    await db.delete(projects).where(eq(projects.id, PROJECT_ID));
  });

  it("returns { appUserId, attributes } for a live subscriber", async () => {
    const db = getDb();
    const row = await findSubscriberIdentityById(db, liveId);
    expect(row).toEqual({
      appUserId: "app-user-live",
      attributes: { $appsflyerId: "af-123", $adjustId: "adj-456" },
    });
  });

  it("returns undefined for a soft-deleted subscriber", async () => {
    const db = getDb();
    const row = await findSubscriberIdentityById(db, softDeletedId);
    expect(row).toBeUndefined();
  });

  it("returns undefined for an unknown id", async () => {
    const db = getDb();
    const row = await findSubscriberIdentityById(db, `nonexistent-${RUN_ID}`);
    expect(row).toBeUndefined();
  });
});
