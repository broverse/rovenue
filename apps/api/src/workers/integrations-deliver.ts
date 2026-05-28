// =============================================================
// integrations-deliver worker
// =============================================================
//
// M2.4 — pure `runDeliverStep` function with full DI (unit-testable).
// M2.5 — `ensureIntegrationsDeliverWorker` wires the BullMQ Worker
//         with real Redis + DB-backed deps.
//
// The worker decrypts provider credentials, calls the provider's
// `mapEvent` + `deliver`, and writes `integration_deliveries` rows.
//
// The `autoStart: false` path returns immediately without touching
// Redis, which keeps unit tests fast.

import { createId } from "@paralleldrive/cuid2";
import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { getDb, drizzle } from "@rovenue/db";
import { decrypt } from "@rovenue/shared/crypto";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import {
  INTEGRATIONS_DELIVER_ATTEMPTS,
  INTEGRATIONS_DELIVER_BACKOFF_MS,
  INTEGRATIONS_DELIVER_QUEUE_NAME,
  type IntegrationsDeliverJob,
} from "../queues/integrations";
import { getProvider } from "../services/integrations/registry";
import { createUndiciHttpClient } from "../services/integrations/http-client";
import type {
  IntegrationConnection,
  IntegrationDelivery,
} from "@rovenue/db";
import type { ProviderCredentials, ProviderId } from "../services/integrations/types";

// =============================================================
// Types
// =============================================================

export type DeliverOutcome =
  | "connection_disabled"
  | "skipped"
  | "succeeded"
  | "failed"
  | "dead_letter";

export interface DeliverStepResult {
  outcome: DeliverOutcome;
  deliveryId?: string;
}

export interface DeliverStepDeps {
  loadConnection: (id: string) => Promise<IntegrationConnection | undefined>;
  decrypt: (cipher: string) => ProviderCredentials;
  insertPendingDelivery: (values: {
    id: string;
    connectionId: string;
    projectId: string;
    providerId: string;
    outboxEventId: string;
    eventKey: string;
    providerEvent?: string | null;
    status: "pending" | "succeeded" | "failed" | "skipped" | "dead_letter";
    attempt: number;
    skipReason?: string | null;
    httpStatus?: number | null;
    responseBody?: string | null;
    errorMessage?: string | null;
  }) => Promise<IntegrationDelivery | undefined>;
  updateDeliveryStatus: (input: {
    id: string;
    createdAt: Date;
    status: "pending" | "succeeded" | "failed" | "skipped" | "dead_letter";
    httpStatus?: number | null;
    responseBody?: string | null;
    errorMessage?: string | null;
    providerEvent?: string | null;
    skipReason?: string | null;
    attempt?: number;
  }) => Promise<IntegrationDelivery>;
  provider: ReturnType<typeof getProvider>;
  http: ReturnType<typeof createUndiciHttpClient>;
  attempt: number;
  publishLiveEvent?: (ev: {
    projectId: string;
    connectionId: string;
    providerId: ProviderId;
    eventKey: string;
    status: "succeeded" | "failed" | "skipped" | "dead_letter";
  }) => Promise<void>;
  auditDeadLetter?: (input: {
    projectId: string;
    connectionId: string;
    outboxEventId: string;
    providerId: ProviderId;
    errorMessage?: string | null;
  }) => Promise<void>;
  captureSentry?: (input: {
    connectionId: string;
    providerId: ProviderId;
    outboxEventId: string;
    errorMessage?: string | null;
  }) => void;
}

// =============================================================
// deriveEventKeyForLog
// =============================================================

export function deriveEventKeyForLog(job: IntegrationsDeliverJob): string {
  return `${job.envelope.eventType}:${job.envelope.outboxEventId}`;
}

// =============================================================
// runDeliverStep — pure, injectable
// =============================================================

