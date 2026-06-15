// =============================================================
// reclaimStaleDeliveries — stale-claim reaper integration test (P0-3b)
//
// A DELIVERING row whose claimedAt predates the 5-minute lease window
// is orphaned (its worker crashed mid-delivery) and must be reset to
// PENDING; a freshly-claimed DELIVERING row must be left alone.
//
// Runs against dev Postgres (host port 5433) per apps/api/tests/setup.ts.
// =============================================================

import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import {
  getDb,
  outgoingWebhooks,
  projects,
  subscribers,
  drizzle,
} from "@rovenue/db";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_whreap_${RUN_ID}`;
const SUBSCRIBER_ID = `sub_whreap_${RUN_ID}`;
const STALE_ID = `ogw_whreap_stale_${RUN_ID}`;
const FRESH_ID = `ogw_whreap_fresh_${RUN_ID}`;

async function seed(): Promise<void> {
  const db = getDb();
  await db.insert(projects).values({
    id: PROJECT_ID,
    name: `Webhook Reaper Test ${RUN_ID}`,
    webhookSecret: `whsec_${RUN_ID}`,
  });
  await db.insert(subscribers).values({
    id: SUBSCRIBER_ID,
    projectId: PROJECT_ID,
    rovenueId: `app_user_whreap_${RUN_ID}`,
    appUserId: `app_user_whreap_${RUN_ID}`,
  });

  const now = Date.now();
  // Stale: claimed 10 minutes ago (well past the 5m lease).
  await db.insert(outgoingWebhooks).values({
    id: STALE_ID,
    projectId: PROJECT_ID,
    eventType: "test.event",
    subscriberId: SUBSCRIBER_ID,
    purchaseId: null,
    payload: {},
    url: "https://example.test/hook",
    status: "DELIVERING",
    attempts: 0,
    claimedAt: new Date(now - 10 * 60_000),
  });
  // Fresh: claimed 30 seconds ago (inside the lease).
  await db.insert(outgoingWebhooks).values({
    id: FRESH_ID,
    projectId: PROJECT_ID,
    eventType: "test.event",
    subscriberId: SUBSCRIBER_ID,
    purchaseId: null,
    payload: {},
    url: "https://example.test/hook",
    status: "DELIVERING",
    attempts: 0,
    claimedAt: new Date(now - 30_000),
  });
}

afterAll(async () => {
  const db = getDb();
  await db.delete(projects).where(eq(projects.id, PROJECT_ID));
});

describe("reclaimStaleDeliveries", () => {
  it("resets a stale DELIVERING row to PENDING and leaves a fresh one", async () => {
    const db = getDb();
    await seed();

    const reclaimed = await drizzle.outgoingWebhookRepo.reclaimStaleDeliveries(
      db,
      new Date(),
    );
    expect(reclaimed).toBe(1);

    const [stale] = await db
      .select()
      .from(outgoingWebhooks)
      .where(eq(outgoingWebhooks.id, STALE_ID));
    expect(stale?.status).toBe("PENDING");
    expect(stale?.claimedAt).toBeNull();

    const [fresh] = await db
      .select()
      .from(outgoingWebhooks)
      .where(eq(outgoingWebhooks.id, FRESH_ID));
    expect(fresh?.status).toBe("DELIVERING");
    expect(fresh?.claimedAt).not.toBeNull();
  });
});
