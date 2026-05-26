// =============================================================
// digest-scheduler-process — standalone boot
// =============================================================
//
// Entrypoint for the docker-compose `digest-scheduler` service.
// Registers the hourly + Monday-09:00 repeatable jobs once,
// then starts the BullMQ worker that runs the per-tick handlers.

import { logger } from "../lib/logger";
import {
  scheduleDigestTicks,
  startDigestScheduler,
  stopDigestScheduler,
} from "./digest-scheduler-entry";

async function main(): Promise<void> {
  await scheduleDigestTicks();
  startDigestScheduler();
  logger.info("digest-scheduler-process: ready");
}

function attachShutdown(): void {
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      logger.info("digest-scheduler-process: shutdown", { sig });
      stopDigestScheduler()
        .catch((err) =>
          logger.error("digest-scheduler-process: stop_failed", {
            err: err instanceof Error ? err.message : String(err),
          }),
        )
        .finally(() => process.exit(0));
    });
  }
}

attachShutdown();
await main();
