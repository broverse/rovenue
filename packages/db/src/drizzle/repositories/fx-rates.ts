import { and, between, eq, sql } from "drizzle-orm";
import type { Db } from "../client";
import { fxRates, type FxRate, type NewFxRate } from "../schema";

// =============================================================
// fx_rates repository
// =============================================================
//
// Canonical store for historical FX snapshots. The fx worker
// (apps/api/src/services/fx.ts) calls `upsertDailyRates` once per
// day with the full OpenExchangeRates payload converted to a
// NewFxRate[] keyed on (date, base, quote). Dashboard display
// conversion calls `getRate` / `getRatesForRange` to convert
// `revenue_events.amountUsd` into the user's chosen currency at
// the transaction-time rate (not today's), so historical reports
// don't drift as live rates move.

const USD = "USD";

export async function upsertDailyRates(
  db: Db,
  rows: NewFxRate[],
): Promise<void> {
  if (rows.length === 0) return;
  // (date, base, quote) PK → ON CONFLICT updates `rate` + `fetchedAt`
  // so a re-run of the cron the same day refreshes the snapshot
  // instead of erroring.
  await db
    .insert(fxRates)
    .values(rows)
    .onConflictDoUpdate({
      target: [fxRates.date, fxRates.base, fxRates.quote],
      set: {
        rate: sql`excluded.${sql.identifier("rate")}`,
        fetchedAt: sql`excluded.${sql.identifier("fetchedAt")}`,
      },
    });
}

export async function getRate(
  db: Db,
  isoDate: string,
  quote: string,
  base: string = USD,
): Promise<string | null> {
  const upperQuote = quote.toUpperCase();
  const upperBase = base.toUpperCase();
  if (upperQuote === upperBase) return "1";

  const rows = await db
    .select({ rate: fxRates.rate })
    .from(fxRates)
    .where(
      and(
        eq(fxRates.date, isoDate),
        eq(fxRates.base, upperBase),
        eq(fxRates.quote, upperQuote),
      ),
    )
    .limit(1);
  return rows[0]?.rate ?? null;
}

export async function getRatesForRange(
  db: Db,
  fromIsoDate: string,
  toIsoDate: string,
  quote: string,
  base: string = USD,
): Promise<FxRate[]> {
  return db
    .select()
    .from(fxRates)
    .where(
      and(
        eq(fxRates.base, base.toUpperCase()),
        eq(fxRates.quote, quote.toUpperCase()),
        between(fxRates.date, fromIsoDate, toIsoDate),
      ),
    );
}

export type { FxRate, NewFxRate };
