import { HTTPException } from "hono/http-exception";
import {
  Environment,
  ProductType,
  PurchaseStatus,
  Store,
  drizzle,
  revenueDedupeKind,
  type Product,
  type Purchase,
  type Subscriber,
} from "@rovenue/db";
import { appleCircuit, googleCircuit } from "../lib/circuit-breaker";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import {
  loadAppleCredentials,
  loadGoogleCredentials,
} from "../lib/project-credentials";
import {
  createAppleVerifier,
  decodeUnverifiedJws,
  JoseAppleNotificationVerifier,
  type AppleNotificationVerifier,
} from "./apple/apple-verify";
import {
  APPLE_ENVIRONMENT,
  APPLE_OFFER_TYPE,
  type AppleEnvironment,
  type AppleJwsTransactionPayload,
} from "./apple/apple-types";
import {
  verifyGoogleProductPurchase,
  verifyGoogleSubscription,
} from "./google/google-verify";
import type {
  GoogleServiceAccountCredentials,
  GoogleVerifyConfig,
} from "./google";
import { guardStatusWrite } from "./subscription-transition-guard";
import { convertToUsd } from "./fx";
import { reassignAllAssets, safeSyncAccessAfterMerge } from "./subscriber-transfer";

const log = logger.child("receipt-verify");

// =============================================================
// Input / output shapes
// =============================================================

export type VerifyReceiptStore = "APP_STORE" | "PLAY_STORE";

export interface VerifyReceiptArgs {
  projectId: string;
  store: VerifyReceiptStore;
  receipt: string;
  productId: string;
  appUserId: string;
}

export interface VerifyReceiptResult {
  subscriber: Subscriber;
  product: Product;
  purchase: Purchase;
}

// =============================================================
// Public entrypoint
// =============================================================

export async function verifyReceipt(
  args: VerifyReceiptArgs,
): Promise<VerifyReceiptResult> {
  switch (args.store) {
    case "APP_STORE":
      return verifyAppleReceipt(args);
    case "PLAY_STORE":
      return verifyGoogleReceipt(args);
  }
}

// =============================================================
// Apple receipt (JWS signed transaction from StoreKit 2)
// =============================================================

async function resolveAppleVerifier(
  projectId: string,
  signedPayload: string,
): Promise<AppleNotificationVerifier> {
  let environment: AppleEnvironment | undefined;
  try {
    const peek = decodeUnverifiedJws<AppleJwsTransactionPayload>(signedPayload);
    environment = peek.environment;
  } catch {
    environment = undefined;
  }

  const creds = await loadAppleCredentials(projectId);
  if (creds) {
    return createAppleVerifier({
      projectId,
      bundleId: creds.bundleId,
      appAppleId: creds.appAppleId,
      environment,
    });
  }

  if (env.NODE_ENV === "production") {
    throw new HTTPException(400, {
      message: "Project not configured for Apple receipt verification",
    });
  }

  log.warn("no project Apple credentials; falling back to jose verifier", {
    projectId,
  });
  return new JoseAppleNotificationVerifier();
}

