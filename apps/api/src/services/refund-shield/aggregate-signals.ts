import type { ClickHouseClient } from "@clickhouse/client";
import { sql } from "drizzle-orm";
import type { Db } from "@rovenue/db";
import type { RefundShieldSignals } from "../apple/refund-shield-buckets";

// =============================================================
// Refund Shield — signal aggregation
// =============================================================
//
// Bridges Postgres + ClickHouse into the typed `RefundShieldSignals`
// struct consumed by `mapToConsumptionRequest` (T7) and ultimately
// `sendConsumptionInfo` (T8). The polling worker (T14) is the only
// production caller: it fans out across pending refund-shield
// responses, invokes this aggregator per row, maps to the Apple
// payload, and submits.
//
// Source data
// -----------
// 1. Postgres `subscribers` + `subscriber_access` + `purchases` —
//    tenure (firstSeenAt), entitlement state, and the purchase
//    window/trial flag scoped to the originating transaction.
// 2. ClickHouse `sdk_sessions_daily_tbl` — lifetime session_ms,
//    aggregated across all `(projectId, subscriberId)` rows.
// 3. ClickHouse `v_revenue_lifetime_subscriber` — lifetime $
//    purchased + refunded in cents.
//
// We deliberately run the two CH lookups as separate queries
// (rather than a FULL JOIN) so a missing row in one table doesn't
// silently zero-out the other. Each query coalesces NULL → 0 at
// the SQL layer, then the TS wrapper falls back to 0 again if CH
// returned no rows at all (cold subscriber with zero history in
// either table).
//
// `db.execute` / `ch.query` are injected so the unit suite can
// stub both sides without touching real infrastructure. The
// production wiring in T14 will pass `drizzle.db` and
// `getClickHouseClient()` from `lib/clickhouse.ts`.

export interface AggregateInput {
  db: Db;
  ch: ClickHouseClient;
  projectId: string;
  subscriberId: string;
  originalTransactionId: string;
  customerConsented: boolean;
  appAccountToken?: string | null;
  now: Date;
}

interface PgAggregateRow {
  first_seen_at: Date | string;
  apple_app_account_token: string | null;
  has_active_entitlement: boolean;
  purchase_started_at: Date | string | null;
  purchase_ends_at: Date | string | null;
  was_in_trial: boolean | null;
}

interface ChSessionsRow {
  lifetime_session_ms: string | number | null;
}

interface ChRevenueRow {
  lifetime_dollars_purchased_cents: string | number | null;
  lifetime_dollars_refunded_cents: string | number | null;
}

function toDate(value: Date | string | null | undefined, fallback: Date): Date {
  if (!value) return fallback;
  if (value instanceof Date) return value;
  return new Date(value);
}

function requireDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

