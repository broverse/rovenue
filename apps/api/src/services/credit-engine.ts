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
 * Return the subscriber's current credit balance — the `balance` field of
 * the most recent CreditLedger entry. Append-only; no aggregation.
 */
export async function getBalance(subscriberId: string): Promise<number> {
  const last = await drizzle.creditLedgerRepo.findLatestBalance(
    drizzle.db,
    subscriberId,
  );
  return last?.balance ?? 0;
}

export interface AddCreditsArgs {
  subscriberId: string;
  amount: number;
  type?: CreditLedgerType;
  referenceType?: string;
  referenceId?: string;
  description?: string;
  metadata?: unknown;
}

/**
 * Append a PURCHASE / BONUS / REFUND ledger entry. A per-subscriber
 * Postgres advisory lock serialises concurrent writers on the same
 * subscriber without the cost of Serializable isolation.
 */
export async function addCredits(args: AddCreditsArgs): Promise<CreditLedger> {
  if (!Number.isInteger(args.amount) || args.amount <= 0) {
    throw new Error("addCredits: amount must be a positive integer");
  }
  const type = args.type ?? CreditLedgerType.PURCHASE;

  return drizzle.db.transaction(async (tx) => {
    await drizzle.lockRepo.advisoryXactLock(tx, args.subscriberId);

    const subscriber = await drizzle.subscriberRepo.findSubscriberProjectId(
      tx,
      args.subscriberId,
    );
    if (!subscriber) {
      throw new Error(`Subscriber ${args.subscriberId} not found`);
    }

    const last = await drizzle.creditLedgerRepo.findLatestBalance(
      tx,
      args.subscriberId,
    );
    const balance = (last?.balance ?? 0) + args.amount;

    log.debug("adding credits", {
      subscriberId: args.subscriberId,
      amount: args.amount,
      newBalance: balance,
    });

    const row = await drizzle.creditLedgerRepo.insertCreditLedger(tx, {
      projectId: subscriber.projectId,
      subscriberId: args.subscriberId,
      type,
      amount: args.amount,
      balance,
      referenceType: args.referenceType,
      referenceId: args.referenceId,
      description: args.description,
      metadata: args.metadata,
    });
    // Drizzle's row shape (metadata: unknown) is structurally a
    // superset of Prisma's CreditLedger (metadata: JsonValue) for
    // the fields callers actually read. Cast at the service edge.
    return row as unknown as CreditLedger;
  });
}

export interface SpendCreditsArgs {
  subscriberId: string;
  amount: number;
  referenceType?: string;
  referenceId?: string;
  description?: string;
  metadata?: unknown;
}

/**
 * Append a SPEND ledger entry; throws {@link InsufficientCreditsError}
 * when the balance is below `amount`. Per-subscriber advisory lock keeps
 * concurrent spends from overdrafting.
 */
export async function spendCredits(
  args: SpendCreditsArgs,
): Promise<CreditLedger> {
  if (!Number.isInteger(args.amount) || args.amount <= 0) {
    throw new Error("spendCredits: amount must be a positive integer");
  }

  return drizzle.db.transaction(async (tx) => {
    await drizzle.lockRepo.advisoryXactLock(tx, args.subscriberId);

    const subscriber = await drizzle.subscriberRepo.findSubscriberProjectId(
      tx,
      args.subscriberId,
    );
    if (!subscriber) {
      throw new Error(`Subscriber ${args.subscriberId} not found`);
    }

    const last = await drizzle.creditLedgerRepo.findLatestBalance(
      tx,
      args.subscriberId,
    );
    const prevBalance = last?.balance ?? 0;

    if (prevBalance < args.amount) {
      throw new InsufficientCreditsError(prevBalance, args.amount);
    }

    const balance = prevBalance - args.amount;

    log.debug("spending credits", {
      subscriberId: args.subscriberId,
      amount: args.amount,
      newBalance: balance,
    });

    const row = await drizzle.creditLedgerRepo.insertCreditLedger(tx, {
      projectId: subscriber.projectId,
      subscriberId: args.subscriberId,
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
    amount: args.amount,
    type: CreditLedgerType.REFUND,
    referenceType: args.referenceType ?? "refund",
    referenceId: args.referenceId,
    description: args.description,
    metadata: args.metadata,
  });
}
