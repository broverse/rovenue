// =============================================================
// notifier-process — standalone process boot
// =============================================================
//
// Entrypoint for the docker-compose `notifier-worker` service.
// Boots the Kafka consumer that drains `rovenue.notifications`
// into per-channel send queues. Tests don't import this file;
// they call `runNotifier` directly from `./notifier-entry`.

import { logger } from "../lib/logger";
import { runNotifier, stopNotifier } from "./notifier-entry";

async function main(): Promise<void> {
  await runNotifier();
  logger.info("notifier-process: ready");
}

function attachShutdown(): void {
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      logger.info("notifier-process: shutdown", { sig });
      stopNotifier()
        .catch((err) =>
          logger.error("notifier-process: stop_failed", {
            err: err instanceof Error ? err.message : String(err),
          }),
        )
        .finally(() => process.exit(0));
    });
  }
}

attachShutdown();
await main();
