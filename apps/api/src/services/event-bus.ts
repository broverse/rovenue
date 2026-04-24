import { drizzle, type Db } from "@rovenue/db";

// =============================================================
// event-bus
// =============================================================
//
// Callers pass a tx-bound Db so the outbox insert lands in the
// same transaction as the caller's OLTP write. For exposures
// (Plan 1) there is no OLTP row — the caller opens a short tx just
// to get a Db handle. The pattern is identical to how the
// revenue-event processor in Plan 2 will work (which does have an
// OLTP row).

export interface PublishExposureInput {
  experimentId: string;
  variantId: string;
  projectId: string;
  subscriberId: string;
  platform?: string | null;
  country?: string | null;
  exposedAt?: Date;
}

async function publishExposure(
  tx: Db,
  input: PublishExposureInput,
): Promise<void> {
  const payload = {
    experimentId: input.experimentId,
    variantId: input.variantId,
    projectId: input.projectId,
    subscriberId: input.subscriberId,
    platform: input.platform ?? null,
    country: input.country ?? null,
    exposedAt: (input.exposedAt ?? new Date()).toISOString(),
  };
  await drizzle.outboxRepo.insert(tx, {
    aggregateType: "EXPOSURE",
    aggregateId: input.experimentId,
    eventType: "experiment.exposure.recorded",
    payload,
  });
}

// =============================================================
// Revenue / credit fan-out (Plan 2)
// =============================================================
//
// Both helpers assume the OLTP business row (revenue_events or
// credit_ledger) has already been inserted on the same `tx` —
// see packages/db/src/drizzle/repositories/revenue-events.ts
// and credit-ledger.ts (Phase C). The outbox insert is the last
// statement of the repository's co-write wrapper so that
// Postgres' commit order matches arrival order on the dispatcher.

export interface PublishRevenueEventInput {
  revenueEventId: string;       // revenue_events.id (cuid2)
  projectId: string;
  subscriberId: string;
  purchaseId: string;
  productId: string;
  type: string;                 // revenueEventType enum value (INITIAL_PURCHASE | RENEWAL | REFUND | ...)
  store: string;                // 'APP_STORE' | 'PLAY_STORE' | 'STRIPE'
  amount: string;               // decimal(12,4) as string — preserves precision over JSON
  amountUsd: string;            // decimal(12,4) as string
  currency: string;             // ISO-4217
  eventDate: Date;
}

async function publishRevenueEvent(
  tx: Db,
  input: PublishRevenueEventInput,
): Promise<void> {
  const payload = {
    revenueEventId: input.revenueEventId,
    projectId: input.projectId,
    subscriberId: input.subscriberId,
    purchaseId: input.purchaseId,
    productId: input.productId,
    type: input.type,
    store: input.store,
    amount: input.amount,
    amountUsd: input.amountUsd,
    currency: input.currency,
    eventDate: input.eventDate.toISOString(),
  };
  await drizzle.outboxRepo.insert(tx, {
    aggregateType: "REVENUE_EVENT",
    aggregateId: input.revenueEventId,
    eventType: "revenue.event.recorded",
    payload,
  });
}

export interface PublishCreditLedgerEntryInput {
  creditLedgerId: string;       // credit_ledger.id
  projectId: string;
  subscriberId: string;
  type: string;                 // creditLedgerType enum (GRANT | DEBIT | REFUND | ADJUSTMENT | ...)
  amount: number;               // signed integer
  balance: number;              // running balance AFTER this row
  referenceType: string | null;
  referenceId: string | null;
  createdAt: Date;
}

async function publishCreditLedgerEntry(
  tx: Db,
  input: PublishCreditLedgerEntryInput,
): Promise<void> {
  const payload = {
    creditLedgerId: input.creditLedgerId,
    projectId: input.projectId,
    subscriberId: input.subscriberId,
    type: input.type,
    amount: input.amount,
    balance: input.balance,
    referenceType: input.referenceType,
    referenceId: input.referenceId,
    createdAt: input.createdAt.toISOString(),
  };
  await drizzle.outboxRepo.insert(tx, {
    aggregateType: "CREDIT_LEDGER",
    aggregateId: input.creditLedgerId,
    eventType: "credit.ledger.appended",
    payload,
  });
}

export const eventBus = {
  publishExposure,
  publishRevenueEvent,
  publishCreditLedgerEntry,
};
