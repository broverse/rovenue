import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { redis } from "../lib/redis";
import { env } from "../lib/env";
import { logger } from "../lib/logger";

// =============================================================
// Currency conversion with layered caching
// =============================================================
//
// Rates are stored in Redis under two key patterns:
//
//   fx:{date}:{from}:USD  → rate for a specific day
//   fx:latest:{from}:USD  → most recent rate (fallback)
//
// `convertToUsd` checks date-specific → latest → static table.
// Every Redis read is wrapped in a try/catch so a cache outage
// degrades to the built-in static rates — never blocks revenue
// recording.
//
// A BullMQ repeatable job fetches fresh rates daily at 00:05 UTC
// from api.exchangerate.host (free, no API key required).
//
// RevenueCat difference: we use the exchange rate from the
// purchase date, not the report date. The original amount +
// currency are always preserved in the RevenueEvent row.

const log = logger.child("fx");

// =============================================================
// Static fallback rates (snapshot 2026-04)
// =============================================================

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

const SUPPORTED_CURRENCIES = Object.keys(STATIC_USD_RATES).filter(
  (c) => c !== "USD",
);

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
): Promise<number> {
  const upper = currency.toUpperCase();
  if (upper === "USD") return amount;

  const dateStr = date ? formatDate(date) : formatDate(new Date());

  // 1. Date-specific cache
  try {
    const cached = await redis.get(dateKey(dateStr, upper));
    if (cached) return amount * parseFloat(cached);
  } catch {
    // fall through
  }

  // 2. Latest cache
  try {
    const latest = await redis.get(latestKey(upper));
    if (latest) return amount * parseFloat(latest);
  } catch {
    // fall through
  }

  // 3. Static fallback
  const staticRate = STATIC_USD_RATES[upper];
  if (staticRate !== undefined) return amount * staticRate;

  // 4. Unknown currency — pass through 1:1 to avoid zeroing
  return amount;
}

// =============================================================
// Fetch rates from API + cache
// =============================================================
//
// Uses open.er-api.com — free, no API key, daily update. Always
// returns the latest rates; `dateStr` is used as the cache bucket
// key (so yesterday's recorded rate isn't clobbered by today's
// fetch), not as an API parameter.

const API_BASE = "https://open.er-api.com/v6/latest/USD";
export const FX_LAST_SUCCESS_KEY = "fx:last-success-at";

export async function fetchAndCacheRates(
  dateStr: string,
  fetchFn: typeof globalThis.fetch = globalThis.fetch,
): Promise<void> {
  let rates: Record<string, number>;
  try {
    const res = await fetchFn(API_BASE);
    if (!res.ok) {
      log.warn("fx API returned non-ok", { status: (res as Response).status, dateStr });
      return;
    }
    const data = (await res.json()) as {
      result?: string;
      success?: boolean;
      base?: string;
      base_code?: string;
      rates?: Record<string, number>;
      quotes?: Record<string, number>;
    };
    rates = data.rates ?? data.quotes ?? {};
    const ok = data.result === "success" || data.success === true || Object.keys(rates).length > 0;
    if (!ok) {
      log.warn("fx API returned unsuccessful payload", { dateStr });
      return;
    }
  } catch (err) {
    log.warn("fx API fetch failed", {
      dateStr,
      err: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  // Rates come as foreign-per-USD (e.g. USDEUR=0.93).
  // We store USD-per-foreign (1/rate) so multiply is amount * storedRate.
  const entries: Array<[string, string]> = [];
  for (const [rawKey, foreignPerUsd] of Object.entries(rates)) {
    const from = rawKey.replace(/^USD/, "").toUpperCase();
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
