import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { HEADER } from "@rovenue/shared";
import { redis } from "../lib/redis";
import { logger } from "../lib/logger";

const log = logger.child("rate-limit");

const DEFAULT_PREFIX = "rl";
const ANONYMOUS_ID = "anonymous";
const RESET_HEADER = "X-RateLimit-Reset";
const RETRY_AFTER_HEADER = "Retry-After";

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  keyPrefix?: string;
  /**
   * Compute the bucket identifier for the request. Defaults to the
   * first hop in x-forwarded-for, or "anonymous" if no forwarded
   * header is present.
   */
  identify?: (c: Context) => string;
}

function clientIp(c: Context): string {
  return (
    c.req.header(HEADER.X_FORWARDED_FOR)?.split(",")[0]?.trim() ||
    ANONYMOUS_ID
  );
}

function rateLimitedResponse(
  retryAfterSeconds: number,
  extraHeaders: Record<string, string> = {},
): Response {
  return new Response(
    JSON.stringify({
      error: { code: "RATE_LIMITED", message: "Too many requests" },
    }),
    {
      status: 429,
      headers: {
        "content-type": "application/json",
        [RETRY_AFTER_HEADER]: String(retryAfterSeconds),
        ...extraHeaders,
      },
    },
  );
}

// =============================================================
// Sliding-window Redis limiter backed by a sorted set.
//
// Every request adds an entry scored by the current timestamp.
// Entries older than the window are evicted before counting, so
// limits apply to any rolling `windowMs` — no bucket edge effects
// where a client can burst 2× the limit across a window boundary.
//
// Fails open on Redis errors: losing the cache must not take down
// the API.
// =============================================================

export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  const prefix = options.keyPrefix ?? DEFAULT_PREFIX;

  return async (c, next) => {
    const id = options.identify?.(c) ?? clientIp(c);
    const key = `${prefix}:${id}`;
    const now = Date.now();
    const windowStart = now - options.windowMs;

    try {
      const pipeline = redis.multi();
      pipeline.zremrangebyscore(key, 0, windowStart);
      pipeline.zadd(key, now, `${now}-${Math.random()}`);
      pipeline.zcard(key);
      pipeline.zrange(key, 0, 0, "WITHSCORES");
      pipeline.pexpire(key, options.windowMs);
      const result = await pipeline.exec();

      const count = (result?.[2]?.[1] as number | undefined) ?? 0;
      const oldestEntry = result?.[3]?.[1] as string[] | undefined;
      const oldestScore =
        oldestEntry && oldestEntry.length >= 2 ? Number(oldestEntry[1]) : now;

      const remaining = Math.max(0, options.max - count);
      const resetMs = oldestScore + options.windowMs;
      const resetSeconds = Math.ceil(resetMs / 1000);

      c.header(HEADER.X_RATE_LIMIT_LIMIT, String(options.max));
      c.header(HEADER.X_RATE_LIMIT_REMAINING, String(remaining));
      c.header(RESET_HEADER, String(resetSeconds));

      if (count > options.max) {
        const retryAfter = Math.max(1, Math.ceil((resetMs - now) / 1000));
        const response = rateLimitedResponse(retryAfter, {
          [HEADER.X_RATE_LIMIT_LIMIT]: String(options.max),
          [HEADER.X_RATE_LIMIT_REMAINING]: "0",
          [RESET_HEADER]: String(resetSeconds),
        });
        throw new HTTPException(429, { res: response });
      }
    } catch (err) {
      if (err instanceof HTTPException) throw err;
      log.warn("redis error, falling back to insurance limiter", {
        err: err instanceof Error ? err.message : String(err),
      });
      const { insuranceConsume } = await import("./insurance-rate-limit");
      if (!insuranceConsume(key)) {
        const response = rateLimitedResponse(60);
        throw new HTTPException(429, { res: response });
      }
    }

    await next();
  };
}

// =============================================================
// Preset factories
// =============================================================
//
// Composable layers for the standard request pipeline:
//   1. `globalIpRateLimit` — DDoS absorb, per IP, applied at the
//      top-level app
//   2. `apiKeyRateLimit` — per-project envelope, applied after
//      apiKeyAuth on /v1
//   3. `endpointRateLimit` — heavy per-endpoint guard, applied
//      at the route level with a custom identifier

const MINUTE_MS = 60_000;

/** 1000 req/min per client IP — global DDoS guard. */
export function globalIpRateLimit(): MiddlewareHandler {
  return rateLimit({
    windowMs: MINUTE_MS,
    max: 1000,
    keyPrefix: "rl:global:ip",
  });
}

/** 500 req/min per authenticated API key — per-project envelope. */
export function apiKeyRateLimit(): MiddlewareHandler {
  return rateLimit({
    windowMs: MINUTE_MS,
    max: 500,
    keyPrefix: "rl:key",
    identify: (c) => c.get("project")?.apiKeyId ?? clientIp(c),
  });
}

/** 300 req/min per authenticated dashboard user — per-tenant-human envelope. */
export function dashboardUserRateLimit(): MiddlewareHandler {
  return rateLimit({
    windowMs: MINUTE_MS,
    max: 300,
    keyPrefix: "rl:dashboard:user",
    identify: (c) => c.get("user")?.id ?? clientIp(c),
  });
}

export interface EndpointRateLimitOptions {
  max: number;
  windowMs?: number;
  name: string;
  identify?: (c: Context) => string;
}

/**
 * Route-scoped limiter. Defaults to 1 minute windows and the
 * authenticated API key as the bucket identifier.
 */
export function endpointRateLimit(
  opts: EndpointRateLimitOptions,
): MiddlewareHandler {
  return rateLimit({
    windowMs: opts.windowMs ?? MINUTE_MS,
    max: opts.max,
    keyPrefix: `rl:endpoint:${opts.name}`,
    identify:
      opts.identify ?? ((c) => c.get("project")?.apiKeyId ?? clientIp(c)),
  });
}
