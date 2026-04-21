import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../client";
import { creditLedger } from "../schema";

/**
 * Dedup guard used by receipt verification: has this purchase
 * already produced a ledger entry? Exact replica of
 *   prisma.creditLedger.findFirst({
 *     where: { subscriberId, referenceType: "purchase", referenceId: purchaseId },
 *   })
 */
export async function findExistingPurchaseCredit(
  db: Db,
  subscriberId: string,
  purchaseId: string,
): Promise<{ id: string } | null> {
  const rows = await db
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(
      and(
        eq(creditLedger.subscriberId, subscriberId),
        eq(creditLedger.referenceType, "purchase"),
        eq(creditLedger.referenceId, purchaseId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// =============================================================
// Credit ledger reads — Drizzle repository
// =============================================================
//
// The ledger is append-only (DB triggers block UPDATE), and
// every write carries the running balance forward. That means
// "current balance" is always the balance column of the most
// recent row for the subscriber — a single index-driven lookup.

export async function findLatestBalance(
  db: Db,
  subscriberId: string,
): Promise<{ balance: number } | null> {
  const rows = await db
    .select({ balance: creditLedger.balance })
    .from(creditLedger)
    .where(eq(creditLedger.subscriberId, subscriberId))
    .orderBy(desc(creditLedger.createdAt))
    .limit(1);
  return rows[0] ?? null;
}
