import type { MiddlewareHandler } from "hono";

export interface RateLimitOptions {
  windowMs: number;
  max: number;
  keyPrefix?: string;
}

// TODO: implement Redis-backed sliding window limiter using ioredis/BullMQ
// For now this is a no-op placeholder so routes can declare their intent.
export function rateLimit(_options: RateLimitOptions): MiddlewareHandler {
  return async (_c, next) => {
    await next();
  };
}
