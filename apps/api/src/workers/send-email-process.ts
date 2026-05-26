// =============================================================
// send-email-process — standalone boot for the BullMQ consumer
// =============================================================
//
// Lighter than send-workers-entry (which boots both email + push
// in one process) — running send-email and send-push in separate
// containers is the recommended deploy shape so they can scale
// independently and so a stuck push transport never starves email.

import { Redis } from "ioredis";
import { getDb } from "@rovenue/db";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { mailer as defaultMailer } from "../lib/mailer";
import { startSendEmailWorker } from "./send-email-worker";

let connection: Redis | null = null;
let worker: ReturnType<typeof startSendEmailWorker> | null = null;

async function main(): Promise<void> {
  connection = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: false,
  });
  connection.on("error", (err: Error) => {
    logger.error("send-email-process.connection", { err: err.message });
  });
  worker = startSendEmailWorker({
    connection,
    db: getDb(),
    mailer: defaultMailer(),
    logger,
  });
  await worker.waitUntilReady();
  logger.info("send-email-process: ready");
}

function attachShutdown(): void {
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      logger.info("send-email-process: shutdown", { sig });
      (async () => {
        try {
          if (worker) await worker.close();
        } catch (err) {
          logger.error("send-email-process: close_failed", {
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
