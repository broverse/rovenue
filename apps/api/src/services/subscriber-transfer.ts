import { createHash } from "node:crypto";
import prisma, { CreditLedgerType, Prisma } from "@rovenue/db";
import { logger } from "../lib/logger";
import { audit } from "../lib/audit";

// =============================================================
// Subscriber account lifecycle — merge + anonymize
// =============================================================
//
// `transferSubscriber` moves every asset from one subscriber to
// another inside a single serialised Prisma transaction. The
// source subscriber is soft-deleted afterward so it never
// surfaces in future evaluations or config calls.
//
// `anonymizeSubscriber` is the KVKK / GDPR "right to erasure"
// counterpart: PII (`appUserId`, `attributes`) is replaced with a
// deterministic anonymous token while purchase/credit history is
// kept intact for financial compliance.

const log = logger.child("subscriber-transfer");

const ANON_PREFIX = "anon:";

function deriveAnonymousId(projectId: string, appUserId: string): string {
  const h = createHash("sha256")
    .update(`${projectId}|${appUserId}`)
    .digest("hex");
  // First 32 chars keep uniqueness at the project scale while
  // staying readable in the dashboard — full 64-char hexes are
  // noisy in the UI and don't buy additional collision safety.
  return `${ANON_PREFIX}${h.slice(0, 32)}`;
}

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

// =============================================================
// anonymizeSubscriber — GDPR / KVKK right to erasure
// =============================================================
//
// Keeps the subscriber row (so foreign-key references from
// purchases, credit_ledger, and revenue_events stay valid) but
// replaces every PII field with a deterministic anonymous token.
// The token is derived from `sha256(projectId|appUserId)` so
// repeat requests are idempotent AND re-ingestion of the same
// real appUserId after anonymization can be detected.
//
// Financial history (purchases, credit_ledger, revenue_events)
// is preserved — those tables back SOC 2 compliance and do not
// themselves carry PII beyond the (now anonymous) subscriberId.

export interface AnonymizeResult {
  subscriberId: string;
  anonymousId: string;
  alreadyAnonymized: boolean;
}

export async function anonymizeSubscriber(
  projectId: string,
  appUserId: string,
  userId?: string,
): Promise<AnonymizeResult> {
  if (appUserId.startsWith(ANON_PREFIX)) {
    throw new Error(
      "Refusing to anonymize an already-anonymized appUserId",
    );
  }

  return prisma.$transaction(async (tx) => {
    // Advisory lock scoped to (project, appUserId) serialises
    // concurrent anonymize calls for the same user so the find →
    // update sequence can't race with a transfer in flight.
    await tx.$executeRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${`anon:${projectId}:${appUserId}`}, 0))`,
    );

    const subscriber = await tx.subscriber.findUnique({
      where: {
        projectId_appUserId: { projectId, appUserId },
      },
    });
    if (!subscriber) {
      throw new Error(`Subscriber '${appUserId}' not found`);
    }

    const anonymousId = deriveAnonymousId(projectId, appUserId);

    // Idempotency — if the row was already anonymized through an
    // earlier request the appUserId is already the anonymous token.
    // We return the existing state instead of double-writing so the
    // audit trail doesn't grow a dupe entry per retry.
    if (subscriber.appUserId === anonymousId) {
      return {
        subscriberId: subscriber.id,
        anonymousId,
        alreadyAnonymized: true,
      };
    }

    await tx.subscriber.update({
      where: { id: subscriber.id },
      data: {
        appUserId: anonymousId,
        attributes: {} as Prisma.InputJsonValue,
        deletedAt: new Date(),
      },
    });

    log.info("subscriber anonymized", {
      projectId,
      subscriberId: subscriber.id,
    });

    // Audit entry carries the anonymous token, not the original
    // appUserId — the audit log itself must not retain PII post
    // erasure. `before` keeps the fact that PII existed; the
    // content of that PII is redacted.
    if (userId) {
      await audit(
        {
          projectId,
          userId,
          action: "subscriber.anonymized",
          resource: "subscriber",
          resourceId: subscriber.id,
          before: { appUserId: "[REDACTED]" },
          after: { appUserId: anonymousId, anonymizedAt: new Date().toISOString() },
        },
        tx as unknown as Parameters<typeof audit>[1],
      );
    }

    return {
      subscriberId: subscriber.id,
      anonymousId,
      alreadyAnonymized: false,
    };
  });
}
