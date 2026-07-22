import { eq } from "drizzle-orm";
import type { Db } from "../client";
import { funnelPurchases, type FunnelPurchase, type NewFunnelPurchase } from "../schema";

export async function insert(
  db: Db,
  row: NewFunnelPurchase,
): Promise<FunnelPurchase> {
  const [inserted] = await db.insert(funnelPurchases).values(row).returning();
  return inserted;
}

export async function findBySession(
  db: Db,
  sessionId: string,
): Promise<FunnelPurchase | null> {
  const rows = await db
    .select()
    .from(funnelPurchases)
    .where(eq(funnelPurchases.sessionId, sessionId))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * The funnel purchase that recorded this Stripe subscription, if any.
 *
 * The Connect webhook's backstop needs a session id from an
 * `invoice.paid`, and Stripe copies subscription metadata onto neither
 * the invoice nor its PaymentIntent — so the id has to come from
 * somewhere else. This row IS that mapping: the payment-intent endpoint
 * wrote the subscription id here at creation time, and
 * `funnel_purchases_stripe_sub_idx` covers the lookup. Asking Stripe
 * instead would mean an extra API round-trip on EVERY paid invoice in
 * every project, funnel or not, just to discover that almost all of them
 * carry no funnel metadata.
 *
 * Not unique at the database level (`session_id` is), but at most one row
 * can hold a given subscription id in practice: `upsertPending` conflicts
 * on `session_id`, so a visitor who changes package overwrites the id on
 * the same row rather than leaving a second one behind.
 */
export async function findByStripeSubscriptionId(
  db: Db,
  stripeSubscriptionId: string,
): Promise<FunnelPurchase | null> {
  const rows = await db
    .select()
    .from(funnelPurchases)
    .where(eq(funnelPurchases.stripeSubscriptionId, stripeSubscriptionId))
    .limit(1);
  return rows[0] ?? null;
}

export async function markPaid(
  db: Db,
  id: string,
  patch: Partial<NewFunnelPurchase>,
): Promise<void> {
  await db
    .update(funnelPurchases)
    .set({ status: "paid", paidAt: new Date(), ...patch })
    .where(eq(funnelPurchases.id, id));
}

/**
 * Insert-or-update the pending purchase row for a session. `sessionId`
 * is unique per session, so a visitor who changes package before paying
 * must update the existing row rather than 500 on the unique violation.
 *
 * `status` is deliberately absent from `row` — this is the one path that
 * creates a purchase row before payment succeeds, so the status it writes
 * can never be anything but "pending". The `status?: never` intersection
 * is what makes that a compile error rather than a silent override:
 * `Omit<..., "status">` alone only rejects an object *literal* carrying a
 * status (excess-property checking), while a variable already typed
 * `NewFunnelPurchase` stays structurally assignable to it and would have
 * its status quietly dropped here.
 */
export async function upsertPending(
  db: Db,
  row: Omit<NewFunnelPurchase, "status"> & { status?: never },
): Promise<FunnelPurchase> {
  const [saved] = await db
    .insert(funnelPurchases)
    .values({ ...row, status: "pending" })
    .onConflictDoUpdate({
      target: funnelPurchases.sessionId,
      set: { ...row, status: "pending" },
    })
    .returning();
  return saved;
}
