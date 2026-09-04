import { HTTPException } from "hono/http-exception";
import {
  Environment,
  ProductType,
  PurchaseStatus,
  RevenueEventType,
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
import { appleStorefrontToCountry } from "./apple/apple-country";
import { normalizeAlpha2Country } from "./country";
import {
  APPLE_ENVIRONMENT,
  APPLE_OFFER_TYPE,
  type AppleEnvironment,
  type AppleJwsTransactionPayload,
} from "./apple/apple-types";
import { ERROR_CODE } from "@rovenue/shared";
import {
  verifyGoogleProductPurchase,
  verifyGoogleSubscription,
} from "./google/google-verify";
import type {
  GoogleServiceAccountCredentials,
  GoogleVerifyConfig,
} from "./google";
import {
  GOOGLE_PRODUCT_PURCHASE_STATE,
  GOOGLE_SUBSCRIPTION_STATE,
  type GoogleSubscriptionState,
} from "./google/google-types";
import {
  effectiveGoogleOrderId,
  isGoogleRenewalOrderId,
  mapSubscriptionStateToStatus,
} from "./google/google-mappers";
import {
  resolveOneTimeProductPricing,
  resolveSubscriptionPricing,
} from "./google/google-pricing";
import { expireSupersededGooglePurchase } from "./google/google-supersede";
import { guardStatusWrite } from "./subscription-transition-guard";
import { billingIssueStamp } from "./subscription-state";
import { convertToUsd } from "./fx";
import { reassignAllAssets, safeSyncAccessAfterMerge } from "./subscriber-transfer";
import type { PresentedContext } from "../lib/presented-context";

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
  /**
   * Paywall-attribution snapshot from the placement that served the SDK's
   * purchase flow. Persisted onto the purchase row as-is and folded into
   * the co-located revenue event's outbox metadata; never validated
   * against live placement/paywall/experiment rows.
   */
  presentedContext?: PresentedContext | null;
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

  // Security: the client supplies `args.productId`, but the resolved product
  // MUST correspond to the JWS-verified `transaction.productId`. The lookup
  // matches on `identifier = <client> OR storeIds.apple = <verified>`, so a
  // valid cheap receipt paired with an expensive product identifier could
  // otherwise resolve — and grant — the expensive product's currency bundle.
  // A product corresponds when its Apple store id equals the verified id, or
  // (for products with no explicit Apple store id) its identifier does.
  const appleStoreId = (product.storeIds as { apple?: string } | null)?.apple;
  const productMatchesTransaction =
    appleStoreId != null
      ? appleStoreId === transaction.productId
      : product.identifier === transaction.productId;
  if (!productMatchesTransaction) {
    throw new HTTPException(400, {
      message: "productId does not match the verified transaction",
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
  // Event-time ordering: the JWS's signedDate is when Apple attested this
  // transaction state — a receipt carrying an OLDER attestation than the
  // last applied store event (e.g. a restore replayed after a newer
  // webhook) must not regress status. signedDate is always present on a
  // real JWS; fall back to verification time defensively.
  const appleEventTime = Number.isFinite(transaction.signedDate)
    ? new Date(transaction.signedDate)
    : new Date();
  const purchase = (await drizzle.db.transaction(async (tx) => {
    const guard = await guardStatusWrite({
      db: tx,
      projectId: args.projectId,
      store: Store.APP_STORE,
      storeTransactionId: transaction.transactionId,
      to: status,
      source: "receipt-verify",
      eventTime: appleEventTime,
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
        // The offer this transaction came from, at full fidelity beside
        // the boolean that collapses all four kinds into one. Written
        // here as well as on the webhook path because a purchase is very
        // often FIRST observed here: a promotional, offer-code or
        // win-back purchase whose columns were left null until (or
        // unless) an Apple notification arrived would be missing from
        // exactly the cohort these columns exist to make queryable.
        offerType: transaction.offerType ?? null,
        offerIdentifier: transaction.offerIdentifier ?? null,
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
        lastStoreEventAt: appleEventTime,
        presentedContext: args.presentedContext ?? null,
      },
      update: {
        ...(guard.apply
          ? {
              status,
              lastStoreEventAt: appleEventTime,
              // Task 4 (2026-09-04): this path only ever writes
              // ACTIVE/TRIAL, so the only thing billingIssueStamp can do
              // here is clear a stale stamp on recovery from BILLING_ISSUE
              // — a receipt re-verify catching a payment fix the webhook
              // hasn't delivered yet.
              ...billingIssueStamp(guard.from, status, appleEventTime),
            }
          : {}),
        expiresDate: transaction.expiresDate
          ? new Date(transaction.expiresDate)
          : null,
        ...(transaction.price != null && {
          priceAmount: (transaction.price / 1_000_000).toString(),
        }),
        ...(transaction.currency != null && {
          priceCurrency: transaction.currency,
        }),
        // Present-only, exactly like `priceAmount`/`priceCurrency` above
        // and like the webhook's update path: `?? null` would erase a
        // recorded offer as soon as any later verify for this transaction
        // omitted the field. An absent field says nothing about the
        // offer; it does not say there wasn't one.
        ...(transaction.offerType !== undefined && {
          offerType: transaction.offerType,
        }),
        ...(transaction.offerIdentifier !== undefined && {
          offerIdentifier: transaction.offerIdentifier,
        }),
        // Only overwrite an already-recorded attribution when this call
        // actually supplies one — a later renewal-triggering verify (no
        // presentedContext) must not null out the original purchase's
        // attribution.
        ...(args.presentedContext && { presentedContext: args.presentedContext }),
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
      metadata: args.presentedContext
        ? { presentedContext: args.presentedContext }
        : undefined,
      // The store's own per-transaction country, normalised from Apple's
      // alpha-3 storefront to the house alpha-2 format (never the
      // subscriber's last-known SDK-reported one — see
      // CreateRevenueEventInput.country). Fails closed to no country on
      // an unrecognised code.
      country: appleStorefrontToCountry(transaction.storefront),
      eventDate: new Date(transaction.purchaseDate),
      dedupeKey: `apple:${transaction.transactionId}:${revenueDedupeKind(type)}`,
    });
  }

  return { subscriber, product, purchase };
}

// =============================================================
// Google receipt (purchaseToken)
// =============================================================

// Google subscription states that leave the purchase access-granting on the
// receipt path: ACTIVE and IN_GRACE_PERIOD are paid (or paid-through);
// CANCELED means auto-renew off with access running until expiry. Everything
// else is either unpaid (PENDING → rejected with PURCHASE_NOT_PAID) or lapsed
// (ON_HOLD / PAUSED / EXPIRED / unknown → mapped to its non-access status via
// the shared RTDN mapper, never hardcoded ACTIVE).
const GOOGLE_ACCESS_ELIGIBLE_SUBSCRIPTION_STATES: ReadonlySet<GoogleSubscriptionState> =
  new Set<GoogleSubscriptionState>([
    GOOGLE_SUBSCRIPTION_STATE.ACTIVE,
    GOOGLE_SUBSCRIPTION_STATE.IN_GRACE_PERIOD,
    GOOGLE_SUBSCRIPTION_STATE.CANCELED,
  ]);

// Shared 400 body for a receipt whose purchase the user has not paid for yet
// (subscription PENDING / one-time purchaseState PENDING). The purchase may
// still complete, so the client retries verification after payment.
const PURCHASE_NOT_PAID_MESSAGE =
  "Google purchase has not been paid yet; retry verification after payment completes";

function purchaseNotPaidError(): HTTPException {
  return new HTTPException(400, {
    message: PURCHASE_NOT_PAID_MESSAGE,
    cause: ERROR_CODE.PURCHASE_NOT_PAID,
  });
}

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

  // Security: the client supplies `args.productId`, but the resolved product
  // MUST correspond to a `subscriptionsv2.get`-verified line item.
  // `subscriptionsv2.get` is token-only, so a valid cheap-subscription token
  // paired with an expensive product's identifier would otherwise resolve —
  // and grant — the expensive product (the exact Apple check ported here).
  // A product corresponds when its Google store id equals a verified
  // `lineItems[].productId`, or (for products with no explicit Google store
  // id) its identifier does. The matching line item — never blindly
  // `lineItems[0]` — then drives expiry/autorenew extraction below.
  const googleStoreProductId =
    (product.storeIds as { google?: string } | null)?.google ??
    product.identifier;
  const lineItem = subscription.lineItems?.find(
    (item) => item.productId === googleStoreProductId,
  );
  if (!lineItem) {
    throw new HTTPException(400, {
      message: "productId does not match the verified transaction",
    });
  }

  // Entitlement gate: a fetchable token only proves the purchase exists —
  // `subscriptionState` decides access. PENDING means the user has not
  // completed payment, so nothing is persisted and the client retries after
  // payment. Every other state maps through the same mapper the RTDN webhook
  // uses, so the two paths can never disagree on what a state grants.
  const subscriptionState = subscription.subscriptionState;
  if (subscriptionState === GOOGLE_SUBSCRIPTION_STATE.PENDING) {
    throw purchaseNotPaidError();
  }
  const status = mapSubscriptionStateToStatus(subscriptionState);
  if (!GOOGLE_ACCESS_ELIGIBLE_SUBSCRIPTION_STATES.has(subscriptionState)) {
    log.warn("google subscription receipt in non-access state", {
      projectId: args.projectId,
      state: subscriptionState,
      status,
    });
  }

  const subscriber = await reconcileGoogleReceiptSubscriber({
    projectId: args.projectId,
    appUserId: args.appUserId,
    purchaseToken: args.receipt,
  });

  const expiresDate = lineItem.expiryTime
    ? new Date(lineItem.expiryTime)
    : null;
  const startTime = subscription.startTime
    ? new Date(subscription.startTime)
    : new Date();

  // Same pricing machinery the RTDN webhook uses (list price of the base
  // plan; charged-amount via orders.get is deferred — plan Task 10.2).
  const pricing = await resolveSubscriptionPricing(verifyConfig, {
    productId: googleStoreProductId,
    basePlanId: lineItem.offerDetails?.basePlanId,
    regionCode: subscription.regionCode,
  });

  // FINDING 1: guarded read + upsert in one tx (mechanism (a)); the
  // upsert also CASE-guards the terminal status at SQL level (b).
  //
  // Event-time ordering: the status comes from a LIVE subscriptionsv2.get,
  // so the fetch moment is when this state was true at the store.
  const googleEventTime = new Date();
  const purchase = (await drizzle.db.transaction(async (tx) => {
    const guard = await guardStatusWrite({
      db: tx,
      projectId: args.projectId,
      store: Store.PLAY_STORE,
      storeTransactionId: args.receipt,
      to: status,
      source: "receipt-verify",
      eventTime: googleEventTime,
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
        status,
        purchaseDate: startTime,
        originalPurchaseDate: startTime,
        expiresDate,
        environment: Environment.PRODUCTION,
        autoRenewStatus:
          lineItem?.autoRenewingPlan?.autoRenewEnabled ?? null,
        // Drizzle decimal columns round-trip as strings.
        priceAmount: pricing != null ? pricing.amount.toString() : null,
        priceCurrency: pricing?.currency ?? null,
        verifiedAt: new Date(),
        lastStoreEventAt: googleEventTime,
        presentedContext: args.presentedContext ?? null,
        // Creation IS entry (review finding 1, 2026-09-04): a receipt
        // verify can be the very first row for a subscription that is
        // already ON_HOLD (e.g. the client only calls verify long after
        // purchase). `from` is null (no prior row), so this only ever
        // stamps or is a no-op, never clears.
        ...billingIssueStamp(null, status, googleEventTime),
      },
      update: {
        ...(guard.apply
          ? {
              status,
              lastStoreEventAt: googleEventTime,
              // Task 4 (2026-09-04): status here comes from the same
              // mapSubscriptionStateToStatus the RTDN webhook uses, so a
              // receipt re-verify can be this row's first sighting of
              // BILLING_ISSUE (or its recovery) just as much as a webhook.
              ...billingIssueStamp(guard.from, status, googleEventTime),
            }
          : {}),
        expiresDate,
        autoRenewStatus:
          lineItem?.autoRenewingPlan?.autoRenewEnabled ?? null,
        ...(pricing != null && {
          priceAmount: pricing.amount.toString(),
          priceCurrency: pricing.currency,
        }),
        verifiedAt: new Date(),
        ...(args.presentedContext && { presentedContext: args.presentedContext }),
      },
    });
  })) as unknown as Purchase;

  // Upgrade/downgrade replacement (mirrors the RTDN webhook): expire the
  // linkedPurchaseToken predecessor so the old tier's access can't outlive
  // the replacement.
  if (subscription.linkedPurchaseToken) {
    await expireSupersededGooglePurchase({
      projectId: args.projectId,
      supersededToken: subscription.linkedPurchaseToken,
      currentToken: args.receipt,
      source: "receipt-verify",
    });
  }

  // R6 (Google): record revenue on the receipt path too, mirroring the Apple
  // block above. The dedupe key converges on the SAME shape the RTDN webhook
  // uses — `google:<orderId ?? purchaseToken>:<kind>` — so whichever path
  // lands first records the row and the other is a no-op. Only paid /
  // paid-through states record revenue, and a pricing miss NEVER falls back
  // to a 0-USD row.
  if (GOOGLE_ACCESS_ELIGIBLE_SUBSCRIPTION_STATES.has(subscriptionState)) {
    if (!pricing) {
      log.error(
        "google subscription pricing unresolvable; skipping receipt revenue event",
        {
          projectId: args.projectId,
          tokenPrefix: args.receipt.slice(0, 12),
          productId: googleStoreProductId,
          basePlanId: lineItem.offerDetails?.basePlanId,
        },
      );
    } else {
      const orderId = effectiveGoogleOrderId(subscription, lineItem);
      // No RTDN notificationType here — classify from the order id: Google
      // suffixes renewal orders with `..N`, the bare id is the first order.
      const type =
        orderId != null && isGoogleRenewalOrderId(orderId)
          ? RevenueEventType.RENEWAL
          : RevenueEventType.INITIAL;
      const amountUsd = await convertToUsd(pricing.amount, pricing.currency);
      await drizzle.revenueEventRepo.createRevenueEvent(drizzle.db, {
        projectId: args.projectId,
        subscriberId: subscriber.id,
        purchaseId: purchase.id,
        productId: product.id,
        type,
        amount: pricing.amount.toString(),
        currency: pricing.currency,
        amountUsd: amountUsd.toString(),
        store: Store.PLAY_STORE,
        metadata: args.presentedContext
          ? { presentedContext: args.presentedContext }
          : undefined,
        // Processing time, matching the webhook (partition-safe; replay
        // dedup is enforced by the revenue_event_dedupe table).
        eventDate: new Date(),
        dedupeKey: `google:${orderId ?? args.receipt}:${revenueDedupeKind(type)}`,
        // The store's own per-transaction billing country from the LIVE
        // subscriptionsv2.get response — same field, same semantics as
        // the RTDN webhook's country wiring above. Already house-format
        // alpha-2; normalizeAlpha2Country only validates + fails closed.
        country: normalizeAlpha2Country(subscription.regionCode),
      });
    }
  }

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

  // Credit-grant gate: only purchaseState PURCHASED is money in the bank.
  // CANCELED is an invalid receipt; PENDING — and anything unrecognized —
  // is not paid, so nothing is persisted (and the route's consumable credit
  // grant never runs) until a paid re-verify.
  const purchaseState = productPurchase.purchaseState;
  if (purchaseState === GOOGLE_PRODUCT_PURCHASE_STATE.CANCELED) {
    throw new HTTPException(400, {
      message: "Google purchase is canceled",
    });
  }
  if (purchaseState !== GOOGLE_PRODUCT_PURCHASE_STATE.PURCHASED) {
    throw purchaseNotPaidError();
  }

  const subscriber = await reconcileGoogleReceiptSubscriber({
    projectId: args.projectId,
    appUserId: args.appUserId,
    purchaseToken: args.receipt,
  });

  const purchaseTimeMs = productPurchase.purchaseTimeMillis
    ? Number(productPurchase.purchaseTimeMillis)
    : Date.now();

  // List price of the managed product (same deferral as subscriptions:
  // charged-amount via orders.get is plan Task 10.2).
  const pricing = await resolveOneTimeProductPricing(verifyConfig, {
    productId: storeProductId,
    regionCode: productPurchase.regionCode ?? undefined,
  });

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
      // Drizzle decimal columns round-trip as strings.
      priceAmount: pricing != null ? pricing.amount.toString() : null,
      priceCurrency: pricing?.currency ?? null,
      verifiedAt: new Date(),
      presentedContext: args.presentedContext ?? null,
    },
    update: {
      verifiedAt: new Date(),
      ...(pricing != null && {
        priceAmount: pricing.amount.toString(),
        priceCurrency: pricing.currency,
      }),
      ...(args.presentedContext && { presentedContext: args.presentedContext }),
    },
  })) as unknown as Purchase;

  // R6 (Google one-time): this is the ONLY revenue path for Google one-time
  // purchases — the one-time RTDN branch is persist-only. Key on the order
  // id (ProductPurchase.orderId) with the purchaseToken fallback, in the
  // same webhook-converged `google:<id>:<kind>` shape. A pricing miss
  // NEVER falls back to a 0-USD row.
  if (!pricing) {
    log.error(
      "google one-time pricing unresolvable; skipping receipt revenue event",
      {
        projectId: args.projectId,
        tokenPrefix: args.receipt.slice(0, 12),
        productId: storeProductId,
      },
    );
  } else {
    const type = RevenueEventType.INITIAL;
    const amountUsd = await convertToUsd(pricing.amount, pricing.currency);
    await drizzle.revenueEventRepo.createRevenueEvent(drizzle.db, {
      projectId: args.projectId,
      subscriberId: subscriber.id,
      purchaseId: purchase.id,
      productId: product.id,
      type,
      amount: pricing.amount.toString(),
      currency: pricing.currency,
      amountUsd: amountUsd.toString(),
      store: Store.PLAY_STORE,
      metadata: args.presentedContext
        ? { presentedContext: args.presentedContext }
        : undefined,
      eventDate: new Date(purchaseTimeMs),
      dedupeKey: `google:${productPurchase.orderId ?? args.receipt}:${revenueDedupeKind(type)}`,
      // Same per-transaction billing country field as the subscription
      // path, on the one-time ProductPurchase resource
      // (`purchases.products.get` — regionCode is also documented by
      // Google as "at the time the product was granted").
      country: normalizeAlpha2Country(productPurchase.regionCode ?? undefined),
    });
  }

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