export async function runDeliverStep(
  job: IntegrationsDeliverJob,
  deps: DeliverStepDeps,
): Promise<DeliverStepResult> {
  const log = logger.child("integrations-deliver");

  // 1. Load connection
  const conn = await deps.loadConnection(job.connectionId);
  if (!conn || !conn.isEnabled) {
    log.info("connection_disabled", {
      connectionId: job.connectionId,
      eventKey: deriveEventKeyForLog(job),
    });
    return { outcome: "connection_disabled" };
  }

  // 2. Decrypt credentials
  const creds = deps.decrypt(conn.credentialsCipher);

  // 3. Build connection config
  const config = {
    connectionId: conn.id,
    projectId: conn.projectId,
    enabledEvents: (conn.enabledEvents ?? []) as Parameters<typeof deps.provider.mapEvent>[1]["enabledEvents"],
    eventMapping: (conn.eventMapping ?? {}) as Parameters<typeof deps.provider.mapEvent>[1]["eventMapping"],
    actionSource: (conn.actionSource ?? "app") as "app" | "website" | "system_generated",
    testEventCode: conn.testEventCode ?? undefined,
  };

  // 4. Map event
  const mapResult = deps.provider.mapEvent(job.envelope, config, creds);

  if ("skip" in mapResult && mapResult.skip) {
    const deliveryId = createId();
    const row = await deps.insertPendingDelivery({
      id: deliveryId,
      connectionId: conn.id,
      projectId: conn.projectId,
      providerId: conn.providerId,
      outboxEventId: job.envelope.outboxEventId,
      eventKey: job.envelope.eventType,
      status: "skipped",
      attempt: deps.attempt,
      skipReason: mapResult.reason,
    });
    log.info("skipped", {
      connectionId: conn.id,
      reason: mapResult.reason,
      eventKey: deriveEventKeyForLog(job),
    });
    return { outcome: "skipped", deliveryId: row?.id ?? deliveryId };
  }

  const payload = mapResult;

  // 5. Check attempt exhaustion before calling provider
  if (deps.attempt >= INTEGRATIONS_DELIVER_ATTEMPTS) {
    const deliveryId = createId();
    const row = await deps.insertPendingDelivery({
      id: deliveryId,
      connectionId: conn.id,
      projectId: conn.projectId,
      providerId: conn.providerId,
      outboxEventId: job.envelope.outboxEventId,
      eventKey: payload.eventKey,
      providerEvent: payload.providerEvent,
      status: "dead_letter",
      attempt: deps.attempt,
      errorMessage: "max attempts exhausted",
    });
    log.warn("dead_letter_attempts_exhausted", {
      connectionId: conn.id,
      attempt: deps.attempt,
    });
    return { outcome: "dead_letter", deliveryId: row?.id ?? deliveryId };
  }

  // 6. Insert pending delivery
  const deliveryId = createId();
  const pendingRow = await deps.insertPendingDelivery({
    id: deliveryId,
    connectionId: conn.id,
    projectId: conn.projectId,
    providerId: conn.providerId,
    outboxEventId: job.envelope.outboxEventId,
    eventKey: payload.eventKey,
    providerEvent: payload.providerEvent,
    status: "pending",
    attempt: deps.attempt,
  });

  if (!pendingRow) {
    // dedupe — another worker already succeeded (UNIQUE constraint on
    // (connection_id, outbox_event_id, created_at) fired).
    log.info("dedupe_skip", {
      connectionId: conn.id,
      outboxEventId: job.envelope.outboxEventId,
    });
    return { outcome: "succeeded" };
  }

  const rowId = pendingRow.id;
  const rowCreatedAt = pendingRow.createdAt;

  // 7. Deliver
  const result = await deps.provider.deliver(payload, creds, deps.http);

  if (result.ok) {
    await deps.updateDeliveryStatus({
      id: rowId,
      createdAt: rowCreatedAt,
      status: "succeeded",
      httpStatus: result.httpStatus,
      responseBody: result.responseBody,
      providerEvent: payload.providerEvent,
      attempt: deps.attempt,
    });
    if (deps.publishLiveEvent) {
      await deps.publishLiveEvent({
        projectId: conn.projectId,
        connectionId: conn.id,
        providerId: conn.providerId as ProviderId,
        eventKey: payload.eventKey,
        status: "succeeded",
      });
    }
    log.info("succeeded", {
      connectionId: conn.id,
      eventKey: deriveEventKeyForLog(job),
      httpStatus: result.httpStatus,
    });
    return { outcome: "succeeded", deliveryId: rowId };
  }

  // 8. Failed — check retriability
  if (!result.retriable) {
    await deps.updateDeliveryStatus({
      id: rowId,
      createdAt: rowCreatedAt,
      status: "dead_letter",
      httpStatus: result.httpStatus,
      responseBody: result.responseBody,
      errorMessage: result.errorMessage,
      providerEvent: payload.providerEvent,
      attempt: deps.attempt,
    });
    if (deps.publishLiveEvent) {
      await deps.publishLiveEvent({
        projectId: conn.projectId,
        connectionId: conn.id,
        providerId: conn.providerId as ProviderId,
        eventKey: payload.eventKey,
        status: "dead_letter",
      });
    }
    if (deps.auditDeadLetter) {
      await deps.auditDeadLetter({
        projectId: conn.projectId,
        connectionId: conn.id,
        outboxEventId: job.envelope.outboxEventId,
        providerId: conn.providerId as ProviderId,
        errorMessage: result.errorMessage,
      });
    }
    if (deps.captureSentry) {
      deps.captureSentry({
        connectionId: conn.id,
        providerId: conn.providerId as ProviderId,
        outboxEventId: job.envelope.outboxEventId,
        errorMessage: result.errorMessage,
      });
    }
    log.warn("dead_letter_non_retriable", {
      connectionId: conn.id,
      httpStatus: result.httpStatus,
      errorMessage: result.errorMessage,
    });
    return { outcome: "dead_letter", deliveryId: rowId };
  }

  // Retriable failure — update status to failed so the row is visible,
  // then throw so BullMQ applies the backoff and retries.
  await deps.updateDeliveryStatus({
    id: rowId,
    createdAt: rowCreatedAt,
    status: "failed",
    httpStatus: result.httpStatus,
    responseBody: result.responseBody,
    errorMessage: result.errorMessage,
    providerEvent: payload.providerEvent,
    attempt: deps.attempt,
  });
  log.warn("failed_retriable", {
    connectionId: conn.id,
    httpStatus: result.httpStatus,
    attempt: deps.attempt,
  });
  throw new Error(result.errorMessage ?? `HTTP ${result.httpStatus}`);
}

