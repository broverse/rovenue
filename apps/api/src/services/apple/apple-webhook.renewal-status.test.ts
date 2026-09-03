import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// DID_CHANGE_RENEWAL_STATUS — threading the direction to the bridge
// =============================================================
//
// Task 2 (store-lifecycle-normalization): `store-event-normalization.ts`
// excluded DID_CHANGE_RENEWAL_STATUS from `STORE_EVENT_TO_PUBLIC_KEY`
// because the bridge call site (webhook-processor.ts's
// `enqueueOutgoingWebhook`) only ever saw the bare event-type string —
// no way to tell "auto-renew turned back ON" from "auto-renew turned
// OFF", and the two mean opposite things (`subscription.uncancelled` vs.
// nothing, since OFF is already carried by `subscription.cancel_requested`
// elsewhere). `applyRenewalStatusChange` now threads
// `ctx.renewalInfo.autoRenewStatus` through `DispatchOutcome.eventContext`
// -> `postProcess` -> `resolveStorePublicKey`.
//
// These tests drive a REAL Apple notification through
// `handleAppleNotification`, with `postProcess` wired to webhook-processor
// .ts's REAL `runPostProcessing` / `enqueueOutgoingWebhook` (imported,
// not reimplemented) — only the `drizzle` repo calls are mocked. This is
// the "drive a real cancel end-to-end" evidence the task asked for: a
// test that only read `STORE_EVENT_TO_PUBLIC_KEY` or
// `resolveStorePublicKey` in isolation would prove nothing about whether
// the real event ever reaches the outbox, or reaches it twice.
// =============================================================

const { drizzleMock } = vi.hoisted(() => {
  const db: Record<string, unknown> = {
    transaction: async (fn: (tx: unknown) => unknown) => fn(db),
  };
  const drizzleMock = {
    db: db as unknown,
    webhookEventRepo: {
      claimWebhookEvent: vi.fn(),
      updateWebhookEvent: vi.fn(async () => undefined),
    },
    purchaseRepo: {
      updatePurchasesByOriginalTransaction: vi.fn(async () => undefined),
      // REVOKE's chain write + access revocation; the renewal-status path
      // never reaches these, the REVOKE path below does.
      updateChainStatusGuarded: vi.fn(async () => ({
        updatedIds: [PURCHASE_ID],
        skippedTerminalIds: [],
      })),
    },
    accessRepo: {
      revokeAccessByOriginalTransaction: vi.fn(async () => undefined),
    },
    purchaseExtRepo: {
      findPurchaseByOriginalTransaction: vi.fn(),
      findPurchaseWithCreditInfo: vi.fn(async () => null),
    },
    projectRepo: {
      findProjectWebhookConfig: vi.fn(async () => ({
        url: null,
        eventCategories: [] as string[],
      })),
    },
    outboxRepo: {
      insert: vi.fn(async () => undefined),
      findByWebhookEventAndType: vi.fn(async () => null),
      findByPurchaseAndType: vi.fn(async () => null),
    },
    outgoingWebhookRepo: {
      findRecentOutgoingByPurchaseAndType: vi.fn(async () => null),
      findOutgoingByWebhookEvent: vi.fn(async () => null),
      enqueueOutgoingWebhook: vi.fn(async () => undefined),
    },
  };
  return { drizzleMock };
});

vi.mock("@rovenue/db", async () => {
  const actual =
    await vi.importActual<typeof import("@rovenue/db")>("@rovenue/db");
  return {
    ...actual,
    drizzle: { schema: actual.drizzle.schema, ...drizzleMock },
  };
});

vi.mock("../access-engine", () => ({
  syncAccess: vi.fn(async () => undefined),
}));

vi.mock("../purchase-credits", () => ({
  grantPurchaseCurrencies: vi.fn(async () => undefined),
}));

import { handleAppleNotification } from "./apple-webhook";
import {
  APPLE_ENVIRONMENT,
  APPLE_NOTIFICATION_TYPE,
  type AppleJwsRenewalInfoPayload,
  type AppleJwsTransactionPayload,
  type AppleResponseBodyV2DecodedPayload,
} from "./apple-types";
import type { AppleNotificationVerifier } from "./apple-verify";
import { __test_runPostProcessing as runPostProcessing } from "../webhook-processor";
import type { WebhookPostProcess } from "../webhook-processor";

