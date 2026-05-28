import type { ClickHouseClient } from "@clickhouse/client";
import type { Db } from "@rovenue/db";
import {
  AppleServerApiError,
  sendConsumptionInfo,
} from "../apple/apple-server-api";
import type { ProjectAppleContext } from "../apple/apple-auth";
import {
  mapToConsumptionRequest,
  type ConsumptionRequest,
} from "../apple/refund-shield-buckets";
import { aggregateRefundShieldSignals } from "./aggregate-signals";

// =============================================================
// Refund Shield — per-row processor
// =============================================================
//
// Glues T7 (bucket map), T8 (Apple Server API client), and T12
// (signal aggregation) into the worker loop's hot path. One call
// per `refund_shield_responses` row; returns a discriminated
// `ProcessOutcome` so the worker (T14) can decide how to persist
// the result without re-running any of the business logic.
//
// Control flow:
//   1. SLA gate FIRST — Apple gives us 12h after the
//      CONSUMPTION_REQUEST notification to respond. If we're past
//      that, fail-fast with no DB/CH/Apple traffic; the worker
//      will mark the row FAILED with error=SLA_EXCEEDED.
//   2. Defensive subscriberId check — the webhook handler (T10)
//      already inserts SKIPPED_NOT_FOUND for unknown subscribers,
//      so the worker should never see a NULL subscriberId. We
//      still guard here in case of operator-issued retries.
//   3. Aggregate → map → send. Apple returns 202 on accepted
//      submission; anything else throws `AppleServerApiError`.
//   4. Error triage:
//        - 5xx (or network failure with statusCode=0/undefined)
//          → RETRY with exponential backoff + jitter.
//        - 4xx → FAILED, since the payload is structurally wrong
//          and replaying it won't help.
//
// Backoff table is fixed and intentionally aggressive (1m → 6h)
// so we still fit ~5 retries inside the 12h SLA window. After
// `retryCount` exceeds the table, we clamp to the last bucket
// (6h) — the SLA gate will eventually short-circuit anyway.

const SLA_MS = 12 * 60 * 60 * 1000;

/**
 * Exponential backoff schedule between retries. 5 buckets that
 * fit comfortably inside the 12h SLA: 1m, 5m, 30m, 2h, 6h.
 */
const BACKOFFS_MS = [
  60_000, //  1 minute
  300_000, //  5 minutes
  1_800_000, // 30 minutes
  7_200_000, //  2 hours
  21_600_000, //  6 hours
];

const JITTER_MAX_MS = 30_000;

export type ProcessOutcome =
  | { status: "SENT"; payload: ConsumptionRequest; httpStatus: 202 }
  | {
      status: "FAILED";
      error: string;
      httpStatus?: number;
      responseBody?: string;
    }
  | { status: "RETRY"; retryDelayMs: number; error: string };

/**
 * Subset of `refund_shield_responses` columns the processor needs.
 * Declared structurally (rather than re-exporting from the schema)
 * to keep the unit tests free of Drizzle imports.
 */
export interface RefundShieldRow {
  id: string;
  projectId: string;
  subscriberId: string | null;
  appleNotificationUuid: string;
  appleOriginalTransactionId: string;
  appleTransactionId: string;
  detectedAt: Date;
  scheduledFor: Date;
  status: string;
  retryCount: number;
}

export interface ProcessInput {
  row: RefundShieldRow;
  ctx: ProjectAppleContext;
  customerConsented: boolean;
  db: Db;
  ch: ClickHouseClient;
  now: Date;
}

/**
 * Process a single `refund_shield_responses` row end-to-end:
 * aggregate signals, map to Apple's `ConsumptionRequest`, POST,
 * and return a discriminated outcome.
 */
export async function processRefundShieldResponse(
  input: ProcessInput,
): Promise<ProcessOutcome> {
  // 1. SLA gate (before any DB/CH/Apple traffic).
  if (input.now.getTime() - input.row.detectedAt.getTime() > SLA_MS) {
    return { status: "FAILED", error: "SLA_EXCEEDED" };
  }

  // 2. Defensive subscriberId check. The webhook handler is the
  //    primary guard (it inserts SKIPPED_NOT_FOUND for unknown
  //    subscribers before the row ever reaches the worker), but
  //    operators occasionally re-queue rows by hand.
  if (!input.row.subscriberId) {
    return { status: "FAILED", error: "MISSING_SUBSCRIBER_ID" };
  }

  // 3. Aggregate signals + map.
  const signals = await aggregateRefundShieldSignals({
    db: input.db,
    ch: input.ch,
    projectId: input.row.projectId,
    subscriberId: input.row.subscriberId,
    originalTransactionId: input.row.appleOriginalTransactionId,
    customerConsented: input.customerConsented,
    now: input.now,
  });
  const payload = mapToConsumptionRequest(signals);

  // 4. POST to Apple + triage.
  try {
    const res = await sendConsumptionInfo(
      input.ctx,
      input.row.appleTransactionId,
      payload,
    );
    return { status: "SENT", payload, httpStatus: res.status };
  } catch (err) {
    // We read `status`/`bodyPreview` off the error directly rather
    // than via `instanceof AppleServerApiError`, because vitest's
    // `vi.mock` replaces the imported class with a per-test stub
    // and `instanceof` would silently miss the match. The shape
    // check is safe — both the real error and any thrown plain
    // Error with `.status` are handled uniformly.
    const e = err as Partial<AppleServerApiError> & {
      status?: number;
      bodyPreview?: string;
      message?: string;
    };
    const statusCode = typeof e.status === "number" ? e.status : 0;
    const message = e.message ?? "unknown";

    // 5xx and unknown/network errors → retry with backoff.
    if (statusCode === 0 || statusCode >= 500) {
      const idx = Math.min(input.row.retryCount, BACKOFFS_MS.length - 1);
      const jitter = Math.floor(Math.random() * JITTER_MAX_MS);
      return {
        status: "RETRY",
        retryDelayMs: BACKOFFS_MS[idx] + jitter,
        error: message,
      };
    }

    // 4xx → terminal failure.
    return {
      status: "FAILED",
      error: `apple_${statusCode}: ${message}`,
      httpStatus: statusCode,
      responseBody: e.bodyPreview,
    };
  }
}
