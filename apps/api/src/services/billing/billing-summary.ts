import { drizzle, type Db } from "@rovenue/db";
import type {
  BillingSummary,
  PaymentMethodSummary,
} from "@rovenue/shared";

// =============================================================
// buildBillingSummary
// =============================================================
// Read-only assembly: stitch the project's active billing_subscriptions
// row together with its default billing_payment_methods row (if any)
// into the `BillingSummary` shape consumed by the dashboard
// (GET /dashboard/projects/:projectId/billing — Task 19).
//
// Phase-1 backfill guarantees every project has exactly one active
// row in billing_subscriptions, so a missing row is a programmer error
// and we throw rather than papering over it with a synthetic default.

export async function buildBillingSummary(
  db: Db,
  projectId: string,
): Promise<BillingSummary> {
  const [subscription, defaultPm, project] = await Promise.all([
    drizzle.billingSubscriptionRepo.findBillingSubscriptionByProject(
      db,
      projectId,
    ),
    drizzle.billingPaymentMethodRepo.findDefaultPaymentMethod(db, projectId),
    drizzle.projectRepo.findProjectById(db, projectId),
  ]);

  if (!subscription) {
    throw new Error(
      `billing_subscriptions row missing for project ${projectId}`,
    );
  }

  const defaultPaymentMethod: PaymentMethodSummary | null = defaultPm
    ? {
        id: defaultPm.id,
        brand: defaultPm.brand,
        last4: defaultPm.last4,
        expMonth: defaultPm.expMonth,
        expYear: defaultPm.expYear,
        isDefault: defaultPm.isDefault,
        createdAt: defaultPm.createdAt.toISOString(),
      }
    : null;

  return {
    state: subscription.state,
    tier: subscription.tier,
    cycle: subscription.cycle,
    currentPeriodStart:
      subscription.currentPeriodStart?.toISOString() ?? null,
    currentPeriodEnd: subscription.currentPeriodEnd?.toISOString() ?? null,
    defaultPaymentMethod,
    hasStripeCustomer: subscription.stripeCustomerId !== null,
    usageLockedAt: project?.usageLockedAt?.toISOString() ?? null,
  };
}
