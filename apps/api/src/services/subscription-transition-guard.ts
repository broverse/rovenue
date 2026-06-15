import type { Db, PurchaseStatus, Store } from "@rovenue/db";
import { drizzle } from "@rovenue/db";
import { audit, type AuditTx } from "../lib/audit";
import { logger } from "../lib/logger";
import { decideTransition } from "./subscription-state";

const log = logger.child("subscription-transition-guard");

export interface GuardStatusWriteArgs {
  /**
   * The Drizzle handle the guarded read + (rejection) audit run on.
   * Pass the SAME transaction the caller will use for the guarded
   * `upsertPurchase` / `updatePurchase` so the `FOR UPDATE` row lock
   * is held across the whole read-decide-write and concurrent handlers
   * for the same transaction serialize (FINDING 1, mechanism (a)).
   * When called with the plain singleton the read still works but the
   * lock releases at statement end — rely on the SQL-level terminal
   * guard in `upsertPurchase`/`updatePurchase` (mechanism (b)) then.
   */
  db: Db;
  projectId: string;
  store: Store;
  storeTransactionId: string;
  /** The status the ingestion path wants to write. */
  to: PurchaseStatus;
  /** Source label for the audit metadata (e.g. webhook type). */
  source: string;
}

export interface GuardStatusWriteResult {
  /** true when the caller should include `status` in its DB write. */
  apply: boolean;
  /** The id of the existing purchase row, when one was found. */
  purchaseId: string | null;
  from: PurchaseStatus | null;
  to: PurchaseStatus;
}

/**
 * Centralized status-write guard for the four ingestion paths.
 *
 * Reads the current status of the (store, storeTransactionId) row
 * `FOR UPDATE` so concurrent deliveries of the same transaction
 * serialize, validates the proposed transition through the state
 * machine, and — when the transition is illegal (e.g. a late
 * DID_RENEW after a REFUND) — writes a tamper-evident audit row and
 * tells the caller to withhold the `status` field. Non-status field
 * updates (expiry, price) stay the caller's responsibility and are
 * applied regardless.
 */
export async function guardStatusWrite(
  args: GuardStatusWriteArgs,
): Promise<GuardStatusWriteResult> {
  const current =
    await drizzle.purchaseRepo.lockPurchaseStatusByStoreTransaction(
      args.db,
      args.store,
      args.storeTransactionId,
    );
  const decision = decideTransition(current?.status ?? null, args.to);

  if (!decision.apply) {
    log.warn("rejected illegal status transition", {
      projectId: args.projectId,
      store: args.store,
      storeTransactionId: args.storeTransactionId,
      from: decision.from,
      to: decision.to,
      source: args.source,
    });
    await audit(
      {
        projectId: args.projectId,
        userId: "system",
        action: "subscription.transition_rejected",
        resource: "purchase",
        resourceId: current?.id ?? args.storeTransactionId,
        before: { status: decision.from },
        after: { status: decision.to },
        ipAddress: null,
        userAgent: null,
      },
      // Write the audit row on the caller's tx so it commits/rolls back
      // atomically with the guarded status write.
      args.db as unknown as AuditTx,
    );
  }

  return {
    apply: decision.apply,
    purchaseId: current?.id ?? null,
    from: decision.from,
    to: decision.to,
  };
}