async function verifyAppleReceipt(
  args: VerifyReceiptArgs,
): Promise<VerifyReceiptResult> {
  const verifier = await resolveAppleVerifier(args.projectId, args.receipt);

  let transaction: AppleJwsTransactionPayload;
  try {
    transaction = await appleCircuit.exec(() =>
      verifier.verifyTransaction(args.receipt),
    );
  } catch (err) {
    log.warn("apple receipt verification failed", {
      projectId: args.projectId,
      circuit: appleCircuit.state,
      err: err instanceof Error ? err.message : String(err),
    });
    throw new HTTPException(
      appleCircuit.state === "OPEN" ? 503 : 400,
      { message: "Apple receipt verification failed" },
    );
  }

  const product = (await drizzle.offeringRepo.findProductByIdentifierOrStoreId(
    drizzle.db,
    args.projectId,
    args.productId,
    "apple",
    transaction.productId,
  )) as Product | null;
  if (!product) {
    throw new HTTPException(404, {
      message: `Product not found for Apple productId ${transaction.productId}`,
    });
  }

  // Resolve the subscriber RC/Adapty-style: bind the JWS appAccountToken and
  // converge any webhook-first row that already owns this transaction/token,
  // so receipt-driven and webhook-driven state never split across two rows.
  const subscriber = await reconcileAppleReceiptSubscriber({
    projectId: args.projectId,
    appUserId: args.appUserId,
    appAccountToken: transaction.appAccountToken ?? null,
    originalTransactionId: transaction.originalTransactionId,
  });

  const environment =
    transaction.environment === APPLE_ENVIRONMENT.PRODUCTION
      ? Environment.PRODUCTION
      : Environment.SANDBOX;
  const isTrial =
    transaction.offerType === APPLE_OFFER_TYPE.INTRODUCTORY &&
    (transaction.price ?? 0) === 0;
  const status = isTrial ? PurchaseStatus.TRIAL : PurchaseStatus.ACTIVE;

  // State-machine guard: never resurrect a terminal (REFUNDED /
  // REVOKED) purchase via a late verify. Non-status fields still
  // update; only `status` is withheld + audited on rejection.
  //
  // FINDING 1: run the guarded read + upsert in ONE transaction so the
  // `FOR UPDATE` lock from guardStatusWrite is held across the write
  // (mechanism (a)); upsertPurchase additionally CASE-guards the
  // terminal status at SQL level (mechanism (b)).
  const purchase = (await drizzle.db.transaction(async (tx) => {
    const guard = await guardStatusWrite({
      db: tx,
      projectId: args.projectId,
      store: Store.APP_STORE,
      storeTransactionId: transaction.transactionId,
      to: status,
      source: "receipt-verify",
    });

    return drizzle.purchaseRepo.upsertPurchase(tx, {
      store: Store.APP_STORE,
      storeTransactionId: transaction.transactionId,
      create: {
        projectId: args.projectId,
        subscriberId: subscriber.id,
        productId: product.id,
        store: Store.APP_STORE,
        storeTransactionId: transaction.transactionId,
        originalTransactionId: transaction.originalTransactionId,
        status,
        isTrial,
        isIntroOffer: transaction.offerType !== undefined,
        isSandbox: environment === Environment.SANDBOX,
        environment,
        purchaseDate: new Date(transaction.purchaseDate),
        originalPurchaseDate: new Date(transaction.originalPurchaseDate),
        expiresDate: transaction.expiresDate
          ? new Date(transaction.expiresDate)
          : null,
        // Drizzle decimal columns round-trip as strings.
        priceAmount:
          transaction.price != null
            ? (transaction.price / 1_000_000).toString()
            : null,
        priceCurrency: transaction.currency ?? null,
        ownershipType: transaction.inAppOwnershipType,
        verifiedAt: new Date(),
      },
      update: {
        ...(guard.apply ? { status } : {}),
        expiresDate: transaction.expiresDate
          ? new Date(transaction.expiresDate)
          : null,
        ...(transaction.price != null && {
          priceAmount: (transaction.price / 1_000_000).toString(),
        }),
        ...(transaction.currency != null && {
          priceCurrency: transaction.currency,
        }),
        verifiedAt: new Date(),
      },
    });
  })) as unknown as Purchase;

  // R6: record revenue on the receipt path too (the RevenueCat/Adapty model),
  // not only on the App Store Server Notification. Idempotent via the same
  // `apple:<transactionId>:<kind>` dedupeKey the webhook uses, so whichever
  // arrives first records the row and the other is a no-op — closing the gap
  // where a delayed/unconfigured webhook left a purchase with access but no
  // revenue.
  if (transaction.price != null && transaction.currency) {
    const amount = transaction.price / 1_000_000;
    const amountUsd = await convertToUsd(amount, transaction.currency);
    const type =
      transaction.transactionId === transaction.originalTransactionId
        ? "INITIAL"
        : "RENEWAL";
    await drizzle.revenueEventRepo.createRevenueEvent(drizzle.db, {
      projectId: args.projectId,
      subscriberId: subscriber.id,
      purchaseId: purchase.id,
      productId: product.id,
      type,
      amount: amount.toString(),
      currency: transaction.currency,
      amountUsd: amountUsd.toString(),
      store: Store.APP_STORE,
      eventDate: new Date(transaction.purchaseDate),
      dedupeKey: `apple:${transaction.transactionId}:${revenueDedupeKind(type)}`,
    });
  }

  return { subscriber, product, purchase };
}

