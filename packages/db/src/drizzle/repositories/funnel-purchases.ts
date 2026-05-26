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
