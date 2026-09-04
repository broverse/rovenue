import { type Db, CreditLedgerType, drizzle } from "@rovenue/db";
import { logger } from "../lib/logger";
import { audit } from "../lib/audit";
import { syncAccess } from "./access-engine";
import { publishSubscriberInvalidation } from "../lib/config-invalidation";

// =============================================================
// Subscriber account lifecycle — merge + anonymize
// =============================================================
//
// `transferSubscriber` moves every asset from one subscriber to
// another inside a single serialised Drizzle transaction. The
// source subscriber is soft-deleted afterward so it never
// surfaces in future evaluations or config calls.
//
// KVKK / GDPR "right to erasure" lives in
// services/gdpr/anonymize-subscriber.ts (HMAC-keyed token + Stripe
// subscription cancellation) — the unkeyed sha256 variant that used to
// live here was never wired and was removed so it can't be.

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

/**
 * Moves every asset (purchases, access, experiment assignments, credit
 * balance) from `fromId` to `toId` and soft-deletes the source as merged.
 * MUST run inside a transaction that already holds the advisory locks for
 * both subscribers. Returns the number of credits moved. Reused by both
 * `transferSubscriber` (secret-key) and `bindAppUserId` (identify).
 *
 * Every underlying reassignment filters on subscriber id alone — none of
 * them scopes to `projectId`, which otherwise only stamps credit-ledger
 * rows. So a caller that passes a cross-project pair would silently move
 * one project's assets onto another's subscriber. Only the funnel claim
 * path guards this itself; the others rely on it never happening. Make it
 * a property of this function instead: read both rows and refuse unless
 * both belong to `projectId`. Merges are infrequent, so the two reads are
 * cheap, and this can only ever fire on corrupt input — no legitimate
 * caller crosses a project boundary.
 */
export async function reassignAllAssets(
  tx: Db,
  projectId: string,
  from: { id: string; label: string },
  to: { id: string; label: string },
): Promise<number> {
  const [fromRow, toRow] = await Promise.all([
    drizzle.subscriberRepo.findSubscriberById(tx, from.id),
    drizzle.subscriberRepo.findSubscriberById(tx, to.id),
  ]);
  if (!fromRow || fromRow.projectId !== projectId) {
    throw new Error(
      `reassignAllAssets: source ${from.id} (${from.label}) is not in project ${projectId}`,
    );
  }
  if (!toRow || toRow.projectId !== projectId) {
    throw new Error(
      `reassignAllAssets: target ${to.id} (${to.label}) is not in project ${projectId}`,
    );
  }

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
    // Symmetric with the source guard above. `findSubscriberByAppUserId`
    // does not filter `deletedAt`, so without this a transfer whose
    // TARGET was itself already merged away would reassign every asset
    // onto the retired row — silently losing the transfer into a
    // subscriber nothing reads. Refusing is deliberate: following
    // `mergedInto` to the survivor would redirect a transfer the caller
    // never asked for, which is a semantic change worth making
    // explicitly rather than as a side effect of a bug fix.
    if (to.deletedAt) {
      throw new Error(
        `Target subscriber '${toAppUserId}' has already been transferred`,
      );
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

  // Both ids: the device that initiated the merge may still be holding the
  // retired one, and its stream needs waking so the next evaluation
  // re-resolves onto the survivor.
  await publishSubscriberInvalidation(projectId, [
    result.fromSubscriberId,
    result.toSubscriberId,
  ]);

  return result;
}

