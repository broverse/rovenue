import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { drizzle, type Db } from "@rovenue/db";
import { redis } from "../lib/redis";
import { env } from "../lib/env";
import { logger } from "../lib/logger";

// =============================================================
// Currency conversion with layered caching
// =============================================================
//
// Storage layers, in lookup order from `convertToUsd`:
//
//   1. Redis fx:{date}:{from}:USD   → hot cache, USD-per-foreign
//   2. Redis fx:latest:{from}:USD   → most recent rate (forward-fill)
//   3. Postgres fx_rates            → canonical durable snapshot
//   4. Static fallback table        → degrades when everything is down
//
// Reasons for the split:
//
//   * Redis cache keeps the webhook hot-path sync-fast (single
//     roundtrip per revenue event).
//   * Postgres fx_rates is the source of truth for the dashboard's
//     display-currency switch — it lets us convert each historical
//     event using *that day's* rate so reports don't drift as live
//     rates move (RevenueCat-style locking, but on display).
//   * Static rates exist so revenue recording never blocks on infra
//     outages; convertToUsd is async but never throws.
//
// A BullMQ repeatable job fetches fresh rates daily at 00:05 UTC
// from OpenExchangeRates (free tier: USD-base + /latest only, which
// is exactly what we need — ~30 requests/month). On success it
// writes Postgres first (canonical) then mirrors to Redis (cache).
//
// RevenueCat difference: we lock conversion at the purchase date,
// not the report date. The original amount + currency are always
// preserved in the RevenueEvent row.

const log = logger.child("fx");

// =============================================================
// Static fallback rates (snapshot 2026-04)
// =============================================================
//
// USD-per-foreign — multiplied directly on the convertToUsd path.

export const STATIC_USD_RATES: Readonly<Record<string, number>> = {
  USD: 1,
  EUR: 1.08,
  GBP: 1.27,
  JPY: 0.0068,
  CNY: 0.14,
  KRW: 0.00074,
  INR: 0.012,
  TRY: 0.03,
  BRL: 0.2,
  MXN: 0.058,
  CAD: 0.74,
  AUD: 0.66,
  CHF: 1.13,
  SEK: 0.096,
  NOK: 0.094,
  DKK: 0.145,
  PLN: 0.25,
  CZK: 0.043,
  HUF: 0.0028,
  RUB: 0.011,
  ZAR: 0.054,
  SGD: 0.74,
  HKD: 0.128,
  NZD: 0.61,
  ILS: 0.27,
  AED: 0.272,
  SAR: 0.267,
};

const CACHE_TTL_SECONDS = 24 * 60 * 60;

function dateKey(date: string, from: string): string {
  return `fx:${date}:${from}:USD`;
}

function latestKey(from: string): string {
  return `fx:latest:${from}:USD`;
}

function formatDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// =============================================================
// convertToUsd — async with cache cascade
// =============================================================

export async function convertToUsd(
  amount: number,
  currency: string,
  date?: Date,
  db: Db = drizzle.db,
): Promise<number> {
  const upper = currency.toUpperCase();
  if (upper === "USD") return amount;

  const dateStr = date ? formatDate(date) : formatDate(new Date());

  // 1. Date-specific Redis cache
  try {
    const cached = await redis.get(dateKey(dateStr, upper));
    if (cached) return amount * parseFloat(cached);
  } catch {
    // fall through
  }

  // 2. Latest Redis cache
  try {
    const latest = await redis.get(latestKey(upper));
    if (latest) return amount * parseFloat(latest);
  } catch {
    // fall through
  }

  // 3. Postgres fx_rates — canonical store. `rate` is foreign-per-USD
  //    (e.g. EUR=0.93). To convert foreign → USD we divide.
  try {
    const pgRate = await drizzle.fxRateRepo.getRate(db, dateStr, upper);
    if (pgRate) {
      const numeric = parseFloat(pgRate);
      if (numeric > 0) return amount / numeric;
    }
  } catch (err) {
    log.warn("fx Postgres lookup failed", {
      dateStr,
      currency: upper,
      err: err instanceof Error ? err.message : String(err),
    });
  }

  // 4. Static fallback
  const staticRate = STATIC_USD_RATES[upper];
  if (staticRate !== undefined) return amount * staticRate;

  // 5. Unknown currency — pass through 1:1 to avoid zeroing
  return amount;
}

// =============================================================
// Fetch rates from API + persist to Postgres + Redis
// =============================================================
//
// Uses OpenExchangeRates /latest.json — free tier, USD base, no
// historical endpoint required (we only need today's rates each
// day; `dateStr` is just the bucket key). Response shape:
//
//   { base: "USD", rates: { EUR: 0.93, … }, timestamp: 1234567890 }
//
// On API/network failure we log and return — the worker swallows
// the miss because convertToUsd already has Postgres + static
// fallbacks. We never want a rate fetch to take down the API.

const API_BASE = "https://openexchangerates.org/api/latest.json";
export const FX_LAST_SUCCESS_KEY = "fx:last-success-at";

