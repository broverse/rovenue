import { desc, eq } from "drizzle-orm";
import type { Db } from "../client";
import { creditLedger } from "../schema";

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
