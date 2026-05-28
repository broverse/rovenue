// =============================================================
// Refund Shield — end-to-end integration test (Task 20)
// =============================================================
//
// Capstone test exercising the full pipeline:
//
//   1. Seed project (refund_shield_enabled, consent stamped) +
//      subscriber (apple_app_account_token) + purchase
//      (original_transaction_id).
//   2. Drive `handleAppleNotification` with a CONSUMPTION_REQUEST
//      using a stub JWS verifier (same pattern as the T10 unit
//      tests) — bypasses BullMQ + the Apple Root CA chain so the
//      test is hermetic from outside fixtures.
//   3. Assert a PENDING `refund_shield_responses` row is enqueued.
//   4. Run a worker tick (`runRefundShieldResponderTick`) against
//      real Postgres + real ClickHouse.
//   5. Assert the mocked `sendConsumptionInfo` was called with the
//      right transactionId + payload shape, and the row flipped
//      to SENT.
//   6. Send a fake REFUND_DECLINED notification.
//   7. Assert the original row's `outcome` updated to REFUND_DECLINED.
//
// What's real here vs. mocked:
//   - Postgres: REAL (docker compose :5433, same as T16-T18 tests).
//   - ClickHouse: REAL (docker compose :8124). The aggregator's CH
//     queries return zeros for unseen subscribers — that's fine,
//     the bucket mapper still emits a valid CONSUMPTION_REQUEST.
//   - Apple JWS verification: STUBBED via a hand-rolled verifier
//     (same as T10 / T11 unit tests).
//   - Apple Server API HTTPS call: STUBBED via `vi.mock` of
//     `apple-server-api`. The whole point of the integration test
//     is to verify the wiring, not the outbound network call.
//   - BullMQ: BYPASSED — we invoke `handleAppleNotification`
//     directly, which is exactly what the BullMQ worker body does.
//
// Cleanup: every seeded row is keyed by a unique RUN_ID so re-runs
// never collide; afterAll deletes the project, which cascades to
// every dependent table.

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// =============================================================
// Module mocks — must come BEFORE the SUT imports.
// =============================================================
//
// We mock `apple-server-api` so the worker's outbound PUT never
// hits the real `api.storekit-sandbox.itunes.apple.com`. The mock
// stays at module level so both `process-response` (which imports
// `sendConsumptionInfo`) and the responder pick up the stub.

const { sendConsumptionInfoMock } = vi.hoisted(() => ({
  sendConsumptionInfoMock: vi.fn(),
}));

vi.mock("../../src/services/apple/apple-server-api", () => {
  class AppleServerApiErrorMock extends Error {
    constructor(
      public readonly status: number,
      public readonly bodyPreview: string,
    ) {
      super(`Apple Server API ${status}: ${bodyPreview.slice(0, 200)}`);
      this.name = "AppleServerApiError";
    }
  }
  return {
    sendConsumptionInfo: (...args: unknown[]) =>
      sendConsumptionInfoMock(...args),
    AppleServerApiError: AppleServerApiErrorMock,
  };
});

// =============================================================
// SUT + helpers (imported AFTER the mock above)
// =============================================================

import {
  getDb,
  projects,
  subscribers,
  products,
  purchases,
  drizzle,
} from "@rovenue/db";
import { eq } from "drizzle-orm";

import { handleAppleNotification } from "../../src/services/apple/apple-webhook";
import { runRefundShieldResponderTick } from "../../src/workers/refund-shield-responder";
import {
  APPLE_ENVIRONMENT,
  APPLE_NOTIFICATION_TYPE,
  type AppleJwsTransactionPayload,
  type AppleResponseBodyV2DecodedPayload,
} from "../../src/services/apple/apple-types";
import type { AppleNotificationVerifier } from "../../src/services/apple/apple-verify";

const { refundShieldResponses } = drizzle.schema;

// =============================================================
// Fixtures
// =============================================================

const RUN_ID = Date.now();
const PROJECT_ID = `prj_rse2e_${RUN_ID}`;
const SUBSCRIBER_ID = `sub_rse2e_${RUN_ID}`;
const PRODUCT_ID = `prod_rse2e_${RUN_ID}`;
const APP_ACCOUNT_TOKEN = "550e8400-e29b-41d4-a716-446655440000";
const ORIGINAL_TRANSACTION_ID = `otx_${RUN_ID}_e2e`;
const CONSUMPTION_TX_ID = `tx_${RUN_ID}_consumption`;
const REFUND_TX_ID = `tx_${RUN_ID}_refund`;
const CONSUMPTION_UUID = `e2e-uuid-1-${RUN_ID}`;
const DECLINED_UUID = `e2e-uuid-2-${RUN_ID}`;