// =============================================================
// Google receipt (purchaseToken)
// =============================================================

async function loadGoogleConfig(
  projectId: string,
): Promise<GoogleVerifyConfig> {
  const creds = await loadGoogleCredentials(projectId);
  if (!creds) {
    throw new HTTPException(400, {
      message: "Project not configured for Google Play",
    });
  }
  return {
    packageName: creds.packageName,
    credentials: creds.serviceAccount as GoogleServiceAccountCredentials,
  };
}

async function verifyGoogleReceipt(
  args: VerifyReceiptArgs,
): Promise<VerifyReceiptResult> {
  const verifyConfig = await loadGoogleConfig(args.projectId);

  const product = (await drizzle.offeringRepo.findProductByIdentifierOrStoreId(
    drizzle.db,
    args.projectId,
    args.productId,
    "google",
    args.productId,
  )) as Product | null;
  if (!product) {
    throw new HTTPException(404, {
      message: `Product not found: ${args.productId}`,
    });
  }

  if (product.type === ProductType.SUBSCRIPTION) {
    return verifyGoogleSubscriptionReceipt(args, product, verifyConfig);
  }

  return verifyGoogleProductReceipt(args, product, verifyConfig);
}

async function verifyGoogleSubscriptionReceipt(
  args: VerifyReceiptArgs,
  product: Product,
  verifyConfig: GoogleVerifyConfig,
): Promise<VerifyReceiptResult> {
  let subscription;
  try {
    subscription = await googleCircuit.exec(() =>
      verifyGoogleSubscription(verifyConfig, args.receipt),
    );
  } catch (err) {
    log.warn("google subscription verification failed", {
      circuit: googleCircuit.state,
      err: err instanceof Error ? err.message : String(err),
    });
    throw new HTTPException(
      googleCircuit.state === "OPEN" ? 503 : 400,
      { message: "Google receipt verification failed" },
    );
  }

  const subscriber = await reconcileGoogleReceiptSubscriber({
    projectId: args.projectId,
    appUserId: args.appUserId,
    purchaseToken: args.receipt,
  });

  const lineItem = subscription.lineItems?.[0];
  const expiresDate = lineItem?.expiryTime
    ? new Date(lineItem.expiryTime)
    : null;
  const startTime = subscription.startTime
    ? new Date(subscription.startTime)
    : new Date();

  // FINDING 1: guarded read + upsert in one tx (mechanism (a)); the
  // upsert also CASE-guards the terminal status at SQL level (b).
  const purchase = (await drizzle.db.transaction(async (tx) => {
    const guard = await guardStatusWrite({
      db: tx,
      projectId: args.projectId,
      store: Store.PLAY_STORE,
      storeTransactionId: args.receipt,
      to: PurchaseStatus.ACTIVE,
      source: "receipt-verify",
    });

    return drizzle.purchaseRepo.upsertPurchase(tx, {
      store: Store.PLAY_STORE,
      storeTransactionId: args.receipt,
      create: {
        projectId: args.projectId,
        subscriberId: subscriber.id,
        productId: product.id,
        store: Store.PLAY_STORE,
        storeTransactionId: args.receipt,
        originalTransactionId:
          subscription.linkedPurchaseToken ?? args.receipt,
        status: PurchaseStatus.ACTIVE,
        purchaseDate: startTime,
        originalPurchaseDate: startTime,
        expiresDate,
        environment: Environment.PRODUCTION,
        autoRenewStatus:
          lineItem?.autoRenewingPlan?.autoRenewEnabled ?? null,
        verifiedAt: new Date(),
      },
      update: {
        ...(guard.apply ? { status: PurchaseStatus.ACTIVE } : {}),
        expiresDate,
        autoRenewStatus:
          lineItem?.autoRenewingPlan?.autoRenewEnabled ?? null,
        verifiedAt: new Date(),
      },
    });
  })) as unknown as Purchase;

  return { subscriber, product, purchase };
}

