// =============================================================
// webhook-reaper — inbound-webhook stale-claim reaper integration test (W2.4)
//
// A PROCESSING row whose claimedAt predates the 5-minute lease window
// is orphaned (its worker crashed mid-processing) and must be reset to
// FAILED with retryCount incremented; a freshly-claimed PROCESSING row
// must be left alone.
//
// Runs against dev Postgres (host port 5433) per apps/api/tests/setup.ts.
// =============================================================

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, webhookEvents, projects, drizzle } from "@rovenue/db";
import { runWebhookReaper } from "./webhook-reaper";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_whreap_inb_${RUN_ID}`;
const STALE_ID = `whe_inb_stale_${RUN_ID}`;
const FRESH_ID = `whe_inb_fresh_${RUN_ID}`;

async function seed(): Promise<void> {
  const db = getDb();
  await db.insert(projects).values({
    id: PROJECT_ID,
    name: `Webhook Inbound Reaper Test ${RUN_ID}`,
    webhookSecret: `whsec_inb_${RUN_ID}`,
  });

  const now = Date.now();
  // Stale: claimed 10 minutes ago (well past the 5m lease).
  await db.insert(webhookEvents).values({
    id: STALE_ID,
    projectId: PROJECT_ID,
    source: "APPLE",
    eventType: "SUBSCRIPTIONS_SUBSCRIBED",
    storeEventId: `apple_stale_${RUN_ID}`,
    payload: {},
    status: "PROCESSING",
    claimedAt: new Date(now - 10 * 60_000),
  });
  // Fresh: claimed 30 seconds ago (inside the lease).
  await db.insert(webhookEvents).values({
    id: FRESH_ID,
    projectId: PROJECT_ID,
    source: "GOOGLE",
    eventType: "SUBSCRIPTION_PURCHASED",
    storeEventId: `google_fresh_${RUN_ID}`,
    payload: {},
    status: "PROCESSING",
    claimedAt: new Date(now - 30_000),
  });
}

afterAll(async () => {
  const db = getDb();
  await db.delete(webhookEvents).where(eq(webhookEvents.projectId, PROJECT_ID));
  await db.delete(projects).where(eq(projects.id, PROJECT_ID));
});

describe("runWebhookReaper", () => {
  it("reclaims a stale PROCESSING row and leaves a fresh one untouched", async () => {
    const db = getDb();
    await seed();

    const result = await runWebhookReaper(new Date());
    expect(result).toEqual({ reclaimed: 1 });

    // Stale row must be FAILED with incremented retryCount.
    const [stale] = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.id, STALE_ID));
    expect(stale?.status).toBe("FAILED");
    expect(stale?.errorMessage).toMatch(/reclaimed/);

    // Fresh row must remain PROCESSING.
    const [fresh] = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.id, FRESH_ID));
    expect(fresh?.status).toBe("PROCESSING");
    expect(fresh?.claimedAt).not.toBeNull();
  });
});
