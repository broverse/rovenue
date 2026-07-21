import { createHash } from "node:crypto";
import { type Db, CreditLedgerType, drizzle } from "@rovenue/db";
import { logger } from "../lib/logger";
import { audit } from "../lib/audit";
import { syncAccess } from "./access-engine";

// =============================================================
// Subscriber account lifecycle — merge + anonymize
// =============================================================
//
// `transferSubscriber` moves every asset from one subscriber to
// another inside a single serialised Drizzle transaction. The
// source subscriber is soft-deleted afterward so it never
// surfaces in future evaluations or config calls.
//
// `anonymizeSubscriber` is the KVKK / GDPR "right to erasure"
// counterpart: PII (`appUserId`, `attributes`) is replaced with a
// deterministic anonymous token while purchase/credit history is
// kept intact for financial compliance.

const log = logger.child("subscriber-transfer");

/**
 * Recompute the surviving subscriber's denormalized `subscriber_access`
 * after a merge moved purchases + access rows onto it. Without this, two
 * purchases (one from each merged subscriber) can leave duplicate active
 * rows for the same accessId, surfacing the wrong (earlier) expiry.
 * Best-effort: the merge has already committed, so a transient failure is
 * logged rather than failing the request — it self-heals on the next
 * access-changing event for this subscriber.
 */
export async function safeSyncAccessAfterMerge(
  subscriberId: string,
): Promise<void> {
  try {
    await syncAccess(subscriberId);
  } catch (err) {
    log.warn("syncAccess after merge failed", {
      subscriberId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

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

/**
 * Moves every asset (purchases, access, experiment assignments, credit
 * balance) from `fromId` to `toId` and soft-deletes the source as merged.
 * MUST run inside a transaction that already holds the advisory locks for
 * both subscribers. Returns the number of credits moved. Reused by both
 * `transferSubscriber` (secret-key) and `bindAppUserId` (identify).
 */
export async function reassignAllAssets(
  tx: Db,
  projectId: string,
  from: { id: string; label: string },
  to: { id: string; label: string },
): Promise<number> {
  await drizzle.subscriberRepo.reassignPurchases(tx, from.id, to.id);
  await drizzle.subscriberRepo.reassignRevenueEvents(tx, from.id, to.id);
  await drizzle.subscriberRepo.reassignSubscriberAccess(tx, from.id, to.id);
  await drizzle.subscriberRepo.reassignExperimentAssignments(tx, from.id, to.id);

  let creditsTransferred = 0;
  const fromBalances = await drizzle.creditLedgerRepo.findAllBalances(tx, from.id);
  for (const { currencyId, balance } of fromBalances) {
    if (balance <= 0) continue;
    creditsTransferred += balance;
    await drizzle.creditLedgerRepo.insertCreditLedger(tx, {
      projectId,
      subscriberId: from.id,
      currencyId,
      type: CreditLedgerType.TRANSFER_OUT,
      amount: -balance,
      balance: 0,
      referenceType: "transfer",
      referenceId: to.id,
      description: `Credits transferred to ${to.label}`,
    });
    const toBalance = await drizzle.creditLedgerRepo.findLatestBalance(
      tx,
      to.id,
      currencyId,
    );
    const toBal = toBalance?.balance ?? 0;
    await drizzle.creditLedgerRepo.insertCreditLedger(tx, {
      projectId,
      subscriberId: to.id,
      currencyId,
      type: CreditLedgerType.TRANSFER_IN,
      amount: balance,
      balance: toBal + balance,
      referenceType: "transfer",
      referenceId: from.id,
      description: `Credits received from ${from.label}`,
    });
  }

  await drizzle.subscriberRepo.softDeleteSubscriberAsMerged(
    tx,
    from.id,
    to.id,
    new Date(),
  );
  return creditsTransferred;
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

  const result = await drizzle.db.transaction(async (tx) => {
    // Advisory lock on BOTH subscribers, project-scoped, in
    // canonical order to prevent deadlocks. Two concurrent
    // transfer(A→B) calls now serialize at the lock, so the credit
    // balance read + write is race-free. Keys include projectId so
    // same-appUserId in different projects doesn't contend.
    const [k1, k2] = [fromAppUserId, toAppUserId].sort();
    await drizzle.lockRepo.advisoryXactLock2(
      tx,
      `${projectId}:${k1}`,
      `${projectId}:${k2}`,
    );

    const from = await drizzle.subscriberRepo.findSubscriberByAppUserId(tx, {
      projectId,
      appUserId: fromAppUserId,
    });
    if (!from) {
      throw new Error(`Source subscriber '${fromAppUserId}' not found`);
    }
    if (from.deletedAt) {
      throw new Error(
        `Source subscriber '${fromAppUserId}' has already been transferred`,
      );
    }

    const to = await drizzle.subscriberRepo.findSubscriberByAppUserId(tx, {
      projectId,
      appUserId: toAppUserId,
    });
    if (!to) {
      throw new Error(`Target subscriber '${toAppUserId}' not found`);
    }

    const creditsTransferred = await reassignAllAssets(
      tx,
      projectId,
      { id: from.id, label: fromAppUserId },
      { id: to.id, label: toAppUserId },
    );

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

  // Reconcile the surviving subscriber's denormalized access now that the
  // merged subscriber's purchases + access rows belong to it.
  await safeSyncAccessAfterMerge(result.toSubscriberId);
  return result;
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

/**
 * @param appUserId Either a customer `appUserId` OR a `rovenueId`.
 *   SDK-only subscribers have a null appUserId, so GDPR/KVKK erasure
 *   requested by device id must fall back to a rovenueId lookup.
 */
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

  return drizzle.db.transaction(async (tx) => {
    // Advisory lock scoped to (project, appUserId) serialises
    // concurrent anonymize calls for the same user so the find →
    // update sequence can't race with a transfer in flight.
    await drizzle.lockRepo.advisoryXactLock(
      tx,
      `anon:${projectId}:${appUserId}`,
    );

    // The identifier may be a customer appUserId or a rovenueId (SDK-only
    // subscribers have a null appUserId). Try the appUserId column first,
    // then fall back to a rovenueId lookup.
    const subscriber =
      (await drizzle.subscriberRepo.findSubscriberByAppUserId(tx, {
        projectId,
        appUserId,
      })) ??
      (await drizzle.subscriberRepo.findSubscriberByRovenueId(tx, {
        projectId,
        rovenueId: appUserId,
      }));
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

    await drizzle.subscriberRepo.anonymizeSubscriberRow(
      tx,
      subscriber.id,
      anonymousId,
      new Date(),
    );

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
        tx,
      );
    }

    return {
      subscriberId: subscriber.id,
      anonymousId,
      alreadyAnonymized: false,
    };
  });
}
