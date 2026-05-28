import type { ProviderId, RovenueEventEnvelope } from "../services/integrations/types";

export const INTEGRATIONS_DELIVER_QUEUE_NAME = "rovenue-integrations-deliver";

export const INTEGRATIONS_DELIVER_BACKOFF_MS = [
  30_000, 120_000, 600_000, 3_600_000, 21_600_000,
];

export const INTEGRATIONS_DELIVER_ATTEMPTS = 5;

export interface IntegrationsDeliverJob {
  connectionId: string;
  projectId: string;
  providerId: ProviderId;
  envelope: RovenueEventEnvelope;
  isBackfill?: boolean;
}

export function buildIntegrationsDeliverJobId(
  connectionId: string,
  outboxEventId: string,
): string {
  // BullMQ v5 rejects custom jobIds that contain `:` unless they have
  // exactly 3 colon-delimited segments (the repeatable-job wire format).
  // Use `|` as the separator so the id is URL-safe and BullMQ-safe.
  return `${connectionId}|${outboxEventId}`;
}