const PROJECT_ID = "prj_rs_test";
const ORIGINAL_TRANSACTION_ID = "otxn_rs_1";
const SUBSCRIBER_ID = "sub_rs_1";
const PURCHASE_ID = "pur_rs_1";
const FIXED_MS = 1_700_000_000_000;

function makeTransaction(): AppleJwsTransactionPayload {
  return {
    transactionId: "txn_rs_1",
    originalTransactionId: ORIGINAL_TRANSACTION_ID,
    productId: "premium_monthly",
    purchaseDate: FIXED_MS,
    originalPurchaseDate: FIXED_MS,
    expiresDate: FIXED_MS + 30 * 86_400_000,
    signedDate: FIXED_MS,
    environment: APPLE_ENVIRONMENT.SANDBOX,
    currency: "USD",
    price: 9_990_000,
  } as AppleJwsTransactionPayload;
}

function makeRevokeNotification(uuid: string): AppleResponseBodyV2DecodedPayload {
  const base = makeRenewalStatusNotification(uuid);
  return { ...base, notificationType: APPLE_NOTIFICATION_TYPE.REVOKE };
}

function makeRenewalStatusNotification(uuid: string): AppleResponseBodyV2DecodedPayload {
  return {
    notificationType: APPLE_NOTIFICATION_TYPE.DID_CHANGE_RENEWAL_STATUS,
    notificationUUID: uuid,
    version: "2.0",
    signedDate: FIXED_MS,
    data: {
      environment: APPLE_ENVIRONMENT.SANDBOX,
      signedTransactionInfo: "stub-tx-jws",
      signedRenewalInfo: "stub-renewal-jws",
    },
  } as AppleResponseBodyV2DecodedPayload;
}

function makeStubVerifier(
  notification: AppleResponseBodyV2DecodedPayload,
  autoRenewStatus: 0 | 1,
): AppleNotificationVerifier {
  return {
    verifyNotification: vi.fn(async () => notification),
    verifyTransaction: vi.fn(async () => makeTransaction()),
    verifyRenewalInfo: vi.fn(
      async () =>
        ({
          originalTransactionId: ORIGINAL_TRANSACTION_ID,
          productId: "premium_monthly",
          autoRenewStatus,
          signedDate: FIXED_MS,
          environment: APPLE_ENVIRONMENT.SANDBOX,
        }) as AppleJwsRenewalInfoPayload,
    ),
  };
}

/**
 * The REAL postProcess wiring, copied verbatim from
 * `processWebhookEvent` in webhook-processor.ts (that closure isn't
 * exported — only `runPostProcessing` is, via `__test_runPostProcessing`).
 * This is what makes the test an end-to-end drive of the actual bridge
 * logic rather than a stand-in for it.
 */
function makePostProcess(): WebhookPostProcess {
  return async (ctx) => {
    if (!ctx.subscriberId) return;
    await runPostProcessing({
      projectId: PROJECT_ID,
      subscriberId: ctx.subscriberId,
      purchaseId: ctx.purchaseId,
      eventType: ctx.eventType,
      webhookEventId: ctx.webhookEventId,
      eventContext: ctx.eventContext,
    });
  };
}

