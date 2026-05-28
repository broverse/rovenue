import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// Mocking strategy
// =============================================================
//
// The polling worker glues together: repo (`claimPendingResponses`
// + outcome writers), project loader, Apple-context loader, and
// the T13 processor. Each is unit-tested independently — these
// tests only re-exercise the *control flow* the worker adds:
//
//   - re-verify project enabled before processing
//   - skip rows with NULL subscriberId
//   - persist SENT / RETRY / FAILED outcomes via repo writers
//
// We mock at module boundaries (db package, processor module,
// credentials helper) so the worker code under test is pure.
//
// Concurrency: we don't spin up two real transactions here.
// Instead we assert the worker calls `claimPendingResponses` with
// `FOR UPDATE SKIP LOCKED` semantics (the repo function's contract)
// inside a `db.transaction`. Real-MVCC behaviour is covered by the
// repo's own SQL — a structural assertion is enough at this layer.

const claimPendingResponsesMock = vi.fn();
const markResponseSentMock = vi.fn();
const markResponseRetryMock = vi.fn();
const markResponseFailedMock = vi.fn();
const markResponseSkippedMock = vi.fn();
const findProjectByIdMock = vi.fn();
const dbTransactionMock = vi.fn();

vi.mock("@rovenue/db", () => ({
  drizzle: {
    db: {
      transaction: (...args: unknown[]) => dbTransactionMock(...args),
    },
    refundShieldResponseRepo: {
      claimPendingResponses: (...args: unknown[]) =>
        claimPendingResponsesMock(...args),
      markResponseSent: (...args: unknown[]) => markResponseSentMock(...args),
      markResponseRetry: (...args: unknown[]) => markResponseRetryMock(...args),
      markResponseFailed: (...args: unknown[]) =>
        markResponseFailedMock(...args),
      markResponseSkipped: (...args: unknown[]) =>
        markResponseSkippedMock(...args),
    },
    projectRepo: {
      findProjectById: (...args: unknown[]) => findProjectByIdMock(...args),
    },
  },
}));

const processRefundShieldResponseMock = vi.fn();
vi.mock("../services/refund-shield/process-response", () => ({
  processRefundShieldResponse: (...args: unknown[]) =>
    processRefundShieldResponseMock(...args),
}));

const loadAppleCredentialsMock = vi.fn();
vi.mock("../lib/project-credentials", () => ({
  loadAppleCredentials: (...args: unknown[]) => loadAppleCredentialsMock(...args),
}));

const getClickHouseClientMock = vi.fn();
vi.mock("../lib/clickhouse", () => ({
  getClickHouseClient: (...args: unknown[]) => getClickHouseClientMock(...args),
}));

// Audit helper. We intercept at the module boundary so we can assert
// the worker emits a chained row on terminal SENT / FAILED without
// standing up Postgres.
const auditMock = vi.fn(async () => undefined);
vi.mock("../lib/audit", () => ({
  audit: (...args: unknown[]) => auditMock(...args),
}));

import {
  BATCH_SIZE,
  MAX_RETRIES,
  runRefundShieldResponderTick,
} from "./refund-shield-responder";
import { __testing as metricsTesting } from "../lib/metrics-refund-shield";

// ----- Test fixtures -----

const NOW = new Date("2026-05-28T02:00:00Z");

function makeRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "row_1",
    projectId: "proj_1",
    subscriberId: "sub_1",
    appleNotificationUuid: "uuid-1",
    appleOriginalTransactionId: "tx_original",
    appleTransactionId: "tx_apple",
    detectedAt: new Date("2026-05-28T01:00:00Z"),
    scheduledFor: new Date("2026-05-28T01:30:00Z"),
    status: "PENDING",
    retryCount: 0,
    ...overrides,
  };
}

function makeProject(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "proj_1",
    refundShieldEnabled: true,
    refundShieldConsentAcknowledgedAt: new Date("2026-05-01"),
    ...overrides,
  };
}

const APPLE_CREDS = {
  bundleId: "com.example.app",
  keyId: "ABCDEFGHIJ",
  issuerId: "00000000-0000-0000-0000-000000000000",
  privateKey: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----\n",
};

const FAKE_PAYLOAD = {
  customerConsented: 1,
  refundPreference: 2,
} as const;

// Stand-in tx the worker's `db.transaction` callback will receive.
// We pass it through to every repo mock so we can assert it.
const FAKE_TX = { __tx: true } as unknown as never;