async function verifyGoogleProductReceipt(
  args: VerifyReceiptArgs,
  product: Product,
  verifyConfig: GoogleVerifyConfig,
): Promise<VerifyReceiptResult> {
  const storeProductId =
    (product.storeIds as { google?: string } | null)?.google ??
    product.identifier;

  let productPurchase;
  try {
    productPurchase = await googleCircuit.exec(() =>
      verifyGoogleProductPurchase(verifyConfig, storeProductId, args.receipt),
    );
  } catch (err) {
    log.warn("google product verification failed", {
      circuit: googleCircuit.state,
      err: err instanceof Error ? err.message : String(err),
    });
    throw new HTTPException(
      googleCircuit.state === "OPEN" ? 503 : 400,
      { message: "Google receipt verification failed" },
    );
  }

  const subscriber = await reconcileGoogleReceiptSubscriber({
    projectId: args.projectId,
    appUserId: args.appUserId,
    purchaseToken: args.receipt,
  });

  const purchaseTimeMs = productPurchase.purchaseTimeMillis
    ? Number(productPurchase.purchaseTimeMillis)
    : Date.now();

  const purchase = (await drizzle.purchaseRepo.upsertPurchase(drizzle.db, {
    store: Store.PLAY_STORE,
    storeTransactionId: args.receipt,
    create: {
      projectId: args.projectId,
      subscriberId: subscriber.id,
      productId: product.id,
      store: Store.PLAY_STORE,
      storeTransactionId: args.receipt,
      originalTransactionId: args.receipt,
      status: PurchaseStatus.ACTIVE,
      purchaseDate: new Date(purchaseTimeMs),
      originalPurchaseDate: new Date(purchaseTimeMs),
      environment: Environment.PRODUCTION,
      verifiedAt: new Date(),
    },
    update: {
      verifiedAt: new Date(),
    },
  })) as unknown as Purchase;

  return { subscriber, product, purchase };
}

// =============================================================
// Helpers
// =============================================================

/**
 * Resolve the canonical subscriber for an Apple receipt and bind the JWS
 * `appAccountToken`, converging any webhook-first row that already owns this
 * transaction/token (RevenueCat/Adapty transfer-on-identify model).
 *
 * The app authoritatively names the user (`appUserId`), so the app-user row is
 * canonical. If an earlier webhook created a synthetic owner for this
 * transaction — or any row already carries the token — its assets are
 * transferred onto the canonical row, it is soft-deleted as merged, and the
 * token is rebound onto the survivor. Serialised by a project-scoped advisory
 * lock on the appUserId + the transaction anchor so a concurrent
 * receipt/webhook for the same purchase can't race the merge or the unique
 * (projectId, appleAppAccountToken) slot.
 */
