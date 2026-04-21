import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../client";
import { creditLedger } from "../schema";
import { creditLedgerType } from "../enums";

// Accepts both top-level db and tx handles for transactional writes.
type DbOrTx = Db;

/** Public value type for the pgEnum — matches Prisma's CreditLedgerType. */
export type CreditLedgerType = (typeof creditLedgerType.enumValues)[number];

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

// =============================================================
// Writes (append-only — DB trigger blocks UPDATE/DELETE)
// =============================================================

export interface CreditLedgerEntry {
  projectId: string;
  subscriberId: string;
  type: CreditLedgerType;
  amount: number;
  balance: number;
  referenceType?: string | null;
  referenceId?: string | null;
  description?: string | null;
  metadata?: unknown;
}

/**
 * Append a new credit_ledger row. Invariant: callers MUST pre-
 * compute the running balance (previous latest balance +/- amount).
 * The DB has no BEFORE INSERT trigger that normalises this — keeping
 * the balance consistent is the caller's contract.
 */
export async function insertCreditLedger(
  db: DbOrTx,
  entry: CreditLedgerEntry,
): Promise<void> {
  await db.insert(creditLedger).values({
    projectId: entry.projectId,
    subscriberId: entry.subscriberId,
    type: entry.type,
    amount: entry.amount,
    balance: entry.balance,
    referenceType: entry.referenceType ?? null,
    referenceId: entry.referenceId ?? null,
    description: entry.description ?? null,
    metadata: (entry.metadata ?? null) as typeof creditLedger.$inferInsert.metadata,
  });
}
