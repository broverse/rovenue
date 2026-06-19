import { and, eq } from "drizzle-orm";
import {
  CreditLedgerType,
  drizzle,
  type CreditLedger,
} from "@rovenue/db";
import { logger } from "../lib/logger";

const log = logger.child("credit-engine");

export class InsufficientCreditsError extends Error {
  constructor(
    readonly balance: number,
    readonly requested: number,
  ) {
    super(`Insufficient credits: balance ${balance}, requested ${requested}`);
    this.name = "InsufficientCreditsError";
  }
}

/**
 * Return the subscriber's current credit balance for a specific currency —
 * the `balance` field of the most recent CreditLedger entry for that
 * (subscriber, currency) pair. Append-only; no aggregation.
 */
export async function getBalance(
  subscriberId: string,
  currencyId: string,
): Promise<number> {
  const last = await drizzle.creditLedgerRepo.findLatestBalance(
    drizzle.db,
    subscriberId,
    currencyId,
  );
  return last?.balance ?? 0;
}

export async function getAllBalances(
  subscriberId: string,
): Promise<Array<{ currencyId: string; balance: number }>> {
  return drizzle.creditLedgerRepo.findAllBalances(drizzle.db, subscriberId);
}

export interface AddCreditsArgs {
  subscriberId: string;
  currencyId: string;
  amount: number;
  type?: CreditLedgerType;
  referenceType?: string;
  referenceId?: string;
  description?: string;
  metadata?: unknown;
  /**
   * When true and referenceId is set, re-check inside the advisory
   * lock whether a ledger row already exists for this purchase
   * reference; if so, return the existing row instead of inserting
   * a duplicate. The lock serialises concurrent grants per
   * subscriber, making check-then-insert atomic — credit_ledger is
   * range-partitioned so a unique index cannot enforce this.
   */
  dedupeOnReference?: boolean;
}

/**
 * Append a PURCHASE / BONUS / REFUND ledger entry. A per-subscriber
 * per-currency Postgres advisory lock serialises concurrent writers on the
 * same (subscriber, currency) without the cost of Serializable isolation.
 */
export async function addCredits(args: AddCreditsArgs): Promise<CreditLedger> {
  if (!Number.isInteger(args.amount) || args.amount <= 0) {
    throw new Error("addCredits: amount must be a positive integer");
  }
  const type = args.type ?? CreditLedgerType.PURCHASE;

  return drizzle.db.transaction(async (tx) => {
    await drizzle.lockRepo.advisoryXactLock(
      tx,
      `${args.subscriberId}:${args.currencyId}`,
    );

    const subscriber = await drizzle.subscriberRepo.findSubscriberProjectId(
      tx,
      args.subscriberId,
    );
    if (!subscriber) {
      throw new Error(`Subscriber ${args.subscriberId} not found`);
    }

    if (args.dedupeOnReference && args.referenceId) {
      const existing = await drizzle.creditLedgerRepo.findExistingPurchaseCredit(
        tx,
        args.subscriberId,
        args.referenceId,
        args.currencyId,
      );
      if (existing) {
        log.debug("credit already granted for reference, skipping", {
          subscriberId: args.subscriberId,
          currencyId: args.currencyId,
          referenceId: args.referenceId,
        });
        const rows = await tx
          .select()
          .from(drizzle.schema.creditLedger)
          .where(
            and(
              eq(drizzle.schema.creditLedger.subscriberId, args.subscriberId),
              eq(drizzle.schema.creditLedger.referenceType, "purchase"),
              eq(drizzle.schema.creditLedger.referenceId, args.referenceId),
              eq(drizzle.schema.creditLedger.currencyId, args.currencyId),
            ),
          )
          .limit(1);
        return rows[0] as CreditLedger;
      }
    }

    const last = await drizzle.creditLedgerRepo.findLatestBalance(
      tx,
      args.subscriberId,
      args.currencyId,
    );
    const balance = (last?.balance ?? 0) + args.amount;

    log.debug("adding credits", {
      subscriberId: args.subscriberId,
      currencyId: args.currencyId,
      amount: args.amount,
      newBalance: balance,
    });

    const row = await drizzle.creditLedgerRepo.insertCreditLedger(tx, {
      projectId: subscriber.projectId,
      subscriberId: args.subscriberId,
      currencyId: args.currencyId,
      type,
      amount: args.amount,
      balance,
      referenceType: args.referenceType,
      referenceId: args.referenceId,
      description: args.description,
      metadata: args.metadata,
    });
    return row as CreditLedger;
  });
}

