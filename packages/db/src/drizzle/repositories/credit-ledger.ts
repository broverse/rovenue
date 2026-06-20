import { and, desc, eq } from "drizzle-orm";
import type { Db } from "../client";
import { creditLedger, type CreditLedgerRow } from "../schema";
import { creditLedgerType } from "../enums";
import * as outboxRepo from "./outbox";

// Accepts both top-level db and tx handles for transactional writes.
type DbOrTx = Db;

/** Public value type for the pgEnum. */
export type CreditLedgerType = (typeof creditLedgerType.enumValues)[number];

/**
 * Dedup guard used by receipt verification: has this purchase
 * already produced a ledger entry? Accepts a tx handle so the
 * check can run inside the per-subscriber advisory lock.
 */
export async function findExistingPurchaseCredit(
  db: DbOrTx,
  subscriberId: string,
  purchaseId: string,
  currencyId: string,
): Promise<{ id: string } | null> {
  const rows = await db
    .select({ id: creditLedger.id })
    .from(creditLedger)
    .where(
      and(
        eq(creditLedger.subscriberId, subscriberId),
        eq(creditLedger.referenceType, "purchase"),
        eq(creditLedger.referenceId, purchaseId),
        eq(creditLedger.currencyId, currencyId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// =============================================================
// Credit ledger reads — Drizzle repository
// =============================================================
//
// The ledger is append-only by convention (repo never issues UPDATE), and
// every write carries the running balance forward. That means
// "current balance" is always the balance column of the most
// recent row for the subscriber — a single index-driven lookup.

export async function findLatestBalance(
  db: Db,
  subscriberId: string,
  currencyId: string,
): Promise<{ balance: number } | null> {
  const rows = await db
    .select({ balance: creditLedger.balance })
    .from(creditLedger)
    .where(
      and(
        eq(creditLedger.subscriberId, subscriberId),
        eq(creditLedger.currencyId, currencyId),
      ),
    )
    // desc(id) tie-breaks rows sharing an identical createdAt (sub-millisecond
    // inserts) so "latest balance" is deterministic — otherwise the running
    // balance can be read off the wrong prior row.
    .orderBy(desc(creditLedger.createdAt), desc(creditLedger.id))
    .limit(1);
  return rows[0] ?? null;
}

export async function findAllBalances(
  db: Db,
  subscriberId: string,
): Promise<Array<{ currencyId: string; balance: number }>> {
  return db
    .selectDistinctOn([creditLedger.currencyId], {
      currencyId: creditLedger.currencyId,
      balance: creditLedger.balance,
    })
    .from(creditLedger)
    .where(eq(creditLedger.subscriberId, subscriberId))
    // desc(id) tie-break keeps the DISTINCT ON pick deterministic when two
    // rows for a currency share a createdAt.
    .orderBy(
      creditLedger.currencyId,
      desc(creditLedger.createdAt),
      desc(creditLedger.id),
    );
}

// =============================================================
// Writes (append-only by convention — this module owns the only
// write path and never issues UPDATE/DELETE)
// =============================================================

export interface CreditLedgerEntry {
  projectId: string;
  subscriberId: string;
  currencyId: string;
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
 *
 * Co-writes a CREDIT_LEDGER outbox row on the SAME handle so both
 * inserts commit or roll back atomically with the caller's transaction.
 * Callers MUST already be inside a transaction (the credit engine opens
 * one and holds the per-wallet advisory lock for the whole unit of work).
 * There is no nested savepoint — the ledger row and outbox event share
 * the caller's tx context directly.
 */
export async function insertCreditLedger(
  db: DbOrTx,
  entry: CreditLedgerEntry,
): Promise<CreditLedgerRow> {
  const rows = await db
    .insert(creditLedger)
    .values({
      projectId: entry.projectId,
      subscriberId: entry.subscriberId,
      currencyId: entry.currencyId,
      type: entry.type,
      amount: entry.amount,
      balance: entry.balance,
      referenceType: entry.referenceType ?? null,
      referenceId: entry.referenceId ?? null,
      description: entry.description ?? null,
      metadata: (entry.metadata ?? null) as typeof creditLedger.$inferInsert.metadata,
    })
    .returning();
  const inserted = rows[0];
  if (!inserted) throw new Error("insertCreditLedger: no row returned");

  await outboxRepo.insert(db, {
    aggregateType: "CREDIT_LEDGER",
    aggregateId: inserted.id,
    eventType: "credit.ledger.appended",
    payload: {
      creditLedgerId: inserted.id,
      projectId: inserted.projectId,
      subscriberId: inserted.subscriberId,
      currencyId: inserted.currencyId,
      type: inserted.type,
      amount: inserted.amount,
      balance: inserted.balance,
      referenceType: inserted.referenceType,
      referenceId: inserted.referenceId,
      createdAt: inserted.createdAt.toISOString(),
    },
  });

  return inserted;
}