function toNumber(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export async function aggregateRefundShieldSignals(
  input: AggregateInput,
): Promise<RefundShieldSignals> {
  // -----------------------------------------------------------
  // Postgres: subscriber tenure + entitlement + purchase window.
  //
  // The `has_active_entitlement` check uses subscriber_access.
  // `isActive` is the denormalised flag; `expiresDate` may be
  // NULL for non-expiring access (lifetime grants), which we
  // treat as active. The purchase columns are pulled per
  // `originalTransactionId` so renewals correctly report the
  // most recent window.
  // -----------------------------------------------------------
  const pgResult = (await input.db.execute(sql`
    SELECT
      s."firstSeenAt"                                                   AS first_seen_at,
      s."apple_app_account_token"                                       AS apple_app_account_token,
      EXISTS(
        SELECT 1 FROM "subscriber_access"
        WHERE "subscriberId" = ${input.subscriberId}
          AND "isActive" = TRUE
          AND ("expiresDate" IS NULL OR "expiresDate" > NOW())
      )                                                                 AS has_active_entitlement,
      (
        SELECT MIN("purchaseDate") FROM "purchases"
        WHERE "originalTransactionId" = ${input.originalTransactionId}
      )                                                                 AS purchase_started_at,
      (
        SELECT "expiresDate" FROM "purchases"
        WHERE "originalTransactionId" = ${input.originalTransactionId}
        ORDER BY "purchaseDate" DESC
        LIMIT 1
      )                                                                 AS purchase_ends_at,
      (
        SELECT "isTrial" FROM "purchases"
        WHERE "originalTransactionId" = ${input.originalTransactionId}
        ORDER BY "purchaseDate" DESC
        LIMIT 1
      )                                                                 AS was_in_trial
    FROM "subscribers" s
    WHERE s.id = ${input.subscriberId}
  `)) as unknown as { rows: PgAggregateRow[] };

  const pg = pgResult.rows[0];
  if (!pg) {
    throw new Error(
      `aggregateRefundShieldSignals: subscriber not found (${input.subscriberId})`,
    );
  }

  // Fail fast if the purchase row is missing. Falling back to
  // `input.now` would make the duration zero and push the bucket
  // logic (T7) into the "fully consumed" branch, which is
  // misleading. Skip the CH lookups entirely — no point hitting
  // analytics when we already know the PG side is incomplete.
  if (!pg.purchase_started_at || !pg.purchase_ends_at) {
    throw new Error(
      `No purchase found for original_transaction_id=${input.originalTransactionId} (subscriber=${input.subscriberId}, project=${input.projectId})`,
    );
  }

  // -----------------------------------------------------------
  // ClickHouse: two scoped lookups.
  //
  // SummingMergeTree may yield multiple unmerged rows per key
  // until a background merge collapses them, so we sum at query
  // time. UInt64 sums round-trip as strings in some `@clickhouse/
  // client` versions to preserve precision — `toNumber` handles
  // both shapes.
  // -----------------------------------------------------------
  const sessionsResult = await input.ch.query({
    query: `
      SELECT coalesce(sum(session_ms), 0) AS lifetime_session_ms
      FROM sdk_sessions_daily_tbl
      WHERE projectId = {pid:String} AND subscriberId = {sid:String}
    `,
    query_params: { pid: input.projectId, sid: input.subscriberId },
    format: "JSONEachRow",
  });
  const sessionsRows = (await sessionsResult.json()) as ChSessionsRow[];
  const sessions = sessionsRows[0] ?? null;

  const revenueResult = await input.ch.query({
    query: `
      SELECT
        coalesce(sum(lifetime_dollars_purchased_cents), 0) AS lifetime_dollars_purchased_cents,
        coalesce(sum(lifetime_dollars_refunded_cents), 0)  AS lifetime_dollars_refunded_cents
      FROM v_revenue_lifetime_subscriber
      WHERE projectId = {pid:String} AND subscriberId = {sid:String}
    `,
    query_params: { pid: input.projectId, sid: input.subscriberId },
    format: "JSONEachRow",
  });
  const revenueRows = (await revenueResult.json()) as ChRevenueRow[];
  const revenue = revenueRows[0] ?? null;

  return {
    customerConsented: input.customerConsented,
    // Prefer the authoritative DB value (subscribers.apple_app_account_token,
    // stamped by T9 when the SDK calls /v1/subscribers); fall back to the
    // caller-supplied input only when the row hasn't been hydrated yet.
    appAccountToken: pg.apple_app_account_token ?? input.appAccountToken ?? null,
    firstSeenAt: toDate(pg.first_seen_at, input.now),
    now: input.now,
    purchaseStartedAt: requireDate(pg.purchase_started_at),
    purchaseEndsAt: requireDate(pg.purchase_ends_at),
    wasInTrial: !!pg.was_in_trial,
    hasActiveEntitlement: !!pg.has_active_entitlement,
    lifetimeSessionMs: toNumber(sessions?.lifetime_session_ms ?? 0),
    lifetimeDollarsPurchasedCents: toNumber(
      revenue?.lifetime_dollars_purchased_cents ?? 0,
    ),
    lifetimeDollarsRefundedCents: toNumber(
      revenue?.lifetime_dollars_refunded_cents ?? 0,
    ),
  };
}
