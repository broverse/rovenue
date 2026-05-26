import { assertTopic, getKafka } from "../lib/kafka";
import { logger } from "../lib/logger";
import {
  NOTIFICATIONS_DLQ_TOPIC,
  NOTIFICATIONS_TOPIC,
  startNotifier,
  type NotifyPayload,
} from "./notifier";

// =============================================================
// notifier-entry — standalone process bootstrapper
// =============================================================
//
// This module is the entry-point for the `notifier-worker` Docker
// service. It assembles the Kafka client, registers a noop
// `processMessage` for now, and starts consuming. Task 9.4 swaps the
// noop for `processNotification(deps, payload)` once the core logic
// is in place.

let running: Awaited<ReturnType<typeof startNotifier>> | null = null;

async function defaultProcessMessage(payload: NotifyPayload): Promise<void> {
  // Phase 9.1 ships the transport scaffolding only. Until Task 9.4
  // wires the real handler, log at debug so integration runs can
  // observe the loop without spamming production logs.
  logger.debug("notifier.received", {
    eventKey: payload.eventKey,
    eventId: payload.eventId,
  });
}

export async function runNotifier(
  processMessage: (payload: NotifyPayload) => Promise<void> = defaultProcessMessage,
): Promise<void> {
  const kafka = getKafka();
  if (!kafka) {
    logger.warn("notifier-entry: KAFKA_BROKERS unset, skipping worker");
    return;
  }

  await assertTopic(NOTIFICATIONS_TOPIC);
  await assertTopic(NOTIFICATIONS_DLQ_TOPIC);

  running = await startNotifier({
    kafka,
    logger,
    processMessage,
  });

  logger.info("notifier-entry: started");
}

export async function stopNotifier(): Promise<void> {
  if (!running) return;
  await running.stop();
  running = null;
}