// =============================================================
// ensureIntegrationsDeliverWorker — BullMQ wiring (M2.5)
// =============================================================

export interface WorkerHandle {
  stop: () => Promise<void>;
}

export interface WorkerOptions {
  autoStart?: boolean;
}

export async function ensureIntegrationsDeliverWorker(
  opts: WorkerOptions = {},
): Promise<WorkerHandle> {
  const { autoStart = true } = opts;

  if (!autoStart) {
    return { stop: async () => {} };
  }

  const log = logger.child("integrations-deliver-worker");
  const connection = new Redis(env.REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: null, // required by BullMQ
    enableOfflineQueue: false,
  });

  const http = createUndiciHttpClient();

  const worker = new Worker<IntegrationsDeliverJob>(
    INTEGRATIONS_DELIVER_QUEUE_NAME,
    async (bullJob: Job<IntegrationsDeliverJob>) => {
      const job = bullJob.data;
      const attempt = bullJob.attemptsMade ?? 0;

      const db = getDb();
      const { integrationConnectionRepo, integrationDeliveryRepo } = drizzle;

      const deps: DeliverStepDeps = {
        loadConnection: (id) => integrationConnectionRepo.getConnection(db, id),
        decrypt: (cipher) =>
          JSON.parse(decrypt(cipher, env.ENCRYPTION_KEY ?? "")) as ProviderCredentials,
        insertPendingDelivery: (values) =>
          integrationDeliveryRepo.insertPendingDelivery(db, values as Parameters<typeof integrationDeliveryRepo.insertPendingDelivery>[1]),
        updateDeliveryStatus: (input) =>
          integrationDeliveryRepo.updateDeliveryStatus(db, input),
        provider: getProvider(job.providerId),
        http,
        attempt,
      };

      await runDeliverStep(job, deps);
    },
    {
      connection,
      concurrency: 10,
      settings: {
        backoffStrategy: (attempt) => {
          const idx = Math.min(attempt - 1, INTEGRATIONS_DELIVER_BACKOFF_MS.length - 1);
          return INTEGRATIONS_DELIVER_BACKOFF_MS[idx] ?? INTEGRATIONS_DELIVER_BACKOFF_MS[INTEGRATIONS_DELIVER_BACKOFF_MS.length - 1]!;
        },
      },
      defaultJobOptions: {
        attempts: INTEGRATIONS_DELIVER_ATTEMPTS,
        backoff: { type: "custom" },
        removeOnComplete: { count: 200, age: 24 * 60 * 60 },
        removeOnFail: { count: 1000, age: 7 * 24 * 60 * 60 },
      },
    },
  );

  worker.on("failed", (bullJob, err) => {
    log.warn("job_failed", {
      jobId: bullJob?.id,
      connectionId: bullJob?.data?.connectionId,
      err: err instanceof Error ? err.message : String(err),
      attempt: bullJob?.attemptsMade,
    });
  });

  worker.on("error", (err) => {
    log.error("worker_error", { err: err instanceof Error ? err.message : String(err) });
  });

  log.info("started", {
    queue: INTEGRATIONS_DELIVER_QUEUE_NAME,
    concurrency: 10,
  });

  return {
    stop: async () => {
      await worker.close();
      await connection.quit();
      log.info("stopped");
    },
  };
}
