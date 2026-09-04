import { and, desc, eq, gte } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { APPLE_FAMILY_SHARED_OWNERSHIP_TYPE } from "@rovenue/shared/subscription-status";
import type { Db } from "../client";
import {
  revenueEvents,
  revenueEventDedupe,
  purchases,
  type RevenueEvent,
} from "../schema";
import { revenueEventType, store as storeEnum } from "../enums";
import * as outboxRepo from "./outbox";

type DbOrTx = Db;
type Store = (typeof storeEnum.enumValues)[number];
type RevenueEventType = (typeof revenueEventType.enumValues)[number];

// =============================================================
// Dedup-key kind
// =============================================================

/**
 * Coarse economic class for a revenue event, used as the trailing segment of
 * a `dedupeKey` (`<store>:<transactionId>:<kind>`). Using the class — not the
 * fine-grained `RevenueEventType` — lets the client receipt-verify path and
 * the store webhook converge on the SAME key for one transaction even when
 * they classify it differently (e.g. receipt sees INITIAL, webhook sees
 * RENEWAL), while keeping genuinely distinct events on the same transaction
 * id apart (a REACTIVATION after a REFUND must not collide with the original
 * purchase).
 */
export function revenueDedupeKind(type: RevenueEventType): string {
  switch (type) {
    case "INITIAL":
    case "RENEWAL":
    case "TRIAL_CONVERSION":
    case "CREDIT_PURCHASE":
      return "purchase";
    case "REACTIVATION":
      return "reactivation";
    case "REFUND":
      return "refund";
    case "CANCELLATION":
      return "cancel";
    default:
      return type;
  }
}

// =============================================================
// Revenue event reads — Drizzle repository
// =============================================================

/**
 * Dedup guard used by expiry-checker: has the subscriber already
 * had a CANCELLATION revenue event written since `since`? If yes,
 * skip emitting a duplicate.
 */
