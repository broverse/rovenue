import { HTTPException } from "hono/http-exception";
import prisma, {
  Environment,
  ProductType,
  PurchaseStatus,
  Store,
  type Product,
  type Purchase,
  type Subscriber,
} from "@rovenue/db";
import { logger } from "../lib/logger";
import { JoseAppleNotificationVerifier } from "./apple/apple-verify";
import { APPLE_ENVIRONMENT, APPLE_OFFER_TYPE } from "./apple/apple-types";
import {
  verifyGoogleProductPurchase,
  verifyGoogleSubscription,
} from "./google/google-verify";
import type {
  GoogleServiceAccountCredentials,
  GoogleVerifyConfig,
} from "./google";
import { z } from "zod";

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

async function verifyAppleReceipt(
  args: VerifyReceiptArgs,
): Promise<VerifyReceiptResult> {
  const verifier = new JoseAppleNotificationVerifier();

  let transaction;
  try {
    transaction = await verifier.verifyTransaction(args.receipt);
  } catch (err) {
    log.warn("apple receipt verification failed", {
      projectId: args.projectId,
      err: err instanceof Error ? err.message : String(err),
    });
    throw new HTTPException(400, {
      message: "Invalid Apple receipt",
    });
  }

  const product = await prisma.product.findFirst({
    where: {
      projectId: args.projectId,
      OR: [
        { identifier: args.productId },
        { storeIds: { path: ["apple"], equals: transaction.productId } },
      ],
    },
  });
  if (!product) {
    throw new HTTPException(404, {
      message: `Product not found for Apple productId ${transaction.productId}`,
    });
  }

  const subscriber = await upsertSubscriber(args.projectId, args.appUserId);

  const environment =
    transaction.environment === APPLE_ENVIRONMENT.PRODUCTION
      ? Environment.PRODUCTION
      : Environment.SANDBOX;
  const isTrial = transaction.offerType === APPLE_OFFER_TYPE.INTRODUCTORY;
  const status = isTrial ? PurchaseStatus.TRIAL : PurchaseStatus.ACTIVE;

  const purchase = await prisma.purchase.upsert({
    where: {
      store_storeTransactionId: {
        store: Store.APP_STORE,
        storeTransactionId: transaction.transactionId,
      },
    },
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
      priceAmount:
        transaction.price != null ? transaction.price / 1_000_000 : null,
      priceCurrency: transaction.currency ?? null,
      ownershipType: transaction.inAppOwnershipType,
      verifiedAt: new Date(),
    },
    update: {
      status,
      expiresDate: transaction.expiresDate
        ? new Date(transaction.expiresDate)
        : null,
      priceAmount:
        transaction.price != null ? transaction.price / 1_000_000 : undefined,
      priceCurrency: transaction.currency ?? undefined,
      verifiedAt: new Date(),
    },
  });

  return { subscriber, product, purchase };
}

// =============================================================
// Google receipt (purchaseToken)
// =============================================================

const googleCredentialsSchema = z
  .object({
    packageName: z.string().min(1),
    serviceAccount: z
      .object({
        client_email: z.string().email(),
        private_key: z.string().min(1),
      })
      .passthrough(),
  })
  .passthrough();

async function loadGoogleConfig(
  projectId: string,
): Promise<GoogleVerifyConfig> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { googleCredentials: true },
  });
  if (!project?.googleCredentials) {
    throw new HTTPException(400, {
      message: "Project not configured for Google Play",
    });
  }
  const parsed = googleCredentialsSchema.safeParse(project.googleCredentials);
  if (!parsed.success) {
    throw new HTTPException(500, {
      message: "Invalid Google credentials in project config",
    });
  }
  return {
    packageName: parsed.data.packageName,
    credentials: parsed.data.serviceAccount as GoogleServiceAccountCredentials,
  };
}

async function verifyGoogleReceipt(
  args: VerifyReceiptArgs,
): Promise<VerifyReceiptResult> {
  const verifyConfig = await loadGoogleConfig(args.projectId);

  const product = await prisma.product.findFirst({
    where: {
      projectId: args.projectId,
      OR: [
        { identifier: args.productId },
        { storeIds: { path: ["google"], equals: args.productId } },
      ],
    },
  });
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
    subscription = await verifyGoogleSubscription(verifyConfig, args.receipt);
  } catch (err) {
    log.warn("google subscription verification failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    throw new HTTPException(400, { message: "Invalid Google receipt" });
  }

  const subscriber = await upsertSubscriber(args.projectId, args.appUserId);

  const lineItem = subscription.lineItems?.[0];
  const expiresDate = lineItem?.expiryTime
    ? new Date(lineItem.expiryTime)
    : null;
  const startTime = subscription.startTime
    ? new Date(subscription.startTime)
    : new Date();

  const purchase = await prisma.purchase.upsert({
    where: {
      store_storeTransactionId: {
        store: Store.PLAY_STORE,
        storeTransactionId: args.receipt,
      },
    },
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
      status: PurchaseStatus.ACTIVE,
      expiresDate,
      autoRenewStatus:
        lineItem?.autoRenewingPlan?.autoRenewEnabled ?? null,
      verifiedAt: new Date(),
    },
  });

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
    productPurchase = await verifyGoogleProductPurchase(
      verifyConfig,
      storeProductId,
      args.receipt,
    );
  } catch (err) {
    log.warn("google product verification failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    throw new HTTPException(400, { message: "Invalid Google receipt" });
  }

  const subscriber = await upsertSubscriber(args.projectId, args.appUserId);

  const purchaseTimeMs = productPurchase.purchaseTimeMillis
    ? Number(productPurchase.purchaseTimeMillis)
    : Date.now();

  const purchase = await prisma.purchase.upsert({
    where: {
      store_storeTransactionId: {
        store: Store.PLAY_STORE,
        storeTransactionId: args.receipt,
      },
    },
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
  });

  return { subscriber, product, purchase };
}

// =============================================================
// Helpers
// =============================================================

async function upsertSubscriber(
  projectId: string,
  appUserId: string,
): Promise<Subscriber> {
  return prisma.subscriber.upsert({
    where: { projectId_appUserId: { projectId, appUserId } },
    update: { lastSeenAt: new Date() },
    create: { projectId, appUserId },
  });
}
