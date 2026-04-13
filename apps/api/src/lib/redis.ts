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
