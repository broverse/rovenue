import { describe, expect, it, test, vi } from "vitest";
import { CompactSign, generateKeyPair, type KeyLike } from "jose";
import {
  APPLE_ENVIRONMENT,
  APPLE_NOTIFICATION_SUBTYPE,
  APPLE_NOTIFICATION_TYPE,
  APPLE_OWNERSHIP_TYPE,
  APPLE_TRANSACTION_TYPE,
} from "../src/services/apple/apple-types";
import {
  verifySignedPayload,
  verifySignedTransaction,
  decodeUnverifiedJws,
  type AppleKeyLookup,
} from "../src/services/apple/apple-verify";

async function signPayload(
  privateKey: KeyLike,
  payload: Record<string, unknown>,
): Promise<string> {
  return new CompactSign(new TextEncoder().encode(JSON.stringify(payload)))
    .setProtectedHeader({ alg: "ES256" })
    .sign(privateKey);
}

describe("apple-verify", () => {
  it("verifies a signed notification payload via an injected key lookup", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const keyLookup: AppleKeyLookup = async () => publicKey;

    const notification = {
      notificationType: APPLE_NOTIFICATION_TYPE.SUBSCRIBED,
      subtype: APPLE_NOTIFICATION_SUBTYPE.INITIAL_BUY,
      notificationUUID: "test-uuid-1",
      data: {
        environment: APPLE_ENVIRONMENT.SANDBOX,
        bundleId: "com.example.app",
      },
      version: "2.0",
      signedDate: 1_700_000_000_000,
    };

    const jws = await signPayload(privateKey, notification);
    const decoded = await verifySignedPayload(jws, keyLookup);

    expect(decoded.notificationType).toBe(APPLE_NOTIFICATION_TYPE.SUBSCRIBED);
    expect(decoded.subtype).toBe(APPLE_NOTIFICATION_SUBTYPE.INITIAL_BUY);
    expect(decoded.notificationUUID).toBe("test-uuid-1");
    expect(decoded.data?.bundleId).toBe("com.example.app");
  });

  it("verifies a signed transaction payload", async () => {
    const { publicKey, privateKey } = await generateKeyPair("ES256");
    const keyLookup: AppleKeyLookup = async () => publicKey;

    const transaction = {
      transactionId: "tx_1",
      originalTransactionId: "tx_orig_1",
      bundleId: "com.example.app",
      productId: "com.example.app.pro",
      purchaseDate: 1_700_000_000_000,
      originalPurchaseDate: 1_700_000_000_000,
      expiresDate: 1_702_592_000_000,
      quantity: 1,
      type: APPLE_TRANSACTION_TYPE.AUTO_RENEWABLE_SUBSCRIPTION,
      inAppOwnershipType: APPLE_OWNERSHIP_TYPE.PURCHASED,
      signedDate: 1_700_000_000_000,
      environment: APPLE_ENVIRONMENT.SANDBOX,
      storefront: "USA",
      storefrontId: "143441",
      currency: "USD",
      price: 9_990_000,
    };

    const jws = await signPayload(privateKey, transaction);
    const decoded = await verifySignedTransaction(jws, keyLookup);

    expect(decoded.transactionId).toBe("tx_1");
    expect(decoded.productId).toBe("com.example.app.pro");
    expect(decoded.type).toBe(APPLE_TRANSACTION_TYPE.AUTO_RENEWABLE_SUBSCRIPTION);
    expect(decoded.price).toBe(9_990_000);
  });

  it("rejects a JWS with a tampered signature", async () => {
    const { privateKey } = await generateKeyPair("ES256");
    const { publicKey: otherPublicKey } = await generateKeyPair("ES256");
    const mismatchLookup: AppleKeyLookup = async () => otherPublicKey;

    const jws = await signPayload(privateKey, {
      notificationType: APPLE_NOTIFICATION_TYPE.TEST,
      notificationUUID: "test-uuid-2",
      version: "2.0",
      signedDate: Date.now(),
    });

    await expect(verifySignedPayload(jws, mismatchLookup)).rejects.toThrow();
  });

  it("decodes unverified payload for diagnostics", async () => {
    const { privateKey } = await generateKeyPair("ES256");
    const jws = await signPayload(privateKey, {
      notificationType: APPLE_NOTIFICATION_TYPE.TEST,
      notificationUUID: "diag-uuid",
      version: "2.0",
      signedDate: 42,
    });

    const decoded = decodeUnverifiedJws<{
      notificationType: string;
      notificationUUID: string;
    }>(jws);
    expect(decoded.notificationType).toBe(APPLE_NOTIFICATION_TYPE.TEST);
    expect(decoded.notificationUUID).toBe("diag-uuid");
  });
});

describe("createAppleVerifier — production safety", () => {
  // Note: env.ts already requires APPLE_ROOT_CERTS_DIR in production at
  // schema-parse time, so an unset var blocks process startup. The
  // remaining gap is when the dir is set but contains no usable certs
  // (empty dir, unreadable dir) — loadAppleRootCerts() returns null
  // without throwing, and createAppleVerifier used to silently
  // construct an unchained Jose verifier. This pair pins the
  // fail-closed contract for that path.
  test("throws in production when Apple root cert dir is empty", async () => {
    const fsp = await import("node:fs/promises");
    const os = await import("node:os");
    const path = await import("node:path");
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "apple-roots-empty-"));

    const prev = {
      NODE_ENV: process.env.NODE_ENV,
      APPLE_ROOT_CERTS_DIR: process.env.APPLE_ROOT_CERTS_DIR,
      PUBSUB_PUSH_AUDIENCE: process.env.PUBSUB_PUSH_AUDIENCE,
    };
    process.env.NODE_ENV = "production";
    process.env.APPLE_ROOT_CERTS_DIR = dir;
    process.env.PUBSUB_PUSH_AUDIENCE = "test-audience";
    try {
      vi.resetModules();
      const { createAppleVerifier } = await import(
        "../src/services/apple/apple-verify"
      );
      expect(() =>
        createAppleVerifier({ projectId: "p1", bundleId: "com.example" }),
      ).toThrow(/apple root|chain validation|fail closed|refusing/i);
    } finally {
      for (const [key, value] of Object.entries(prev)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      vi.resetModules();
    }
  });

  test("falls back to jose verifier outside production", async () => {
    const prevEnv = process.env.NODE_ENV;
    const prevDir = process.env.APPLE_ROOT_CERTS_DIR;
    process.env.NODE_ENV = "test";
    delete process.env.APPLE_ROOT_CERTS_DIR;
    try {
      vi.resetModules();
      const { createAppleVerifier } = await import(
        "../src/services/apple/apple-verify"
      );
      const verifier = createAppleVerifier({
        projectId: "p1",
        bundleId: "com.example",
      });
      expect(verifier).toBeDefined();
    } finally {
      process.env.NODE_ENV = prevEnv;
      if (prevDir === undefined) delete process.env.APPLE_ROOT_CERTS_DIR;
      else process.env.APPLE_ROOT_CERTS_DIR = prevDir;
      vi.resetModules();
    }
  });
});