function makeFakeTransaction(overrides: {
  transactionId: string;
  appAccountToken?: string;
}): AppleJwsTransactionPayload {
  return {
    transactionId: overrides.transactionId,
    originalTransactionId: ORIGINAL_TRANSACTION_ID,
    bundleId: "com.example.e2e",
    productId: "premium_monthly",
    purchaseDate: 1_700_000_000_000,
    originalPurchaseDate: 1_700_000_000_000,
    expiresDate: 1_700_000_000_000 + 30 * 86_400_000,
    quantity: 1,
    type: "Auto-Renewable Subscription",
    appAccountToken: overrides.appAccountToken,
    inAppOwnershipType: "PURCHASED",
    signedDate: 1_700_000_000_000,
    environment: APPLE_ENVIRONMENT.SANDBOX,
    storefront: "USA",
    storefrontId: "143441",
    currency: "USD",
    price: 9_990_000,
  } satisfies AppleJwsTransactionPayload;
}

function makeNotification(
  type: AppleResponseBodyV2DecodedPayload["notificationType"],
  uuid: string,
): AppleResponseBodyV2DecodedPayload {
  return {
    notificationType: type,
    notificationUUID: uuid,
    version: "2.0",
    signedDate: 1_700_000_000_000,
    data: {
      signedTransactionInfo: "signed-tx-stub",
      environment: APPLE_ENVIRONMENT.SANDBOX,
    },
  } as AppleResponseBodyV2DecodedPayload;
}

function makeStubVerifier(
  transaction: AppleJwsTransactionPayload,
  notification: AppleResponseBodyV2DecodedPayload,
): AppleNotificationVerifier {
  return {
    verifyNotification: vi.fn(async () => notification),
    verifyTransaction: vi.fn(async () => transaction),
    verifyRenewalInfo: vi.fn(async () => {
      throw new Error("renewal info not used in e2e test");
    }),
  };
}

// =============================================================
// Seed / cleanup
// =============================================================

beforeAll(async () => {
  const db = getDb();

  // Project: refund shield enabled, consent stamped, ZERO response
  // delay so the worker can pick up the row in the same tick.
  // appleCredentials are stored as plaintext JSON — `decryptCredential`
  // tolerates that for legacy rows and the worker only reads the
  // signing fields. The Apple Server API call itself is mocked so
  // we never actually mint a JWT.
  await db.insert(projects).values({
    id: PROJECT_ID,
    name: `Refund Shield E2E ${RUN_ID}`,
    appleCredentials: {
      bundleId: "com.example.e2e",
      appAppleId: 1234567890,
      keyId: "FAKE_KEY_ID",
      issuerId: "00000000-0000-0000-0000-000000000000",
      privateKey:
        "-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n",
    },
    refundShieldEnabled: true,
    refundShieldResponseDelayMinutes: 0,
    refundShieldConsentAcknowledgedAt: new Date(),
  });

  await db.insert(subscribers).values({
    id: SUBSCRIBER_ID,
    projectId: PROJECT_ID,
    appUserId: `app_rse2e_${RUN_ID}`,
    appleAppAccountToken: APP_ACCOUNT_TOKEN,
  });

  await db.insert(products).values({
    id: PRODUCT_ID,
    projectId: PROJECT_ID,
    identifier: `com.rovenue.rse2e.${RUN_ID}`,
    type: "SUBSCRIPTION",
    storeIds: {},
    displayName: `RS E2E Product ${RUN_ID}`,
    accessIds: [],
  });

  // Purchase: aggregate-signals reads MIN(purchaseDate) +
  // last expiresDate for this originalTransactionId. Without
  // these columns the aggregator throws.
  const purchaseDate = new Date(Date.now() - 7 * 86_400_000);
  const expiresDate = new Date(Date.now() + 23 * 86_400_000);
  await db.insert(purchases).values({
    projectId: PROJECT_ID,
    subscriberId: SUBSCRIBER_ID,
    productId: PRODUCT_ID,
    store: "APP_STORE",
    storeTransactionId: ORIGINAL_TRANSACTION_ID,
    originalTransactionId: ORIGINAL_TRANSACTION_ID,
    status: "ACTIVE",
    isTrial: false,
    isIntroOffer: false,
    isSandbox: false,
    purchaseDate,
    originalPurchaseDate: purchaseDate,
    expiresDate,
    priceAmount: "9.99",
    priceCurrency: "USD",
    environment: "SANDBOX",
  });
});

afterAll(async () => {
  // Project cascade handles refund_shield_responses, purchases,
  // subscribers, products via FK ON DELETE CASCADE.
  await getDb().delete(projects).where(eq(projects.id, PROJECT_ID));
});

// =============================================================
// Tests
// =============================================================