export async function findRecentRevenueEvent(
  db: Db,
  subscriberId: string,
  purchaseId: string,
  type: RevenueEventType,
  since: Date,
): Promise<RevenueEvent | null> {
  const rows = await db
    .select()
    .from(revenueEvents)
    .where(
      and(
        eq(revenueEvents.subscriberId, subscriberId),
        eq(revenueEvents.purchaseId, purchaseId),
        eq(revenueEvents.type, type),
        gte(revenueEvents.createdAt, since),
      ),
    )
    .orderBy(desc(revenueEvents.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Fetch a single revenue_events row by its primary-key id.
 * Returns `null` when no row exists (safe for refund-endpoint
 * callers that need to resolve a revenue event → its purchase).
 */
export async function findRevenueEventById(
  db: DbOrTx,
  id: string,
): Promise<RevenueEvent | null> {
  const [row] = await db
    .select()
    .from(revenueEvents)
    .where(eq(revenueEvents.id, id))
    .limit(1);
  return row ?? null;
}

// =============================================================
// Writes
// =============================================================

export interface CreateRevenueEventInput {
  projectId: string;
  subscriberId: string;
  purchaseId: string;
  productId: string;
  type: RevenueEventType;
  amount: string;
  currency: string;
  amountUsd: string;
  store: Store;
  eventDate: Date;
  /**
   * Deterministic idempotency key for the originating economic event
   * (e.g. `apple:<transactionId>:REFUND`). When provided, a re-insert of
   * the same logical event (at-least-once webhook/outbox replay) is a
   * no-op: the existing row is returned and NO second outbox row is
   * written. Omit (or pass null) to keep the legacy always-insert
   * behavior for callers without a stable key.
   */
  dedupeKey?: string | null;
  /**
   * Free-form extra context folded into the co-located REVENUE_EVENT
   * outbox row's payload only — `revenue_events` has no metadata column,
   * so this never round-trips through a read of the OLTP row. Used today
   * to carry the purchase's `presentedContext` (paywall attribution) to
   * the CH revenue pipeline.
   */
  metadata?: Record<string, unknown> | null;
  /**
   * The store's own per-transaction country — e.g. Apple's `storefront`
   * (a 3-letter storefront code on the decoded JWS transaction). This is
   * a fact about where THIS transaction happened, sourced from the store
   * itself; it must never be filled in from a subscriber's last-known
   * SDK-reported country, which is a different fact and can be stale or
   * absent entirely. Folded into the co-located outbox row's payload as
   * a top-level `country` field (alongside `store`/`currency`) so
   * `mv_revenue_to_raw` can extract it directly — never written to
   * ClickHouse directly, the outbox is the only path. Omit (or pass
   * null/empty) when the store didn't supply one for this transaction;
   * a missing payload key resolves to `raw_revenue_events.country`'s
   * `DEFAULT ''`, the same absence convention `placementId` etc. use.
   */
  country?: string | null;
}

/**
 * Append a new revenue_events row. The table is append-only by
 * convention (analytics love immutability) — callers never UPDATE
 * an existing row, they always insert a new one for the latest
 * observation of the same purchase. Co-writes a REVENUE_EVENT outbox
 * row in the same transaction so both inserts commit or roll back together.
 *
 * When `dedupeKey` is set the insert is idempotent via the
 * `(dedupeKey, eventDate)` unique index — replays return the existing
 * row without re-emitting the outbox event, preventing double-counted
 * revenue downstream.
 */
export async function createRevenueEvent(
  db: DbOrTx,
  input: CreateRevenueEventInput,
): Promise<RevenueEvent | null> {
  // Family Sharing: the organiser already paid for this subscription.
  // The member is entitled (the access engine grants normally off
  // `purchases`/`subscriber_access`, untouched here) but must not
  // produce a second economic event — that double-counts MRR and LTV.
  // Checked here, inside the repository, rather than at each of the
  // thirteen createRevenueEvent call sites (webhooks, receipt verify,
  // data import, two workers) so no future Apple-reachable path can
  // forget it, and so no downstream analytics query needs an
  // ownershipType filter: the row simply never exists.
  //
  // This read happens BEFORE the transaction below, not inside it, and
  // that leaves a narrow window: apps/api/src/services/import/write.ts
  // (~line 557) is the one reachable path that can change ownershipType
  // on an EXISTING purchase row — its onConflictDoUpdate conditionally
  // sets it from a re-imported CSV row. If that update commits between
  // this SELECT and this call's own insert, a webhook or receipt-verify
  // call already past this check can still write the very row this
  // suppression exists to prevent. The Apple webhook and receipt-verify
  // upsert paths never touch this column, so they are not a source of
  // the race — only a concurrent re-import is.
  //
  // The window is accepted deliberately, not overlooked: closing it
  // would require `SELECT ... FOR UPDATE` on the purchase row for every
  // revenue-event write (a lock on a hot path, since nothing short of a
  // lock closes a window under READ COMMITTED — reading inside the
  // transaction below without one would still miss a concurrent update
  // that commits after the read). That cost buys protection against, at
  // most, one over-counted row from a rare interleaving (a live
  // transaction being re-imported at the same moment a store event
  // arrives for it) — a visible, correctable extra row, not a silent
  // systemic double-count. Not worth it.
  const [linkedPurchase] = await db
    .select({ ownershipType: purchases.ownershipType })
    .from(purchases)
    .where(eq(purchases.id, input.purchaseId))
    .limit(1);
  if (linkedPurchase?.ownershipType === APPLE_FAMILY_SHARED_OWNERSHIP_TYPE) {
    return null;
  }

  return db.transaction(async (tx) => {
    // Idempotency gate: claim the dedupe key in the non-partitioned
    // revenue_event_dedupe table first. A conflict means this economic
    // event was already recorded (by an earlier webhook OR the receipt
    // path), so return the existing row and skip the insert + outbox emit.
    if (input.dedupeKey) {
      const revenueEventId = createId();
      const claimed = await tx
        .insert(revenueEventDedupe)
        .values({
          projectId: input.projectId,
          dedupeKey: input.dedupeKey,
          revenueEventId,
        })
        .onConflictDoNothing({
          target: [revenueEventDedupe.projectId, revenueEventDedupe.dedupeKey],
        })
        .returning();

      if (claimed.length === 0) {
        const [existingKey] = await tx
          .select()
          .from(revenueEventDedupe)
          .where(
            and(
              eq(revenueEventDedupe.projectId, input.projectId),
              eq(revenueEventDedupe.dedupeKey, input.dedupeKey),
            ),
          )
          .limit(1);
        if (existingKey) {
          const existing = await findRevenueEventById(
            tx,
            existingKey.revenueEventId,
          );
          if (existing) return existing;
        }
        throw new Error(
          "createRevenueEvent: dedupe conflict but no existing revenue event",
        );
      }

      return insertRevenueRow(tx, input, revenueEventId);
    }

    return insertRevenueRow(tx, input, createId());
  });
}

/**
 * Insert the revenue_events row + its co-located REVENUE_EVENT outbox row in
 * the caller's transaction. `id` is pre-generated so the dedupe claim and the
 * row share the same identifier.
 */
async function insertRevenueRow(
  tx: Parameters<Parameters<Db["transaction"]>[0]>[0],
  input: CreateRevenueEventInput,
  id: string,
): Promise<RevenueEvent> {
  const [inserted] = await tx
    .insert(revenueEvents)
    .values({
      id,
      projectId: input.projectId,
      subscriberId: input.subscriberId,
      purchaseId: input.purchaseId,
      productId: input.productId,
      type: input.type,
      amount: input.amount,
      currency: input.currency,
      amountUsd: input.amountUsd,
      store: input.store,
      eventDate: input.eventDate,
      dedupeKey: input.dedupeKey ?? null,
    })
    .returning();

  if (!inserted) {
    throw new Error("createRevenueEvent: insert returned no rows");
  }

  await outboxRepo.insert(tx, {
    aggregateType: "REVENUE_EVENT",
    aggregateId: inserted.id,
    eventType: "revenue.event.recorded",
    payload: {
      revenueEventId: inserted.id,
      projectId: inserted.projectId,
      subscriberId: inserted.subscriberId,
      purchaseId: inserted.purchaseId,
      productId: inserted.productId,
      type: inserted.type,
      store: inserted.store,
      amount: inserted.amount,
      amountUsd: inserted.amountUsd,
      currency: inserted.currency,
      eventDate: inserted.eventDate.toISOString(),
      ...(input.country ? { country: input.country } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    },
  });

  return inserted;
}