export async function reconcileAppleReceiptSubscriber(args: {
  projectId: string;
  appUserId: string;
  appAccountToken: string | null;
  originalTransactionId: string;
}): Promise<Subscriber> {
  const { projectId, appUserId, appAccountToken, originalTransactionId } = args;

  const { subscriber, merged } = await drizzle.db.transaction(async (tx) => {
    const keys = [
      `${projectId}:${appUserId}`,
      `${projectId}:apple:${originalTransactionId}`,
    ].sort();
    await drizzle.lockRepo.advisoryXactLock2(tx, keys[0]!, keys[1]!);

    // Canonical = the app-user subscriber. Create/touch WITHOUT the token yet:
    // a stray webhook-first row may still occupy the unique token slot.
    const canonical = await drizzle.subscriberRepo.upsertSubscriber(tx, {
      projectId,
      rovenueId: appUserId,
    });

    // Find a stray owner of this transaction/token that is not canonical:
    // first by the token binding, then by the store-transaction anchor.
    let stray: Subscriber | null = null;
    if (appAccountToken) {
      const byToken =
        await drizzle.subscriberRepo.findSubscriberByAppleAppAccountToken(
          tx,
          projectId,
          appAccountToken,
        );
      if (byToken && byToken.id !== canonical.id && !byToken.deletedAt) {
        stray = byToken as Subscriber;
      }
    }
    if (!stray) {
      const purchase =
        await drizzle.purchaseExtRepo.findPurchaseByOriginalTransaction(
          tx,
          projectId,
          originalTransactionId,
        );
      if (purchase && purchase.subscriberId !== canonical.id) {
        const owner = await drizzle.subscriberRepo.findSubscriberById(
          tx,
          purchase.subscriberId,
        );
        if (owner && !owner.deletedAt) stray = owner;
      }
    }

    let merged = false;
    if (stray) {
      // Free the unique (projectId, appleAppAccountToken) slot BEFORE rebinding
      // it onto canonical — the partial index does not exclude soft-deleted
      // rows, so a merged-away holder must surrender the token first.
      await drizzle.subscriberRepo.clearAppleAppAccountToken(tx, stray.id);
      await reassignAllAssets(
        tx,
        projectId,
        { id: stray.id, label: stray.appUserId ?? stray.rovenueId },
        { id: canonical.id, label: appUserId },
      );
      merged = true;
    }

    // Bind the (now authoritative, slot-free) token onto canonical.
    if (appAccountToken) {
      await drizzle.subscriberRepo.setAppleAppAccountToken(
        tx,
        canonical.id,
        appAccountToken,
      );
    }

    const fresh = await drizzle.subscriberRepo.findSubscriberById(
      tx,
      canonical.id,
    );
    return { subscriber: (fresh ?? canonical) as Subscriber, merged };
  });

  // Reconcile the survivor's denormalized access now that merged purchases +
  // access rows belong to it (best-effort; self-heals on next access event).
  if (merged) await safeSyncAccessAfterMerge(subscriber.id);
  return subscriber;
}

/**
 * Google analog of [`reconcileAppleReceiptSubscriber`]. Google Play's
 * `purchaseToken` (= the receipt) is the store-authoritative anchor present in
 * both the receipt and the RTDN, so convergence keys on the purchase's
 * `storeTransactionId` — no dedicated obfuscated-account-id column is needed
 * (unlike Apple, whose CONSUMPTION_REQUEST motivated the token column).
 *
 * The app authoritatively names the user (`appUserId`), so the app-user row is
 * canonical. If an earlier RTDN created a synthetic owner for this
 * `purchaseToken`, its assets are transferred onto the canonical row and it is
 * soft-deleted as merged. Serialised by a project-scoped advisory lock on the
 * appUserId + the purchaseToken anchor.
 */
export async function reconcileGoogleReceiptSubscriber(args: {
  projectId: string;
  appUserId: string;
  purchaseToken: string;
}): Promise<Subscriber> {
  const { projectId, appUserId, purchaseToken } = args;

  const { subscriber, merged } = await drizzle.db.transaction(async (tx) => {
    const keys = [
      `${projectId}:${appUserId}`,
      `${projectId}:google:${purchaseToken}`,
    ].sort();
    await drizzle.lockRepo.advisoryXactLock2(tx, keys[0]!, keys[1]!);

    const canonical = await drizzle.subscriberRepo.upsertSubscriber(tx, {
      projectId,
      rovenueId: appUserId,
    });

    // Stray = a different subscriber that already owns this purchaseToken
    // (e.g. an RTDN-first synthetic).
    let stray: Subscriber | null = null;
    const purchase = await drizzle.purchaseExtRepo.findPurchaseByStoreTransaction(
      tx,
      projectId,
      Store.PLAY_STORE,
      purchaseToken,
    );
    if (purchase && purchase.subscriberId !== canonical.id) {
      const owner = await drizzle.subscriberRepo.findSubscriberById(
        tx,
        purchase.subscriberId,
      );
      if (owner && !owner.deletedAt) stray = owner;
    }

    let merged = false;
    if (stray) {
      await reassignAllAssets(
        tx,
        projectId,
        { id: stray.id, label: stray.appUserId ?? stray.rovenueId },
        { id: canonical.id, label: appUserId },
      );
      merged = true;
    }

    return { subscriber: canonical as Subscriber, merged };
  });

  if (merged) await safeSyncAccessAfterMerge(subscriber.id);
  return subscriber;
}
