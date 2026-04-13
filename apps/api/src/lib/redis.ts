import { Redis } from "ioredis";
import { env } from "./env";

export const redis = new Redis(env.REDIS_URL, {
  lazyConnect: true,
  maxRetriesPerRequest: 3,
  enableOfflineQueue: false,
});

redis.on("error", (err) => {
  console.error("[redis] connection error:", err.message);
});
