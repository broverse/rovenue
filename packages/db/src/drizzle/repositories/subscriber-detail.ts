import { and, desc, asc, eq } from "drizzle-orm";
import type { Db } from "../client";
import {
  creditLedger,
  experimentAssignments,
  experiments,
  outgoingWebhooks,
  products,
  purchases,
  subscriberAccess,
  type CreditLedgerRow,
  type OutgoingWebhook,
  type SubscriberAccessRow,
} from "../schema";

// =============================================================
// Subscriber detail fan-out — Drizzle repository
// =============================================================
//
// Specialised reads for the dashboard's subscriber detail page.
// Every call is subscriberId-scoped so they can run in parallel
// without contention.

export async function listAccessBySubscriber(
  db: Db,
  subscriberId: string,
): Promise<SubscriberAccessRow[]> {
  return db
    .select()
    .from(subscriberAccess)
    .where(eq(subscriberAccess.subscriberId, subscriberId))
    .orderBy(asc(subscriberAccess.entitlementKey));
}

export interface SubscriberDetailPurchase {
  id: string;
  productId: string;
  productIdentifier: string;
  store: "APP_STORE" | "PLAY_STORE" | "STRIPE";
  status:
    | "TRIAL"
    | "ACTIVE"
    | "EXPIRED"
    | "REFUNDED"
    | "REVOKED"
    | "PAUSED"
    | "GRACE_PERIOD";
  priceAmount: string | null;
  priceCurrency: string | null;
  purchaseDate: Date;
  expiresDate: Date | null;
  autoRenewStatus: boolean | null;
}

export async function listPurchasesBySubscriber(
  db: Db,
  subscriberId: string,
  limit: number,
): Promise<SubscriberDetailPurchase[]> {
  const rows = await db
    .select({
      id: purchases.id,
      productId: purchases.productId,
      store: purchases.store,
      status: purchases.status,
      priceAmount: purchases.priceAmount,
      priceCurrency: purchases.priceCurrency,
      purchaseDate: purchases.purchaseDate,
      expiresDate: purchases.expiresDate,
      autoRenewStatus: purchases.autoRenewStatus,
      productIdentifier: products.identifier,
    })
    .from(purchases)
    .innerJoin(products, eq(products.id, purchases.productId))
    .where(eq(purchases.subscriberId, subscriberId))
    .orderBy(desc(purchases.purchaseDate))
    .limit(limit);
  return rows;
}

export async function listCreditLedgerBySubscriber(
  db: Db,
  subscriberId: string,
  limit: number,
): Promise<CreditLedgerRow[]> {
  return db
    .select()
    .from(creditLedger)
    .where(eq(creditLedger.subscriberId, subscriberId))
    .orderBy(desc(creditLedger.createdAt))
    .limit(limit);
}

export interface SubscriberAssignmentDetail {
  experimentId: string;
  experimentKey: string;
  variantId: string;
  assignedAt: Date;
  convertedAt: Date | null;
  revenue: string | null;
}

export async function listAssignmentsBySubscriber(
  db: Db,
  subscriberId: string,
): Promise<SubscriberAssignmentDetail[]> {
  const rows = await db
    .select({
      experimentId: experimentAssignments.experimentId,
      variantId: experimentAssignments.variantId,
      assignedAt: experimentAssignments.assignedAt,
      convertedAt: experimentAssignments.convertedAt,
      revenue: experimentAssignments.revenue,
      experimentKey: experiments.key,
    })
    .from(experimentAssignments)
    .innerJoin(
      experiments,
      eq(experiments.id, experimentAssignments.experimentId),
    )
    .where(eq(experimentAssignments.subscriberId, subscriberId))
    .orderBy(desc(experimentAssignments.assignedAt));
  return rows;
}

export async function listOutgoingWebhooksBySubscriber(
  db: Db,
  subscriberId: string,
  limit: number,
): Promise<OutgoingWebhook[]> {
  return db
    .select()
    .from(outgoingWebhooks)
    .where(eq(outgoingWebhooks.subscriberId, subscriberId))
    .orderBy(desc(outgoingWebhooks.createdAt))
    .limit(limit);
}

// Helper that bundles all 5 fan-out reads into one call for the
// dashboard's detail endpoint.
export async function loadSubscriberDetail(
  db: Db,
  subscriberId: string,
): Promise<{
  access: SubscriberAccessRow[];
  purchases: SubscriberDetailPurchase[];
  latestBalance: number;
  ledger: CreditLedgerRow[];
  assignments: SubscriberAssignmentDetail[];
  outgoingWebhooks: OutgoingWebhook[];
}> {
  const [access, purchasesRows, ledger, assignments, outgoingWebhooksRows] =
    await Promise.all([
      listAccessBySubscriber(db, subscriberId),
      listPurchasesBySubscriber(db, subscriberId, 50),
      listCreditLedgerBySubscriber(db, subscriberId, 20),
      listAssignmentsBySubscriber(db, subscriberId),
      listOutgoingWebhooksBySubscriber(db, subscriberId, 20),
    ]);
  // Latest balance is the most recent entry in the ledger slice
  // (we already sorted DESC), falling back to 0 for greenfield
  // subscribers.
  const latestBalance = ledger[0]?.balance ?? 0;
  return {
    access,
    purchases: purchasesRows,
    latestBalance,
    ledger,
    assignments,
    outgoingWebhooks: outgoingWebhooksRows,
  };
}

// `and` is imported so callers can compose additional filters if
// they need to; we re-export for ergonomic use in the dashboard
// query layer.
export { and };
