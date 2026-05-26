// =============================================================
// billing.refund.detected emitter
// =============================================================
//
// Shared helper for the three webhook handlers (apple, google,
// stripe) that all need to emit `billing.refund.detected` after
// their per-store refund branch creates a REFUND-typed
// revenue_events row.
//
// Gating: only emits when the refund value crosses the high-value
// threshold (default $50 USD). Smaller refunds are noise — the
// catalog's `reason` field is fixed to "high_value" for v1; the
// "burst" reason (many refunds in a window) is a follow-up that
// needs ClickHouse aggregation.
//
// The emit lives in its own transaction so a downstream
// notification failure can't roll back the revenue event
// insert that the webhook already committed.

import { eq } from "drizzle-orm";
import { drizzle, type Db } from "@rovenue/db";
import { logger } from "../../lib/logger";
import { captureNotifierError } from "../../lib/sentry-notifications";
import { emitNotification } from "./emit";

const log = logger.child("notifier.refund-emit");

/** USD threshold above which a refund triggers a notification. */
export const HIGH_VALUE_USD_CENTS = 5000; // $50.00

export interface RefundEmitInput {
  projectId: string;
  /** Same id used as the revenue_events.purchaseId — drives the eventId for dedup. */
  purchaseId: string;
  productId?: string;
  /** Absolute amount (positive number). */
  amountUsdCents: number;
  /** Refund currency (3-letter ISO code). */
  currency: string;
}

/**
 * Fire-and-forget refund notification. Always safe to call —
 * swallows + logs/sentry-reports any failure so the caller's
 * webhook handler stays linear.
 */
export async function maybeEmitRefundDetected(
  db: Db,
  input: RefundEmitInput,
): Promise<void> {
  if (input.amountUsdCents < HIGH_VALUE_USD_CENTS) return;
  try {
    const [proj] = await db
      .select({ name: drizzle.schema.projects.name })
      .from(drizzle.schema.projects)
      .where(eq(drizzle.schema.projects.id, input.projectId))
      .limit(1);
    const projectName = proj?.name ?? input.projectId;

    await db.transaction(async (tx) => {
      await emitNotification(tx, {
        eventKey: "billing.refund.detected",
        // Deterministic — the same purchaseId getting refunded
        // twice (e.g. webhook replay) dedups at the notifier
        // worker layer.
        eventId: `refund.detected:${input.purchaseId}`,
        projectId: input.projectId,
        context: {
          projectId: input.projectId,
          projectName,
          amount: {
            amount: input.amountUsdCents,
            currency: input.currency,
          },
          reason: "high_value",
          ...(input.productId ? { productId: input.productId } : {}),
        },
      });
    });
  } catch (err) {
    log.warn("emit_skipped", {
      projectId: input.projectId,
      err: err instanceof Error ? err.message : String(err),
    });
    captureNotifierError(err, {
      component: "notifier",
      eventKey: "billing.refund.detected",
      projectId: input.projectId,
      reason: "emit_failed",
    });
  }
}
