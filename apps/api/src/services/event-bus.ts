import { drizzle, type Db } from "@rovenue/db";

// =============================================================
// event-bus
// =============================================================
//
// Callers pass a tx-bound Db so the outbox insert lands in the
// same transaction as the caller's OLTP write. For exposures
// (Plan 1) there is no OLTP row — the caller opens a short tx just
// to get a Db handle. The pattern is identical to how the
// revenue-event processor in Plan 2 will work (which does have an
// OLTP row).

export interface PublishExposureInput {
  experimentId: string;
  variantId: string;
  projectId: string;
  subscriberId: string;
  platform?: string | null;
  country?: string | null;
  exposedAt?: Date;
}

async function publishExposure(
  tx: Db,
  input: PublishExposureInput,
): Promise<void> {
  const payload = {
    experimentId: input.experimentId,
    variantId: input.variantId,
    projectId: input.projectId,
    subscriberId: input.subscriberId,
    platform: input.platform ?? null,
    country: input.country ?? null,
    exposedAt: (input.exposedAt ?? new Date()).toISOString(),
  };
  await drizzle.outboxRepo.insert(tx, {
    aggregateType: "EXPOSURE",
    aggregateId: input.experimentId,
    eventType: "experiment.exposure.recorded",
    payload,
  });
}

export const eventBus = { publishExposure };
