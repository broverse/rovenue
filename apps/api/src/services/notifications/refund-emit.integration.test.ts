// =============================================================
// maybeEmitRefundDetected — integration tests
// =============================================================
//
// Lightweight: just exercises the helper directly. The per-store
// webhook wiring is covered by the existing apple/google/stripe
// webhook test suites — they'd assert the outbox row landed via
// the same provided projectId.

import { afterAll, describe, expect, it } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import { drizzle, getDb, projects } from "@rovenue/db";
import {
  HIGH_VALUE_USD_CENTS,
  maybeEmitRefundDetected,
} from "./refund-emit";

const RUN_ID = Date.now();
const db = getDb();

const seededProjectIds: string[] = [];
async function seedProject(suffix: string): Promise<string> {
  const id = `prj_refund_emit_${RUN_ID}_${suffix}`;
  await db.insert(projects).values({ id, name: `Refund Test ${suffix}` });
  seededProjectIds.push(id);
  return id;
}

afterAll(async () => {
  for (const id of seededProjectIds) {
    await db.delete(projects).where(eq(projects.id, id));
  }
});

describe.sequential("maybeEmitRefundDetected", () => {
  it("emits a billing.refund.detected outbox row above the threshold", async () => {
    const projectId = await seedProject("high");
    const purchaseId = createId();

    await maybeEmitRefundDetected(db, {
      projectId,
      purchaseId,
      productId: "prod-1",
      amountUsdCents: HIGH_VALUE_USD_CENTS, // exactly at the bar
      currency: "USD",
    });

    const rows = await db
      .select()
      .from(drizzle.schema.outboxEvents)
      .where(
        eq(drizzle.schema.outboxEvents.eventType, "billing.refund.detected"),
      );
    const match = rows.find((r) => {
      const p = r.payload as { projectId?: string; eventId?: string };
      return (
        p.projectId === projectId &&
        p.eventId === `refund.detected:${purchaseId}`
      );
    });
    expect(match).toBeDefined();
    const payload = match!.payload as {
      context: {
        projectName: string;
        amount: { amount: number; currency: string };
        reason: string;
        productId?: string;
      };
    };
    expect(payload.context.amount.amount).toBe(HIGH_VALUE_USD_CENTS);
    expect(payload.context.amount.currency).toBe("USD");
    expect(payload.context.reason).toBe("high_value");
    expect(payload.context.productId).toBe("prod-1");
    expect(payload.context.projectName).toContain("Refund Test");
  });

  it("does not emit below the threshold", async () => {
    const projectId = await seedProject("low");
    const purchaseId = createId();

    await maybeEmitRefundDetected(db, {
      projectId,
      purchaseId,
      amountUsdCents: HIGH_VALUE_USD_CENTS - 1,
      currency: "USD",
    });

    const rows = await db
      .select()
      .from(drizzle.schema.outboxEvents)
      .where(
        eq(drizzle.schema.outboxEvents.eventType, "billing.refund.detected"),
      );
    const match = rows.find((r) => {
      const p = r.payload as { projectId?: string };
      return p.projectId === projectId;
    });
    expect(match).toBeUndefined();
  });

  it("dedups by purchaseId on replay (same eventId)", async () => {
    const projectId = await seedProject("replay");
    const purchaseId = createId();
    const input = {
      projectId,
      purchaseId,
      amountUsdCents: 25000,
      currency: "USD",
    };

    await maybeEmitRefundDetected(db, input);
    await maybeEmitRefundDetected(db, input);

    const rows = await db
      .select()
      .from(drizzle.schema.outboxEvents)
      .where(
        eq(drizzle.schema.outboxEvents.eventType, "billing.refund.detected"),
      );
    const matches = rows.filter((r) => {
      const p = r.payload as { projectId?: string };
      return p.projectId === projectId;
    });
    // Outbox itself doesn't dedup — that's the notifier worker's
    // job — so two rows is expected, both carrying the same eventId.
    expect(matches.length).toBeGreaterThanOrEqual(2);
    const eventIds = new Set(
      matches.map((r) => (r.payload as { eventId: string }).eventId),
    );
    expect(eventIds.size).toBe(1);
  });
});
