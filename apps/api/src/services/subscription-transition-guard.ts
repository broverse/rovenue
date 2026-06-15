import type { Db, PurchaseStatus, Store } from "@rovenue/db";
import { drizzle } from "@rovenue/db";
import { audit } from "../lib/audit";
import { logger } from "../lib/logger";
import { decideTransition } from "./subscription-state";

const log = logger.child("subscription-transition-guard");

export interface GuardStatusWriteArgs {
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
    await audit({
      projectId: args.projectId,
      userId: "system",
      action: "subscription.transition_rejected",
      resource: "purchase",
      resourceId: current?.id ?? args.storeTransactionId,
      before: { status: decision.from },
      after: { status: decision.to },
      ipAddress: null,
      userAgent: null,
    });
  }

  return {
    apply: decision.apply,
    purchaseId: current?.id ?? null,
    from: decision.from,
    to: decision.to,
  };
}
