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
 * can never be anything but "pending". A caller that means to write some
 * other status gets a compile error here rather than a silent override.
 */
export async function upsertPending(
  db: Db,
  row: Omit<NewFunnelPurchase, "status">,
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