export interface SpendCreditsArgs {
  subscriberId: string;
  currencyId: string;
  amount: number;
  referenceType?: string;
  referenceId?: string;
  description?: string;
  metadata?: unknown;
  /**
   * When set with a `referenceId`, a retried spend with the same reference is
   * a no-op (returns the original SPEND row) instead of double-debiting the
   * wallet. Mirrors `addCredits`'s grant dedup so spends are equally
   * idempotent under client/network retries.
   */
  dedupeOnReference?: boolean;
}

/**
 * Append a SPEND ledger entry; throws {@link InsufficientCreditsError}
 * when the balance is below `amount`. Per-subscriber per-currency advisory
 * lock keeps concurrent spends from overdrafting.
 */
export async function spendCredits(
  args: SpendCreditsArgs,
): Promise<CreditLedger> {
  if (!Number.isInteger(args.amount) || args.amount <= 0) {
    throw new Error("spendCredits: amount must be a positive integer");
  }

  return drizzle.db.transaction(async (tx) => {
    await drizzle.lockRepo.advisoryXactLock(
      tx,
      `${args.subscriberId}:${args.currencyId}`,
    );

    const subscriber = await drizzle.subscriberRepo.findSubscriberProjectId(
      tx,
      args.subscriberId,
    );
    if (!subscriber) {
      throw new Error(`Subscriber ${args.subscriberId} not found`);
    }

    // Idempotency: a retried spend with the same reference returns the
    // original SPEND row instead of debiting twice. Runs inside the per-wallet
    // advisory lock, so concurrent retries serialize and the second sees the
    // first's row.
    if (args.dedupeOnReference && args.referenceId) {
      const existing = await tx
        .select()
        .from(drizzle.schema.creditLedger)
        .where(
          and(
            eq(drizzle.schema.creditLedger.subscriberId, args.subscriberId),
            eq(drizzle.schema.creditLedger.currencyId, args.currencyId),
            eq(drizzle.schema.creditLedger.type, CreditLedgerType.SPEND),
            eq(drizzle.schema.creditLedger.referenceId, args.referenceId),
          ),
        )
        .limit(1);
      if (existing[0]) {
        log.debug("spend already recorded for reference, skipping", {
          subscriberId: args.subscriberId,
          currencyId: args.currencyId,
          referenceId: args.referenceId,
        });
        return existing[0] as CreditLedger;
      }
    }

    const last = await drizzle.creditLedgerRepo.findLatestBalance(
      tx,
      args.subscriberId,
      args.currencyId,
    );
    const prevBalance = last?.balance ?? 0;

    if (prevBalance < args.amount) {
      throw new InsufficientCreditsError(prevBalance, args.amount);
    }

    const balance = prevBalance - args.amount;

    log.debug("spending credits", {
      subscriberId: args.subscriberId,
      currencyId: args.currencyId,
      amount: args.amount,
      newBalance: balance,
    });

    const row = await drizzle.creditLedgerRepo.insertCreditLedger(tx, {
      projectId: subscriber.projectId,
      subscriberId: args.subscriberId,
      currencyId: args.currencyId,
      type: CreditLedgerType.SPEND,
      amount: -args.amount,
      balance,
      referenceType: args.referenceType,
      referenceId: args.referenceId,
      description: args.description,
      metadata: args.metadata,
    });
    return row as unknown as CreditLedger;
  });
}

export interface RefundCreditsArgs {
  subscriberId: string;
  currencyId: string;
  amount: number;
  referenceId: string;
  referenceType?: string;
  description?: string;
  metadata?: unknown;
}

export async function refundCredits(
  args: RefundCreditsArgs,
): Promise<CreditLedger> {
  return addCredits({
    subscriberId: args.subscriberId,
    currencyId: args.currencyId,
    amount: args.amount,
    type: CreditLedgerType.REFUND,
    referenceType: args.referenceType ?? "refund",
    referenceId: args.referenceId,
    description: args.description,
    metadata: args.metadata,
  });
}
