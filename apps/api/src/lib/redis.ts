import { Redis } from "ioredis";
import { env } from "./env";
import { logger } from "./logger";

const log = logger.child("redis");

export const redis = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
  enableOfflineQueue: false,
});

redis.on("error", (err: Error) => {
  log.error("connection error", { err: err.message });
});

// =============================================================
// Managed connection factories
// =============================================================
// Every ioredis connection MUST have an `error` listener: Node throws on an
// unhandled 'error' event, so a single Redis blip on a listener-less
// connection crashes the whole process. These factories are the only
// sanctioned way to open additional connections — they always attach the
// listener. Do not call `new Redis(...)` / `.duplicate()` directly.

/** Attach the mandatory error listener to a connection created elsewhere
 * (e.g. `redis.duplicate()` — duplicates do NOT inherit listeners). */
export function attachRedisErrorLogger<T extends Redis>(conn: T, label: string): T {
  conn.on("error", (err: Error) => {
    log.error(`${label} connection error`, { err: err.message });
  });
  return conn;
}

/** Dedicated connection for a BullMQ Queue/Worker. BullMQ requires
 * `maxRetriesPerRequest: null` for its blocking commands. */
export function createBullConnection(label: string): Redis {
  return attachRedisErrorLogger(
    new Redis(env.REDIS_URL, {
      maxRetriesPerRequest: null,
      lazyConnect: false,
    }),
    label,
  );
}
