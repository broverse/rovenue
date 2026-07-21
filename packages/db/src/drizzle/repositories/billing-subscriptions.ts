import { and, eq, ne, sql } from "drizzle-orm";
import type { Db } from "../client";
import type { BillingCycle, BillingTier } from "../enums";
import {
  billingSubscriptions,
  type BillingSubscription,
} from "../schema";

// =============================================================
// billing_subscriptions repository (Phase 1 + 2)
// =============================================================
// One row per project. The partial unique index
// `billing_subscriptions_project_active_uq` permits multiple rows only
// when older ones are state='deleted'; Phase 1 never deletes, so a
// duplicate insert is always a bug.

export async function createFreeBillingSubscription(
  db: Db,
  projectId: string,
): Promise<BillingSubscription> {
  const rows = await db
    .insert(billingSubscriptions)
    .values({
      projectId,
      state: "free",
      tier: "free",
      cycle: "monthly",
    })
    .returning();
  return rows[0]!;
}

export async function listProjectIdsWithBillingSubscription(
  db: Db,
): Promise<string[]> {
  const rows = await db
    .select({ projectId: billingSubscriptions.projectId })
    .from(billingSubscriptions);
  return rows.map((r) => r.projectId);
}

export async function findBillingSubscriptionByProject(
  db: Db,
  projectId: string,
): Promise<BillingSubscription | null> {
  const rows = await db
    .select()
    .from(billingSubscriptions)
    .where(
      and(
        eq(billingSubscriptions.projectId, projectId),
        ne(billingSubscriptions.state, "deleted"),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// =============================================================
// Phase 2: Stripe-side lookups + post-webhook mutators
// =============================================================

/**
 * Mutate `stripe_customer_id` on the project's active row
 * (state != 'deleted') and bump `updated_at`.
 */
export async function setStripeCustomerId(
  db: Db,
  projectId: string,
  stripeCustomerId: string,
): Promise<void> {
  await db
    .update(billingSubscriptions)
    .set({
      stripeCustomerId,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(billingSubscriptions.projectId, projectId),
        ne(billingSubscriptions.state, "deleted"),
      ),
    );
}

export async function findByStripeCustomerId(
  db: Db,
  stripeCustomerId: string,
): Promise<BillingSubscription | null> {
  const rows = await db
    .select()
    .from(billingSubscriptions)
    .where(
      and(
        eq(billingSubscriptions.stripeCustomerId, stripeCustomerId),
        ne(billingSubscriptions.state, "deleted"),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function findBySubscriptionId(
  db: Db,
  stripeSubscriptionId: string,
): Promise<BillingSubscription | null> {
  const rows = await db
    .select()
    .from(billingSubscriptions)
    .where(
      and(
        eq(billingSubscriptions.stripeSubscriptionId, stripeSubscriptionId),
        ne(billingSubscriptions.state, "deleted"),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export interface UpdateAfterStripeCreatedInput {
  stripeSubscriptionId: string;
  tier: Exclude<BillingTier, "free">;
  cycle: BillingCycle;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
}

/**
 * Flip a project's active billing row to `state='active'` and write
 * the Stripe subscription id + period boundaries. Called from the
 * `customer.subscription.created` webhook handler.
 */
export async function updateAfterStripeCreated(
  db: Db,
  projectId: string,
  input: UpdateAfterStripeCreatedInput,
): Promise<void> {
  await db
    .update(billingSubscriptions)
    .set({
      state: "active",
      stripeSubscriptionId: input.stripeSubscriptionId,
      tier: input.tier,
      cycle: input.cycle,
      currentPeriodStart: input.currentPeriodStart,
      currentPeriodEnd: input.currentPeriodEnd,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(billingSubscriptions.projectId, projectId),
        ne(billingSubscriptions.state, "deleted"),
      ),
    );
}

export interface UpdateAfterStripeUpdatedInput {
  tier: Exclude<BillingTier, "free">;
  cycle: BillingCycle;
  currentPeriodStart: Date;
  currentPeriodEnd: Date;
}

/**
 * Patch period+tier+cycle on the row identified by Stripe subscription
 * id. Does NOT touch `state` — that's the dunning/lifecycle handlers'
 * job. Called from `customer.subscription.updated`.
 */
export async function updateAfterStripeUpdated(
  db: Db,
  stripeSubscriptionId: string,
  input: UpdateAfterStripeUpdatedInput,
): Promise<void> {
  await db
    .update(billingSubscriptions)
    .set({
      tier: input.tier,
      cycle: input.cycle,
      currentPeriodStart: input.currentPeriodStart,
      currentPeriodEnd: input.currentPeriodEnd,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(billingSubscriptions.stripeSubscriptionId, stripeSubscriptionId),
        ne(billingSubscriptions.state, "deleted"),
      ),
    );
}

/**
 * Downgrade a project back to the free plan when its Stripe subscription is
 * deleted (canceled / ended). Without this, a project whose paid plan lapsed
 * would keep its elevated tier + capabilities indefinitely. Returns the
 * project to the same shape as `createFreeBillingSubscription`.
 */
export async function downgradeToFreeOnDeleted(
  db: Db,
  stripeSubscriptionId: string,
): Promise<void> {
  await db
    .update(billingSubscriptions)
    .set({
      state: "free",
      tier: "free",
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(billingSubscriptions.stripeSubscriptionId, stripeSubscriptionId),
        ne(billingSubscriptions.state, "deleted"),
      ),
    );
}
