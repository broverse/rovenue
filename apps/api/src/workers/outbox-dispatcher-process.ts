// =============================================================
// outbox-dispatcher-process — standalone process boot
// =============================================================
//
// Entrypoint for the docker-compose `dispatcher` service. This is the
// SINGLE process permitted to drain outbox_events into Redpanda (the
// single-dispatcher contract; see docs/architecture/outbox-dispatcher.md).
// Extracting the dispatcher into its own one-replica service is what
// lets `api` scale horizontally — every other service sets
// OUTBOX_DISPATCHER_ENABLED=false and never publishes.
//
// Unlike the in-process boot in index.ts, this entrypoint calls
// runOutboxDispatcher() directly and is NOT gated by
// OUTBOX_DISPATCHER_ENABLED — the whole point of the service is to run
// it. runOutboxDispatcher() blocks in its poll loop until
// stopOutboxDispatcher() flips the stop flag, then disconnects the
// Kafka producer cleanly before resolving. Tests drive the loop via
// runOnce() in ./outbox-dispatcher; they never import this file.

import { logger } from "../lib/logger";
import {
  runOutboxDispatcher,
  stopOutboxDispatcher,
} from "./outbox-dispatcher";

function attachShutdown(): void {
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      logger.info("outbox-dispatcher-process: shutdown", { sig });
      // Signals the loop to exit. runOutboxDispatcher() (awaited below)
      // then drains its current tick, disconnects Kafka, and resolves —
      // at which point we exit 0.
      stopOutboxDispatcher();
    });
  }
}

attachShutdown();
await runOutboxDispatcher();
logger.info("outbox-dispatcher-process: stopped");
process.exit(0);
