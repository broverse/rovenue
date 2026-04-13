import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { HEADER } from "@rovenue/shared";
import { redis } from "../lib/redis";
import { logger } from "../lib/logger";

const log = logger.child("rate-limit");
const DEFAULT_PREFIX = "rl";
const ANONYMOUS_ID = "anonymous";

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  keyPrefix?: string;
  identify?: (c: Context) => string;
}

// Sliding-window log limiter backed by a Redis sorted set.
// Fails open on Redis errors so a bad cache doesn't take down the API.
export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  const prefix = options.keyPrefix ?? DEFAULT_PREFIX;

  return async (c, next) => {
    const id =
      options.identify?.(c) ??
      c.req.header(HEADER.X_FORWARDED_FOR)?.split(",")[0]?.trim() ??
      ANONYMOUS_ID;

    const key = `${prefix}:${id}`;
    const now = Date.now();
    const windowStart = now - options.windowMs;

    try {
      const pipeline = redis.multi();
      pipeline.zremrangebyscore(key, 0, windowStart);
      pipeline.zadd(key, now, `${now}-${Math.random()}`);
      pipeline.zcard(key);
      pipeline.pexpire(key, options.windowMs);
      const result = await pipeline.exec();

      const count = (result?.[2]?.[1] as number | undefined) ?? 0;
      const remaining = Math.max(0, options.max - count);

      c.header(HEADER.X_RATE_LIMIT_LIMIT, String(options.max));
      c.header(HEADER.X_RATE_LIMIT_REMAINING, String(remaining));

      if (count > options.max) {
        throw new HTTPException(429, { message: "Too many requests" });
      }
    } catch (err) {
      if (err instanceof HTTPException) throw err;
      log.warn("redis error, failing open", {
        err: err instanceof Error ? err.message : String(err),
      });
    }

    await next();
  };
}
