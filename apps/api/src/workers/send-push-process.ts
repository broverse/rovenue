// =============================================================
// send-push-process — standalone boot for the BullMQ consumer
// =============================================================
//
// Separate process from send-email so APNs HTTP/2 session state
// and FCM token caching don't share fate with SES throughput.

import { Redis } from "ioredis";
import { getDb } from "@rovenue/db";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { createPushTransports } from "../lib/push";
import { startSendPushWorker } from "./send-push-worker";

let connection: Redis | null = null;
let worker: ReturnType<typeof startSendPushWorker> | null = null;

async function main(): Promise<void> {
  connection = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: false,
  });
  connection.on("error", (err: Error) => {
    logger.error("send-push-process.connection", { err: err.message });
  });
  const transports = createPushTransports(env);
  if (!transports.ios && !transports.android) {
    logger.warn(
      "send-push-process: no push transports configured (APNS_* / FCM_*)",
    );
  }
  worker = startSendPushWorker({
    connection,
    db: getDb(),
    transports,
    logger,
  });
  await worker.waitUntilReady();
  logger.info("send-push-process: ready");
}

function attachShutdown(): void {
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      logger.info("send-push-process: shutdown", { sig });
      (async () => {
        try {
          if (worker) await worker.close();
        } catch (err) {
          logger.error("send-push-process: close_failed", {
            err: err instanceof Error ? err.message : String(err),
          });
        }
        connection?.disconnect();
        process.exit(0);
      })();
    });
  }
}

attachShutdown();
await main();
