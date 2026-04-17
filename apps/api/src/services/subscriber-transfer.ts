import prisma, { CreditLedgerType, Prisma } from "@rovenue/db";
import { logger } from "../lib/logger";
import { audit } from "../lib/audit";

// =============================================================
// Subscriber account merge / transfer
// =============================================================
//
// Moves every asset (purchases, access rows, experiment
// assignments, credit balance) from one subscriber to another
// inside a single serialised Prisma transaction. The source
// subscriber is soft-deleted afterward so it never surfaces in
// future evaluations or config calls.

const log = logger.child("subscriber-transfer");

export interface TransferResult {
  fromSubscriberId: string;
  toSubscriberId: string;
  creditsTransferred: number;
}

export async function transferSubscriber(
  projectId: string,
  fromAppUserId: string,
  toAppUserId: string,
  userId?: string,
): Promise<TransferResult> {
  if (fromAppUserId === toAppUserId) {
    throw new Error("Cannot transfer a subscriber to the same account");
  }

  return prisma.$transaction(async (tx) => {
    // Advisory lock on BOTH subscribers, project-scoped, in
    // canonical order to prevent deadlocks. Two concurrent
    // transfer(A→B) calls now serialize at the lock, so the credit
    // balance read + write is race-free. Keys include projectId so
    // same-appUserId in different projects doesn't contend.
    const [k1, k2] = [fromAppUserId, toAppUserId].sort();
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`${projectId}:${k1}`}, 0)),
                        pg_advisory_xact_lock(hashtextextended(${`${projectId}:${k2}`}, 0))`,
    );

    const from = await tx.subscriber.findUnique({
      where: {
        projectId_appUserId: { projectId, appUserId: fromAppUserId },
      },
    });
    if (!from) {
      throw new Error(`Source subscriber '${fromAppUserId}' not found`);
    }
    if (from.deletedAt) {
      throw new Error(
        `Source subscriber '${fromAppUserId}' has already been transferred`,
      );
    }

    const to = await tx.subscriber.findUnique({
      where: {
        projectId_appUserId: { projectId, appUserId: toAppUserId },
      },
    });
    if (!to) {
      throw new Error(`Target subscriber '${toAppUserId}' not found`);
    }

    // --- Reassign purchases ---
    await tx.purchase.updateMany({
      where: { subscriberId: from.id },
      data: { subscriberId: to.id },
    });

    // --- Reassign entitlement access ---
    await tx.subscriberAccess.updateMany({
      where: { subscriberId: from.id },
      data: { subscriberId: to.id },
    });

    // --- Reassign experiment assignments ---
    await tx.experimentAssignment.updateMany({
      where: { subscriberId: from.id },
      data: { subscriberId: to.id },
    });

    // --- Transfer credits ---
    let creditsTransferred = 0;
    const fromBalance = await tx.creditLedger.findFirst({
      where: { subscriberId: from.id },
      orderBy: { createdAt: "desc" },
      select: { balance: true },
    });
    const fromBal = fromBalance?.balance ?? 0;

    if (fromBal > 0) {
      creditsTransferred = fromBal;

      // Zero out the source subscriber
      await tx.creditLedger.create({
        data: {
          projectId,
          subscriberId: from.id,
          type: CreditLedgerType.TRANSFER_OUT,
          amount: -fromBal,
          balance: 0,
          referenceType: "transfer",
          referenceId: to.id,
          description: `Credits transferred to ${toAppUserId}`,
        },
      });

      // Credit the target subscriber
      const toBalance = await tx.creditLedger.findFirst({
        where: { subscriberId: to.id },
        orderBy: { createdAt: "desc" },
        select: { balance: true },
      });
      const toBal = toBalance?.balance ?? 0;

      await tx.creditLedger.create({
        data: {
          projectId,
          subscriberId: to.id,
          type: CreditLedgerType.TRANSFER_IN,
          amount: fromBal,
          balance: toBal + fromBal,
          referenceType: "transfer",
          referenceId: from.id,
          description: `Credits received from ${fromAppUserId}`,
        },
      });
    }

    // --- Soft-delete the source ---
    await tx.subscriber.update({
      where: { id: from.id },
      data: {
        deletedAt: new Date(),
        mergedInto: to.id,
      },
    });

    log.info("subscriber transferred", {
      projectId,
      from: from.id,
      to: to.id,
      creditsTransferred,
    });

    // Audit log — uses the transaction client so a rollback also
    // removes the audit row. Awaited so failure aborts the whole
    // transfer instead of silently losing the record.
    if (userId) {
      await audit(
        {
          projectId,
          userId,
          action: "update",
          resource: "subscriber",
          resourceId: from.id,
          before: { appUserId: fromAppUserId },
          after: { mergedInto: to.id, appUserId: toAppUserId },
        },
        tx,
      );
    }

    return {
      fromSubscriberId: from.id,
      toSubscriberId: to.id,
      creditsTransferred,
    };
  });
}
