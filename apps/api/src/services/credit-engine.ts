import prisma, {
  CreditLedgerType,
  Prisma,
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
  const last = await prisma.creditLedger.findFirst({
    where: { subscriberId },
    orderBy: { createdAt: "desc" },
    select: { balance: true },
  });
  return last?.balance ?? 0;
}

export interface AddCreditsArgs {
  subscriberId: string;
  amount: number;
  type?: CreditLedgerType;
  referenceType?: string;
  referenceId?: string;
  description?: string;
  metadata?: Prisma.InputJsonValue;
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

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${args.subscriberId}, 0))`,
    );

    const subscriber = await tx.subscriber.findUnique({
      where: { id: args.subscriberId },
      select: { projectId: true },
    });
    if (!subscriber) {
      throw new Error(`Subscriber ${args.subscriberId} not found`);
    }

    const last = await tx.creditLedger.findFirst({
      where: { subscriberId: args.subscriberId },
      orderBy: { createdAt: "desc" },
      select: { balance: true },
    });
    const balance = (last?.balance ?? 0) + args.amount;

    log.debug("adding credits", {
      subscriberId: args.subscriberId,
      amount: args.amount,
      newBalance: balance,
    });

    return tx.creditLedger.create({
      data: {
        projectId: subscriber.projectId,
        subscriberId: args.subscriberId,
        type,
        amount: args.amount,
        balance,
        referenceType: args.referenceType,
        referenceId: args.referenceId,
        description: args.description,
        metadata: args.metadata,
      },
    });
  });
}

export interface SpendCreditsArgs {
  subscriberId: string;
  amount: number;
  referenceType?: string;
  referenceId?: string;
  description?: string;
  metadata?: Prisma.InputJsonValue;
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

  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${args.subscriberId}, 0))`,
    );

    const subscriber = await tx.subscriber.findUnique({
      where: { id: args.subscriberId },
      select: { projectId: true },
    });
    if (!subscriber) {
      throw new Error(`Subscriber ${args.subscriberId} not found`);
    }

    const last = await tx.creditLedger.findFirst({
      where: { subscriberId: args.subscriberId },
      orderBy: { createdAt: "desc" },
      select: { balance: true },
    });
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

    return tx.creditLedger.create({
      data: {
        projectId: subscriber.projectId,
        subscriberId: args.subscriberId,
        type: CreditLedgerType.SPEND,
        amount: -args.amount,
        balance,
        referenceType: args.referenceType,
        referenceId: args.referenceId,
        description: args.description,
        metadata: args.metadata,
      },
    });
  });
}

export interface RefundCreditsArgs {
  subscriberId: string;
  amount: number;
  referenceId: string;
  referenceType?: string;
  description?: string;
  metadata?: Prisma.InputJsonValue;
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
