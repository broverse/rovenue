import prisma, {
  CreditLedgerType,
  Prisma,
  type CreditLedger,
} from "@rovenue/db";
import { logger } from "../lib/logger";

const log = logger.child("credit-engine");

const DEFAULT_RETRY_ATTEMPTS = 3;

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
 * Return the subscriber's current credit balance. The CreditLedger is
 * append-only so the most recent entry's `balance` field is authoritative.
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
 * Append a PURCHASE / BONUS / REFUND ledger entry. Runs inside a serializable
 * transaction so concurrent grants cannot race on the running balance.
 */
export async function addCredits(args: AddCreditsArgs): Promise<CreditLedger> {
  if (!Number.isInteger(args.amount) || args.amount <= 0) {
    throw new Error("addCredits: amount must be a positive integer");
  }
  const type = args.type ?? CreditLedgerType.PURCHASE;

  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
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
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
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
 * Append a SPEND ledger entry. Rejects with {@link InsufficientCreditsError}
 * when the current balance is below `amount`. Uses serializable isolation +
 * retry so concurrent spends can't overdraft.
 */
export async function spendCredits(
  args: SpendCreditsArgs,
): Promise<CreditLedger> {
  if (!Number.isInteger(args.amount) || args.amount <= 0) {
    throw new Error("spendCredits: amount must be a positive integer");
  }

  return withSerializableRetry(() =>
    prisma.$transaction(
      async (tx) => {
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
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    ),
  );
}

export interface RefundCreditsArgs {
  subscriberId: string;
  amount: number;
  referenceId: string;
  referenceType?: string;
  description?: string;
  metadata?: Prisma.InputJsonValue;
}

/**
 * Append a REFUND ledger entry — additive like addCredits but tagged with
 * `type=REFUND` and always references the original grant or purchase via
 * `referenceId` for audit.
 */
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

async function withSerializableRetry<T>(
  fn: () => Promise<T>,
  maxAttempts = DEFAULT_RETRY_ATTEMPTS,
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isSerializationError(err)) throw err;
      log.warn("serialization conflict, retrying credit transaction", {
        attempt,
        maxAttempts,
      });
      await sleep(Math.floor(Math.random() * 50 * attempt));
    }
  }
  throw lastError;
}

function isSerializationError(err: unknown): boolean {
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    // P2034 = transaction failed due to write conflict or deadlock
    return err.code === "P2034";
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