async function dispatchRenewalStatusChange(
  autoRenewStatus: 0 | 1,
  uuid: string,
) {
  return handleAppleNotification({
    projectId: PROJECT_ID,
    signedPayload: "signed-envelope-stub",
    verifier: makeStubVerifier(
      makeRenewalStatusNotification(uuid),
      autoRenewStatus,
    ),
    postProcess: makePostProcess(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  drizzleMock.webhookEventRepo.claimWebhookEvent.mockResolvedValue({
    outcome: "claimed",
    row: { id: "wh_rs" },
  });
  drizzleMock.purchaseExtRepo.findPurchaseByOriginalTransaction.mockResolvedValue(
    { id: PURCHASE_ID, subscriberId: SUBSCRIBER_ID },
  );
  drizzleMock.projectRepo.findProjectWebhookConfig.mockResolvedValue({
    url: null,
    eventCategories: [],
  });
});

describe("handleAppleNotification — DID_CHANGE_RENEWAL_STATUS end-to-end", () => {
  test("ON (auto-renew re-enabled): exactly one subscription.uncancelled lands in the outbox", async () => {
    const result = await dispatchRenewalStatusChange(1, "uuid-rs-on");

    expect(result.status).toBe("processed");

    // The pre-existing column write still happens, unchanged.
    expect(
      drizzleMock.purchaseRepo.updatePurchasesByOriginalTransaction,
    ).toHaveBeenCalledWith(
      expect.anything(),
      PROJECT_ID,
      ORIGINAL_TRANSACTION_ID,
      { autoRenewStatus: true },
    );

    // Exactly one lifecycle key lands — not zero (the direction was
    // dropped), not two (double-mapped under a second key).
    expect(drizzleMock.outboxRepo.insert).toHaveBeenCalledTimes(1);
    expect(drizzleMock.outboxRepo.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        aggregateType: "SUBSCRIPTION",
        aggregateId: SUBSCRIBER_ID,
        eventType: "subscription.uncancelled",
        payload: expect.objectContaining({
          projectId: PROJECT_ID,
          purchaseId: PURCHASE_ID,
        }),
      }),
    );
  });

  test("OFF (a real cancel — auto-renew turned off): no lifecycle key lands at all", async () => {
    const result = await dispatchRenewalStatusChange(0, "uuid-rs-off");

    expect(result.status).toBe("processed");

    expect(
      drizzleMock.purchaseRepo.updatePurchasesByOriginalTransaction,
    ).toHaveBeenCalledWith(
      expect.anything(),
      PROJECT_ID,
      ORIGINAL_TRANSACTION_ID,
      { autoRenewStatus: false },
    );

    // This is the double-map risk the exclusion comment names: OFF is
    // already carried by `subscription.cancel_requested` elsewhere, so
    // this path minting anything here — `subscription.uncancelled` or a
    // new key — would land the same real-world cancel under two public
    // keys. Driven end-to-end, the outbox must stay untouched.
    expect(drizzleMock.outboxRepo.insert).not.toHaveBeenCalled();
  });

  test("no matching purchase row: the bridge never runs (postProcess bails on no subscriberId)", async () => {
    drizzleMock.purchaseExtRepo.findPurchaseByOriginalTransaction.mockResolvedValue(
      null,
    );

    const result = await dispatchRenewalStatusChange(1, "uuid-rs-orphan");

    expect(result.status).toBe("processed");
    expect(drizzleMock.outboxRepo.insert).not.toHaveBeenCalled();
  });
});

// =============================================================
// REVOKE — the gap Task 1 found and Task 3 closed
// =============================================================
//
// Before this, `applyRevoke` wrote the chain status and revoked access
// while never setting `outcome.subscriberId` — and `postProcess` bails
// without one. So an Apple REVOKE emitted NOTHING: no revenue event, no
// lifecycle key, and a subscriber could lose access with zero signal to
// any consumer.
//
// The mapping row alone would not have fixed that, which is exactly why
// this asserts on the OUTBOX rather than on STORE_EVENT_TO_PUBLIC_KEY.

describe("handleAppleNotification — REVOKE end-to-end", () => {
  test("exactly one subscription.revoked lands in the outbox", async () => {
    const result = await handleAppleNotification({
      projectId: PROJECT_ID,
      signedPayload: "signed-envelope-stub",
      verifier: makeStubVerifier(makeRevokeNotification("uuid-revoke"), 1),
      postProcess: makePostProcess(),
    });

    expect(result.status).toBe("processed");

    expect(drizzleMock.outboxRepo.insert).toHaveBeenCalledTimes(1);
    expect(drizzleMock.outboxRepo.insert).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        aggregateType: "SUBSCRIPTION",
        aggregateId: SUBSCRIBER_ID,
        eventType: "subscription.revoked",
        payload: expect.objectContaining({
          projectId: PROJECT_ID,
          purchaseId: PURCHASE_ID,
        }),
      }),
    );
  });

  test("no matching purchase row: no key lands, and nothing throws", async () => {
    drizzleMock.purchaseExtRepo.findPurchaseByOriginalTransaction.mockResolvedValueOnce(
      null,
    );

    const result = await handleAppleNotification({
      projectId: PROJECT_ID,
      signedPayload: "signed-envelope-stub",
      verifier: makeStubVerifier(makeRevokeNotification("uuid-revoke-2"), 1),
      postProcess: makePostProcess(),
    });

    expect(result.status).toBe("processed");
    expect(drizzleMock.outboxRepo.insert).not.toHaveBeenCalled();
  });
});
