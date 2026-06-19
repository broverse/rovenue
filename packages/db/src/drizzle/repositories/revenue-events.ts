import { and, desc, eq, gte } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import type { Db } from "../client";
import { revenueEvents, revenueEventDedupe, type RevenueEvent } from "../schema";
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
): Promise<RevenueEvent> {
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
    },
  });

  return inserted;
}