export async function fetchAndCacheRates(
  dateStr: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
  db: Db = drizzle.db,
): Promise<void> {
  const appId = env.OPEN_EXCHANGE_RATES_APP_ID;
  if (!appId) {
    log.warn(
      "OPEN_EXCHANGE_RATES_APP_ID not set — skipping FX fetch (convertToUsd will fall back to static rates)",
      { dateStr },
    );
    return;
  }

  let rates: Record<string, number>;
  try {
    const url = `${API_BASE}?app_id=${encodeURIComponent(appId)}&prettyprint=false`;
    const res = await fetchFn(url);
    if (!res.ok) {
      log.warn("fx API returned non-ok", {
        status: (res as Response).status,
        dateStr,
      });
      return;
    }
    const data = (await res.json()) as {
      error?: boolean;
      base?: string;
      rates?: Record<string, number>;
      timestamp?: number;
    };
    if (data.error || !data.rates || Object.keys(data.rates).length === 0) {
      log.warn("fx API returned unsuccessful payload", { dateStr });
      return;
    }
    rates = data.rates;
  } catch (err) {
    log.warn("fx API fetch failed", {
      dateStr,
      err: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // ---- Postgres upsert (canonical) ------------------------------------
  // `fx_rates.rate` stores foreign-per-USD as returned by the API.
  // Dashboard display path: `amountUsd × rate = quote_amount`.
  try {
    const pgRows = Object.entries(rates)
      .filter(([quote, value]) => quote && quote !== "USD" && value > 0)
      .map(([quote, value]) => ({
        date: dateStr,
        base: "USD",
        quote: quote.toUpperCase(),
        rate: value.toString(),
      }));
    if (pgRows.length > 0) {
      await drizzle.fxRateRepo.upsertDailyRates(db, pgRows);
    }
  } catch (err) {
    log.warn("fx Postgres upsert failed", {
      dateStr,
      err: err instanceof Error ? err.message : String(err),
    });
    // Continue to Redis — Redis cache is still useful even if PG fails.
  }

  // ---- Redis cache (hot path) -----------------------------------------
  // Stored inverted (USD-per-foreign) so the write-path multiplication
  // in convertToUsd stays a single arithmetic op.
  const entries: Array<[string, string]> = [];
  for (const [rawKey, foreignPerUsd] of Object.entries(rates)) {
    const from = rawKey.toUpperCase();
    if (!from || from === "USD" || foreignPerUsd <= 0) continue;
    const usdPerForeign = String(1 / foreignPerUsd);
    entries.push([dateKey(dateStr, from), usdPerForeign]);
    entries.push([latestKey(from), usdPerForeign]);
  }

  if (entries.length === 0) return;

  try {
    // `SET key value EX ttl` per entry in a single pipeline — avoids
    // the mset→expire race where a concurrent reader could see an
    // un-TTL'd key, or a crash between the two calls could leave
    // keys without TTL permanently.
    const pipeline = redis.pipeline();
    for (const [key, value] of entries) {
      pipeline.set(key, value, "EX", CACHE_TTL_SECONDS);
    }
    pipeline.set(FX_LAST_SUCCESS_KEY, new Date().toISOString());
    await pipeline.exec();
    log.info("fx rates cached", { dateStr, currencies: entries.length / 2 });
  } catch (err) {
    log.warn("fx cache write failed", {
      dateStr,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

// =============================================================
// Staleness check — read by /health/ready
// =============================================================

export async function getFxLastSuccessAt(): Promise<Date | null> {
  try {
    const iso = await redis.get(FX_LAST_SUCCESS_KEY);
    if (!iso) return null;
    const d = new Date(iso);
    return isNaN(d.getTime()) ? null : d;
  } catch {
    return null;
  }
}

const FX_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export async function isFxStale(now: Date = new Date()): Promise<boolean> {
  const last = await getFxLastSuccessAt();
  if (!last) return true;
  return now.getTime() - last.getTime() > FX_STALE_AFTER_MS;
}

// =============================================================
// BullMQ scheduled job — daily 00:05 UTC
// =============================================================

export const FX_QUEUE_NAME = "rovenue-fx-rates";

function createBullConnection(): Redis {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: false,
  });
}

let cachedQueue: Queue | undefined;

export function getFxQueue(): Queue {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue(FX_QUEUE_NAME, {
    connection: createBullConnection(),
    defaultJobOptions: {
      removeOnComplete: { count: 30, age: 7 * 24 * 60 * 60 },
      removeOnFail: { count: 100, age: 30 * 24 * 60 * 60 },
    },
  });
  return cachedQueue;
}

export async function scheduleFxFetch(): Promise<void> {
  const queue = getFxQueue();
  await queue.add(
    "fx:daily",
    {},
    {
      jobId: "fx-daily-fetch",
      repeat: { pattern: "5 0 * * *" },
    },
  );
  log.info("scheduled daily FX rate fetch at 00:05 UTC");
}

let cachedWorker: Worker | undefined;

export function createFxWorker(): Worker {
  if (cachedWorker) return cachedWorker;

  cachedWorker = new Worker(
    FX_QUEUE_NAME,
    async (_job: Job) => {
      const today = formatDate(new Date());
      await fetchAndCacheRates(today);
    },
    {
      connection: createBullConnection(),
      concurrency: 1,
    },
  );

  cachedWorker.on("failed", (job, err) => {
    log.error("fx fetch job failed", {
      jobId: job?.id,
      err: err.message,
    });
  });

  log.info("fx worker started", { queue: FX_QUEUE_NAME });
  return cachedWorker;
}
