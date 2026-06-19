// =============================================================
// listRecentOutgoingWebhooks / countOutgoingWebhooks — integration
//
// Verifies the dashboard "recent deliveries" read: project-scoped,
// newest-first, ALL statuses (not just DEAD). Runs against dev
// Postgres (docker-compose host port 5433) configured in
// apps/api/tests/setup.ts. Rows keyed by a unique RUN_ID so parallel
// runs against the shared dev DB don't collide.
// =============================================================

import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, outgoingWebhooks, projects, subscribers, drizzle } from "@rovenue/db";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_whlist_${RUN_ID}`;
const OTHER_PROJECT_ID = `prj_whlist_other_${RUN_ID}`;
const SUBSCRIBER_ID = `sub_whlist_${RUN_ID}`;

async function seed(): Promise<void> {
  const db = getDb();
  await db.insert(projects).values([
    { id: PROJECT_ID, name: `Webhook List Test ${RUN_ID}` },
    { id: OTHER_PROJECT_ID, name: `Webhook List Other ${RUN_ID}` },
  ]);
  await db.insert(subscribers).values({
    id: SUBSCRIBER_ID,
    projectId: PROJECT_ID,
    rovenueId: `app_user_whlist_${RUN_ID}`,
    appUserId: `app_user_whlist_${RUN_ID}`,
  });
  // 3 for our project (mixed statuses), 1 for the other project.
  const statuses = ["SENT", "PENDING", "DEAD"] as const;
  for (let i = 0; i < statuses.length; i++) {
    await db.insert(outgoingWebhooks).values({
      id: `ogw_whlist_${RUN_ID}_${i}`,
      projectId: PROJECT_ID,
      eventType: `evt.${i}`,
      subscriberId: SUBSCRIBER_ID,
      purchaseId: null,
      payload: { i },
      url: "https://example.test/hook",
      status: statuses[i],
      attempts: i,
    });
  }
  await db.insert(outgoingWebhooks).values({
    id: `ogw_whlist_${RUN_ID}_other`,
    projectId: OTHER_PROJECT_ID,
    eventType: "evt.other",
    subscriberId: SUBSCRIBER_ID,
    purchaseId: null,
    payload: {},
    url: "https://example.test/hook",
    status: "SENT",
    attempts: 0,
  });
}

afterAll(async () => {
  const db = getDb();
  await db.delete(projects).where(eq(projects.id, PROJECT_ID));
  await db.delete(projects).where(eq(projects.id, OTHER_PROJECT_ID));
});

describe("listRecentOutgoingWebhooks / countOutgoingWebhooks", () => {
  it("returns all statuses for the project, newest first, scoped out other projects", async () => {
    await seed();
    const db = getDb();

    const rows = await drizzle.outgoingWebhookRepo.listRecentOutgoingWebhooks(db, {
      projectId: PROJECT_ID,
      limit: 50,
      offset: 0,
    });
    const ours = rows.filter((r) => r.id.startsWith(`ogw_whlist_${RUN_ID}_`) && !r.id.endsWith("other"));
    expect(ours).toHaveLength(3);
    expect(new Set(ours.map((r) => r.status))).toEqual(new Set(["SENT", "PENDING", "DEAD"]));
    expect(rows.every((r) => r.projectId === PROJECT_ID)).toBe(true);
    // newest first: createdAt is non-increasing
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].createdAt.getTime()).toBeGreaterThanOrEqual(rows[i].createdAt.getTime());
    }

    const total = await drizzle.outgoingWebhookRepo.countOutgoingWebhooks(db, PROJECT_ID);
    expect(total).toBe(3);
  });
});