describe("Refund Shield — end-to-end", () => {
  it(
    "CONSUMPTION_REQUEST -> enqueue -> worker -> Apple call -> outcome update",
    async () => {
      // -----------------------------------------------------------
      // Step 1: drive CONSUMPTION_REQUEST through the webhook
      // handler (skipping BullMQ + JWS chain verification via the
      // stub verifier — same shape the BullMQ worker body uses).
      // -----------------------------------------------------------
      sendConsumptionInfoMock.mockResolvedValueOnce({ status: 202 });

      const consumptionVerifier = makeStubVerifier(
        makeFakeTransaction({
          transactionId: CONSUMPTION_TX_ID,
          appAccountToken: APP_ACCOUNT_TOKEN,
        }),
        makeNotification(
          APPLE_NOTIFICATION_TYPE.CONSUMPTION_REQUEST,
          CONSUMPTION_UUID,
        ),
      );

      const enqueueResult = await handleAppleNotification({
        projectId: PROJECT_ID,
        signedPayload: "stub-jws-payload",
        verifier: consumptionVerifier,
      });
      expect(enqueueResult.status).toBe("processed");

      // -----------------------------------------------------------
      // Step 2: a PENDING refund_shield_responses row exists.
      // -----------------------------------------------------------
      const db = getDb();
      const queued = await db
        .select()
        .from(refundShieldResponses)
        .where(
          eq(refundShieldResponses.appleNotificationUuid, CONSUMPTION_UUID),
        )
        .limit(1);
      expect(queued).toHaveLength(1);
      expect(queued[0]?.status).toBe("PENDING");
      expect(queued[0]?.subscriberId).toBe(SUBSCRIBER_ID);
      expect(queued[0]?.appleOriginalTransactionId).toBe(
        ORIGINAL_TRANSACTION_ID,
      );
      expect(queued[0]?.appleTransactionId).toBe(CONSUMPTION_TX_ID);

      // -----------------------------------------------------------
      // Step 3: run a responder tick. With responseDelayMinutes=0
      // the row is immediately eligible and the worker should
      // claim + dispatch in this single call.
      // -----------------------------------------------------------
      const tick = await runRefundShieldResponderTick({ now: new Date() });
      expect(tick.claimed).toBeGreaterThanOrEqual(1);
      expect(tick.sent).toBeGreaterThanOrEqual(1);
      expect(tick.failed).toBe(0);

      // -----------------------------------------------------------
      // Step 4: Apple Server API was hit with the right tx id +
      // a structurally valid ConsumptionRequest payload.
      // -----------------------------------------------------------
      expect(sendConsumptionInfoMock).toHaveBeenCalledTimes(1);
      const [ctxArg, txIdArg, payloadArg] =
        sendConsumptionInfoMock.mock.calls[0] ?? [];
      expect(txIdArg).toBe(CONSUMPTION_TX_ID);
      expect(payloadArg).toMatchObject({
        customerConsented: true,
        // The bucket mapper produces integer-coded fields. We don't
        // pin every value (signals depend on the CH state of this
        // dev box) — but the shape must be present.
        refundPreference: expect.any(Number),
        consumptionStatus: expect.any(Number),
        platform: 1,
        sampleContentProvided: false,
        deliveryStatus: 0,
      });
      // Note: `appAccountToken` is an AggregateInput passthrough that
      // the worker doesn't currently populate (the row only carries
      // `subscriberId`). When the field is null, the bucket mapper
      // omits it from the Apple payload entirely. The downstream
      // wiring is what we're validating here; per-field aggregator
      // hydration is covered by aggregate-signals.test.ts.
      // Apple context wiring: bundleId + signing fields came from
      // the seeded project.appleCredentials row, not from a mock.
      expect(ctxArg).toMatchObject({
        bundleId: "com.example.e2e",
        keyId: "FAKE_KEY_ID",
      });

      // -----------------------------------------------------------
      // Step 5: row flipped to SENT with sentAt + requestPayload.
      // -----------------------------------------------------------
      const sent = await db
        .select()
        .from(refundShieldResponses)
        .where(
          eq(refundShieldResponses.appleNotificationUuid, CONSUMPTION_UUID),
        )
        .limit(1);
      expect(sent[0]?.status).toBe("SENT");
      expect(sent[0]?.sentAt).toBeTruthy();
      expect(sent[0]?.appleHttpStatus).toBe(202);
      expect(sent[0]?.requestPayload).toMatchObject({
        customerConsented: true,
      });

      // -----------------------------------------------------------
      // Step 6: simulate a REFUND_DECLINED notification arriving
      // hours later. The outcome handler (T11) should update the
      // existing row's `outcome` column without touching status.
      // -----------------------------------------------------------
      const declinedVerifier = makeStubVerifier(
        makeFakeTransaction({
          transactionId: REFUND_TX_ID,
          appAccountToken: APP_ACCOUNT_TOKEN,
        }),
        makeNotification(
          APPLE_NOTIFICATION_TYPE.REFUND_DECLINED,
          DECLINED_UUID,
        ),
      );

      const outcomeResult = await handleAppleNotification({
        projectId: PROJECT_ID,
        signedPayload: "stub-jws-payload-2",
        verifier: declinedVerifier,
      });
      expect(outcomeResult.status).toBe("processed");

      // -----------------------------------------------------------
      // Step 7: outcome is REFUND_DECLINED on the original row.
      // -----------------------------------------------------------
      const final = await db
        .select()
        .from(refundShieldResponses)
        .where(
          eq(refundShieldResponses.appleNotificationUuid, CONSUMPTION_UUID),
        )
        .limit(1);
      expect(final[0]?.outcome).toBe("REFUND_DECLINED");
      expect(final[0]?.outcomeReceivedAt).toBeTruthy();
      // Status from step 5 must NOT regress — outcome is orthogonal
      // to the dispatch state machine.
      expect(final[0]?.status).toBe("SENT");
    },
    30_000,
  );
});
