import type { Context, MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { redis } from "../lib/redis";

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  keyPrefix?: string;
  identify?: (c: Context) => string;
}

// Sliding-window log limiter backed by a Redis sorted set.
// Fails open on Redis errors so a bad cache doesn't take down the API.
export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  const prefix = options.keyPrefix ?? "rl";

  return async (c, next) => {
    const id =
      options.identify?.(c) ??
      c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
      "anonymous";

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

      c.header("X-RateLimit-Limit", String(options.max));
      c.header("X-RateLimit-Remaining", String(remaining));

      if (count > options.max) {
        throw new HTTPException(429, { message: "Too many requests" });
      }
    } catch (err) {
      if (err instanceof HTTPException) throw err;
      console.error("[rate-limit] redis error, failing open:", err);
    }

    await next();
  };
}
