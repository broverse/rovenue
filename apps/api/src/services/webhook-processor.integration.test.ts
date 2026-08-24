// =============================================================
// enqueueOutgoingWebhook — SUBSCRIPTION outbox bridge (Task 6, real Postgres)
// =============================================================
//
// webhook-processor.test.ts is a fully mocked unit test (drizzle.db is
// stubbed, every repo is a vi.fn) — it cannot assert a real
// outbox_events row exists. This file is the real-Postgres counterpart,
// following the inline-seed convention from
// scheduled-actions.integration.test.ts: no withTestDb/seedProject
// helpers exist in this codebase, so rows are inserted directly via
// getDb() and keyed by a unique RUN_ID.
//
// __test_enqueueOutgoingWebhook is exercised directly (not the full
// BullMQ job) — same approach the existing mocked unit test uses.

import { afterAll, describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { getDb, outboxEvents, projects, subscribers } from "@rovenue/db";
import {
  __test_enqueueOutgoingWebhook as enqueueOutgoingWebhook,
  __test_runPostProcessing as runPostProcessing,
} from "./webhook-processor";

const RUN_ID = Date.now();

async function seedProject(suffix: string, webhookUrl: string | null) {
  const db = getDb();
  const id = `prj_whp_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `Webhook Processor Test Project ${RUN_ID}${suffix}`,
    webhookUrl,
  });
  return { id };
}

async function seedSubscriber(projectId: string, suffix: string) {
  const db = getDb();
  const id = `sub_whp_${RUN_ID}${suffix}`;
  await db.insert(subscribers).values({
    id,
    projectId,
    rovenueId: `app_user_whp_${RUN_ID}${suffix}`,
    appUserId: `app_user_whp_${RUN_ID}${suffix}`,
  });
  return { id };
}

afterAll(async () => {
  const db = getDb();
  for (const suffix of ["W1", "W2", "W3", "W4"]) {
    const projectId = `prj_whp_${RUN_ID}${suffix}`;
    await db.delete(outboxEvents).where(
      inArray(
        outboxEvents.aggregateId,
        db
          .select({ id: subscribers.id })
          .from(subscribers)
          .where(eq(subscribers.projectId, projectId)),
      ),
    );
    await db.delete(projects).where(eq(projects.id, projectId));
  }
});

describe("enqueueOutgoingWebhook — SUBSCRIPTION outbox bridge", () => {
  it("Case 1: bridges the raw store eventType onto SUBSCRIPTION even when no v1 webhookUrl is configured", async () => {
    const db = getDb();
    const project = await seedProject("W1", null);
    const subscriber = await seedSubscriber(project.id, "W1");

    await enqueueOutgoingWebhook({
      projectId: project.id,
      subscriberId: subscriber.id,
      webhookEventId: "whe_int_w1",
      eventType: "DID_RENEW",
    });

    const outboxRows = await db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.aggregateId, subscriber.id),
          eq(outboxEvents.eventType, "DID_RENEW"),
        ),
      );
    expect(outboxRows.length).toBe(1);
    const row = outboxRows[0]!;
    expect(row.aggregateType).toBe("SUBSCRIPTION");
    const payload = row.payload as Record<string, unknown>;
    expect(payload.projectId).toBe(project.id);
    expect(payload.subscriberId).toBe(subscriber.id);
    expect(payload.webhookEventId).toBe("whe_int_w1");
  });

  it("Case 2: bridges onto SUBSCRIPTION even when the v1 category filter would drop the event", async () => {
    const db = getDb();
    const project = await seedProject("W2", "https://hook.example.com/w2");
    // Category filter subscribes to "purchase" only; DID_RENEW normalizes
    // to "renewal", so the v1 write is dropped but the outbox must not be.
    await db
      .update(projects)
      .set({ webhookEventCategories: ["purchase"] })
      .where(eq(projects.id, project.id));
    const subscriber = await seedSubscriber(project.id, "W2");

    await enqueueOutgoingWebhook({
      projectId: project.id,
      subscriberId: subscriber.id,
      purchaseId: "pur_whp_w2",
      webhookEventId: "whe_int_w2",
      eventType: "DID_RENEW",
    });

    const outboxRows = await db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.aggregateId, subscriber.id),
          eq(outboxEvents.eventType, "DID_RENEW"),
        ),
      );
    expect(outboxRows.length).toBe(1);
    expect(outboxRows[0]!.aggregateType).toBe("SUBSCRIPTION");
    expect((outboxRows[0]!.payload as Record<string, unknown>).purchaseId).toBe(
      "pur_whp_w2",
    );
  });

  // -------------------------------------------------------------------
  // Fix-loop finding 1: the outbox bridge must be idempotent on a BullMQ
  // retry (runPostProcessing re-runs the WHOLE post-processing block on
  // any side-effect failure) — a retry must not insert a second
  // outbox_events row for the same store event.
  // -------------------------------------------------------------------

  it("Case 3: running post-processing twice for the same purchase-less store event bridges exactly one SUBSCRIPTION outbox row", async () => {
    const db = getDb();
    const project = await seedProject("W3", null);
    const subscriber = await seedSubscriber(project.id, "W3");

    const args = {
      projectId: project.id,
      subscriberId: subscriber.id,
      eventType: "DID_RENEW",
      webhookEventId: "whe_int_w3_retry",
    };

    // Simulates a BullMQ retry: the whole post-processing block re-runs
    // for the same inbound webhook event.
    await runPostProcessing(args);
    await runPostProcessing(args);

    const outboxRows = await db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.aggregateId, subscriber.id),
          eq(outboxEvents.eventType, "DID_RENEW"),
        ),
      );
    expect(outboxRows.length).toBe(1);
    expect(outboxRows[0]!.aggregateType).toBe("SUBSCRIPTION");
  });

  it("Case 4: running post-processing twice for the same purchase-keyed store event bridges exactly one SUBSCRIPTION outbox row", async () => {
    const db = getDb();
    const project = await seedProject("W4", null);
    const subscriber = await seedSubscriber(project.id, "W4");

    const args = {
      projectId: project.id,
      subscriberId: subscriber.id,
      // Purchase does not need to exist for this path — maybeCredit-
      // ConsumablePurchase looks it up and no-ops when not found, and
      // the outbox dedupe below keys on (aggregateType, subscriber,
      // eventType, purchaseId), not on the purchase row itself.
      purchaseId: "pur_whp_w4_retry",
      eventType: "DID_RENEW",
      webhookEventId: "whe_int_w4_retry",
    };

    await runPostProcessing(args);
    await runPostProcessing(args);

    const outboxRows = await db
      .select()
      .from(outboxEvents)
      .where(
        and(
          eq(outboxEvents.aggregateId, subscriber.id),
          eq(outboxEvents.eventType, "DID_RENEW"),
        ),
      );
    expect(outboxRows.length).toBe(1);
    expect(outboxRows[0]!.aggregateType).toBe("SUBSCRIPTION");
    expect((outboxRows[0]!.payload as Record<string, unknown>).purchaseId).toBe(
      "pur_whp_w4_retry",
    );
  });
});