beforeEach(() => {
  claimPendingResponsesMock.mockReset();
  markResponseSentMock.mockReset();
  markResponseRetryMock.mockReset();
  markResponseFailedMock.mockReset();
  markResponseSkippedMock.mockReset();
  findProjectByIdMock.mockReset();
  processRefundShieldResponseMock.mockReset();
  loadAppleCredentialsMock.mockReset();
  getClickHouseClientMock.mockReset();
  dbTransactionMock.mockReset();

  // Default: db.transaction proxies through with our fake tx.
  dbTransactionMock.mockImplementation(
    async (fn: (tx: typeof FAKE_TX) => Promise<void>) => fn(FAKE_TX),
  );
  // Default: ClickHouse returns a stub object.
  getClickHouseClientMock.mockReturnValue({ __ch: true });
  // Default: Apple creds present.
  loadAppleCredentialsMock.mockResolvedValue(APPLE_CREDS);
  auditMock.mockReset();
  auditMock.mockResolvedValue(undefined);
  metricsTesting.reset();
});

describe("runRefundShieldResponderTick", () => {
  it("happy path: SENT outcome persists status + httpStatus", async () => {
    claimPendingResponsesMock.mockResolvedValueOnce([makeRow()]);
    findProjectByIdMock.mockResolvedValueOnce(makeProject());
    processRefundShieldResponseMock.mockResolvedValueOnce({
      status: "SENT",
      payload: FAKE_PAYLOAD,
      httpStatus: 202,
    });

    await runRefundShieldResponderTick({ now: NOW });

    expect(processRefundShieldResponseMock).toHaveBeenCalledTimes(1);
    expect(markResponseSentMock).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({
        id: "row_1",
        appleHttpStatus: 202,
        sentAt: NOW,
        requestPayload: FAKE_PAYLOAD,
      }),
    );
    expect(markResponseRetryMock).not.toHaveBeenCalled();
    expect(markResponseFailedMock).not.toHaveBeenCalled();
  });

  it("RETRY outcome bumps retryCount and shifts scheduledFor", async () => {
    const row = makeRow({ retryCount: 1 });
    claimPendingResponsesMock.mockResolvedValueOnce([row]);
    findProjectByIdMock.mockResolvedValueOnce(makeProject());
    processRefundShieldResponseMock.mockResolvedValueOnce({
      status: "RETRY",
      retryDelayMs: 300_000,
      error: "apple 503",
    });

    await runRefundShieldResponderTick({ now: NOW });

    expect(markResponseRetryMock).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({
        id: "row_1",
        retryCount: 2,
        scheduledFor: new Date(NOW.getTime() + 300_000),
        error: "apple 503",
      }),
    );
    expect(markResponseSentMock).not.toHaveBeenCalled();
    expect(markResponseFailedMock).not.toHaveBeenCalled();
  });

  it("FAILED outcome persists error + httpStatus", async () => {
    claimPendingResponsesMock.mockResolvedValueOnce([makeRow()]);
    findProjectByIdMock.mockResolvedValueOnce(makeProject());
    processRefundShieldResponseMock.mockResolvedValueOnce({
      status: "FAILED",
      error: "apple_400: bad request",
      httpStatus: 400,
      responseBody: "{\"errorCode\": 4000023}",
    });

    await runRefundShieldResponderTick({ now: NOW });

    expect(markResponseFailedMock).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({
        id: "row_1",
        error: "apple_400: bad request",
        appleHttpStatus: 400,
        appleResponseBody: "{\"errorCode\": 4000023}",
      }),
    );
    expect(markResponseSentMock).not.toHaveBeenCalled();
    expect(markResponseRetryMock).not.toHaveBeenCalled();
  });

  it("skips rows whose project has refund_shield_enabled=false", async () => {
    claimPendingResponsesMock.mockResolvedValueOnce([makeRow()]);
    findProjectByIdMock.mockResolvedValueOnce(
      makeProject({ refundShieldEnabled: false }),
    );

    await runRefundShieldResponderTick({ now: NOW });

    expect(processRefundShieldResponseMock).not.toHaveBeenCalled();
    expect(markResponseSkippedMock).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({
        id: "row_1",
        status: "SKIPPED_DISABLED",
      }),
    );
  });

  it("transitions to FAILED:MAX_RETRIES_EXHAUSTED on final retry", async () => {
    // retryCount === MAX_RETRIES - 1 means this would be the
    // last attempt. The claim query filters `retry_count < 5`,
    // so leaving the row PENDING with retryCount === 5 would
    // strand it forever — the worker must coerce to FAILED.
    const row = makeRow({ retryCount: MAX_RETRIES - 1 });
    claimPendingResponsesMock.mockResolvedValueOnce([row]);
    findProjectByIdMock.mockResolvedValueOnce(makeProject());
    processRefundShieldResponseMock.mockResolvedValueOnce({
      status: "RETRY",
      retryDelayMs: 60_000,
      error: "apple 503",
    });

    await runRefundShieldResponderTick({ now: NOW });

    expect(markResponseFailedMock).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({
        id: "row_1",
        error: expect.stringContaining("MAX_RETRIES_EXHAUSTED"),
      }),
    );
    expect(markResponseRetryMock).not.toHaveBeenCalled();
    expect(markResponseSentMock).not.toHaveBeenCalled();
  });

  it("SENT outcome emits sent counter + sla histogram + audit", async () => {
    const row = makeRow();
    claimPendingResponsesMock.mockResolvedValueOnce([row]);
    findProjectByIdMock.mockResolvedValueOnce(makeProject());
    processRefundShieldResponseMock.mockResolvedValueOnce({
      status: "SENT",
      payload: FAKE_PAYLOAD,
      httpStatus: 202,
    });

    await runRefundShieldResponderTick({ now: NOW });

    const snap = metricsTesting.snapshot();
    expect(snap.sent).toEqual({ proj_1: 1 });
    expect(snap.failed).toEqual({});
    // SLA: detectedAt = 01:00Z, now = 02:00Z, 12h SLA = 11h left = 39600s.
    expect(snap.slaRemainingSamples).toHaveLength(1);
    expect(snap.slaRemainingSamples[0]).toMatchObject({
      projectId: "proj_1",
      seconds: 11 * 3600,
    });
    expect(auditMock).toHaveBeenCalledTimes(1);
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "proj_1",
        userId: "system",
        action: "refund_shield.response.sent",
        resource: "refund_shield_response",
        resourceId: "row_1",
      }),
      FAKE_TX,
    );
  });

  it("FAILED outcome emits failed counter with reason label + audit", async () => {
    claimPendingResponsesMock.mockResolvedValueOnce([makeRow()]);
    findProjectByIdMock.mockResolvedValueOnce(makeProject());
    processRefundShieldResponseMock.mockResolvedValueOnce({
      status: "FAILED",
      error: "apple_400: bad request",
      httpStatus: 400,
      responseBody: "{\"errorCode\": 4000023}",
    });

    await runRefundShieldResponderTick({ now: NOW });

    const snap = metricsTesting.snapshot();
    expect(snap.failed).toEqual({ "proj_1::apple_4xx": 1 });
    expect(snap.sent).toEqual({});
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "refund_shield.response.failed",
        resource: "refund_shield_response",
        after: expect.objectContaining({ reason: "apple_4xx" }),
      }),
      FAKE_TX,
    );
  });

  it("MAX_RETRIES_EXHAUSTED emits failed counter with max_retries reason + audit", async () => {
    const row = makeRow({ retryCount: MAX_RETRIES - 1 });
    claimPendingResponsesMock.mockResolvedValueOnce([row]);
    findProjectByIdMock.mockResolvedValueOnce(makeProject());
    processRefundShieldResponseMock.mockResolvedValueOnce({
      status: "RETRY",
      retryDelayMs: 60_000,
      error: "apple 503",
    });

    await runRefundShieldResponderTick({ now: NOW });

    const snap = metricsTesting.snapshot();
    expect(snap.failed).toEqual({ "proj_1::max_retries": 1 });
    expect(auditMock).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "refund_shield.response.failed",
        after: expect.objectContaining({ reason: "max_retries" }),
      }),
      FAKE_TX,
    );
  });

  it("audit failure does not crash the worker", async () => {
    // Audit DB write failing must NOT take down the responder mid-batch.
    // The row's status update already committed; we'd rather have a
    // chain gap than re-claim a row in a tight loop.
    auditMock.mockRejectedValueOnce(new Error("audit_logs insert failed"));
    claimPendingResponsesMock.mockResolvedValueOnce([makeRow()]);
    findProjectByIdMock.mockResolvedValueOnce(makeProject());
    processRefundShieldResponseMock.mockResolvedValueOnce({
      status: "SENT",
      payload: FAKE_PAYLOAD,
      httpStatus: 202,
    });

    await expect(
      runRefundShieldResponderTick({ now: NOW }),
    ).resolves.toMatchObject({ sent: 1 });

    // The SENT counter still ticked even though audit blew up.
    expect(metricsTesting.snapshot().sent).toEqual({ proj_1: 1 });
  });

  it("claims pending rows with FOR UPDATE SKIP LOCKED semantics + bounded batch", async () => {
    // Structural concurrency check: the worker must call
    // claimPendingResponses (which the repo implements with
    // FOR UPDATE SKIP LOCKED) inside a db.transaction with the
    // configured batch + retry caps. Two parallel ticks against
    // the same backlog rely on this; a per-row mocked behavioural
    // test would just re-test the mock.
    claimPendingResponsesMock.mockResolvedValueOnce([]);

    await runRefundShieldResponderTick({ now: NOW });

    expect(dbTransactionMock).toHaveBeenCalledTimes(1);
    expect(claimPendingResponsesMock).toHaveBeenCalledWith(
      FAKE_TX,
      expect.objectContaining({
        now: NOW,
        batchSize: BATCH_SIZE,
        maxRetries: MAX_RETRIES,
      }),
    );
  });
});
