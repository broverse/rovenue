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
const STALE_LEGACY_ID = `whe_inb_legacy_${RUN_ID}`;
const STALE_CAPPED_ID = `whe_inb_capped_${RUN_ID}`;
const FRESH_ID = `whe_inb_fresh_${RUN_ID}`;

// Past the MAX_REAPER_REQUEUES cap — such a row must stay FAILED
// without being re-enqueued.
const CAPPED_RETRY_COUNT = 99;

const STALE_STRIPE_EVENT = { id: `evt_${RUN_ID}`, type: "invoice.paid" };

async function seed(): Promise<void> {
  const db = getDb();
  await db.insert(projects).values({
    id: PROJECT_ID,
    name: `Webhook Inbound Reaper Test ${RUN_ID}`,
    webhookSecret: `whsec_inb_${RUN_ID}`,
  });

  const now = Date.now();
  const pastLease = new Date(now - 10 * 60_000);
  // Stale replayable row: claimed 10 minutes ago (well past the 5m
  // lease), Stripe payload IS the original event → re-enqueued.
  await db.insert(webhookEvents).values({
    id: STALE_ID,
    projectId: PROJECT_ID,
    source: "STRIPE",
    eventType: "invoice.paid",
    storeEventId: `stripe_stale_${RUN_ID}`,
    payload: STALE_STRIPE_EVENT,
    status: "PROCESSING",
    claimedAt: pastLease,
  });
  // Stale legacy row: pre-Task-7 Apple payload (bare decoded
  // notification, no signedPayload) → reclaimed but NOT re-enqueued.
  await db.insert(webhookEvents).values({
    id: STALE_LEGACY_ID,
    projectId: PROJECT_ID,
    source: "APPLE",
    eventType: "SUBSCRIPTIONS_SUBSCRIBED",
    storeEventId: `apple_stale_${RUN_ID}`,
    payload: {},
    status: "PROCESSING",
    claimedAt: pastLease,
  });
  // Stale but past the requeue cap → reclaimed, NOT re-enqueued.
  await db.insert(webhookEvents).values({
    id: STALE_CAPPED_ID,
    projectId: PROJECT_ID,
    source: "STRIPE",
    eventType: "invoice.paid",
    storeEventId: `stripe_capped_${RUN_ID}`,
    payload: STALE_STRIPE_EVENT,
    status: "PROCESSING",
    claimedAt: pastLease,
    retryCount: CAPPED_RETRY_COUNT,
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
  it("reclaims stale PROCESSING rows, re-enqueues replayable ones, leaves fresh ones untouched", async () => {
    const db = getDb();
    await seed();

    // Collect re-enqueues instead of touching a real BullMQ queue.
    const enqueued: Array<{ data: unknown; jobId: string }> = [];
    const result = await runWebhookReaper(new Date(), async (data, opts) => {
      enqueued.push({ data, jobId: opts.jobId });
    });

    expect(result).toEqual({ reclaimed: 3, requeued: 1 });

    // All three stale rows must be FAILED with incremented retryCount.
    for (const id of [STALE_ID, STALE_LEGACY_ID, STALE_CAPPED_ID]) {
      const [stale] = await db
        .select()
        .from(webhookEvents)
        .where(eq(webhookEvents.id, id));
      expect(stale?.status).toBe("FAILED");
      expect(stale?.errorMessage).toMatch(/reclaimed/);
    }
    const [staleReplayable] = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.id, STALE_ID));
    expect(staleReplayable?.retryCount).toBe(1);

    // Only the replayable, under-cap row is re-enqueued, with the
    // deterministic jobId (event id + post-reclaim retryCount).
    expect(enqueued).toEqual([
      {
        data: {
          source: "STRIPE",
          projectId: PROJECT_ID,
          event: STALE_STRIPE_EVENT,
        },
        jobId: `webhook-replay:${STALE_ID}:1`,
      },
    ]);

    // Fresh row must remain PROCESSING.
    const [fresh] = await db
      .select()
      .from(webhookEvents)
      .where(eq(webhookEvents.id, FRESH_ID));
    expect(fresh?.status).toBe("PROCESSING");
    expect(fresh?.claimedAt).not.toBeNull();
  });
});
