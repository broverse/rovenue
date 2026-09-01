import {
  Environment,
  RevenueEventType,
  WebhookEventStatus,
  WebhookSource,
  Store,
  PurchaseStatus,
  drizzle,
  revenueDedupeKind,
} from "@rovenue/db";
import { logger } from "../../lib/logger";
import { convertToUsd } from "../fx";
import { normalizeAlpha2Country } from "../country";
import { maybeEmitRefundDetected } from "../notifications/refund-emit";
import {
  GOOGLE_ACKNOWLEDGEMENT_STATE,
  type GooglePubSubPushBody,
  type GoogleRtdnSubscriptionNotification,
  type GoogleSubscriptionPurchaseV2,
} from "./google-types";
import {
  classifyNotification,
  effectiveGoogleOrderId,
  extractCancelTime,
  isAccessGranting,
  mapRevenueEventType,
  mapStatus,
  parsePushBody,
} from "./google-mappers";
import { expireSupersededGooglePurchase } from "./google-supersede";
import {
  acknowledgeGoogleSubscription,
  verifyGoogleSubscription,
  type GoogleVerifyConfig,
} from "./google-verify";
import { resolveSubscriptionPricing } from "./google-pricing";
import { guardStatusWrite } from "../subscription-transition-guard";
// Type-only: no runtime cycle with webhook-processor (which imports us).
import type { WebhookPostProcess } from "../webhook-processor";

const log = logger.child("google-webhook");

// =============================================================
// Public API
// =============================================================

export interface HandleGoogleNotificationOptions {
  projectId: string;
  pushBody: GooglePubSubPushBody;
  /**
   * Credentials + packageName for calling the Android Publisher API. If
   * omitted, the notification is persisted without fetching authoritative
   * state from Google (useful during initial setup before credentials are
   * configured).
   */
  verifyConfig?: GoogleVerifyConfig;
  /**
   * Side effects (access sync, consumable credit, outgoing webhook),
   * injected by webhook-processor. Runs AFTER dispatch but BEFORE the
   * row is marked PROCESSED: a failure lands in the catch below
   * (row → FAILED, re-claimable) and rethrows so BullMQ retries —
   * marking PROCESSED first would dedupe the retry to `duplicate` and
   * lose the side effect permanently.
   */
  postProcess?: WebhookPostProcess;
}

export type HandleGoogleNotificationResult =
  | {
      status: "processed";
      kind: string;
      webhookEventId: string;
      subscriberId?: string;
      purchaseId?: string;
    }
  | { status: "duplicate"; kind: string }
  | { status: "test" }
  | { status: "persisted-no-verify"; kind: string; webhookEventId: string };

interface GoogleDispatchOutcome {
  subscriberId?: string;
  purchaseId?: string;
}

export async function handleGoogleNotification(
  opts: HandleGoogleNotificationOptions,
): Promise<HandleGoogleNotificationResult> {
  const payload = parsePushBody(opts.pushBody);

  if (payload.testNotification) {
    log.info("received test notification", {
      packageName: payload.packageName,
      version: payload.testNotification.version,
    });
    return { status: "test" };
  }

  // Dedup key = Pub/Sub messageId: stable across redeliveries of the
  // same message, unique across distinct notifications — the exact
  // analog of Apple's notificationUUID. NEVER the purchaseToken:
  // Google reuses one token for every lifecycle RTDN of a subscription
  // (RENEWED, CANCELED, IN_GRACE_PERIOD, EXPIRED, REVOKED, voided), so
  // keying on it silently dropped every event after the first
  // PROCESSED one. The token still drives purchase lookup below.
  const storeEventId = opts.pushBody.message.messageId;

  const kind = classifyNotification(payload);

  // Atomic single-flight claim — exactly one concurrent worker wins.
  const claim = await drizzle.webhookEventRepo.claimWebhookEvent(drizzle.db, {
    projectId: opts.projectId,
    source: WebhookSource.GOOGLE,
    eventType: kind,
    storeEventId,
    // The raw Pub/Sub push body is stored alongside the decoded
    // notification so the webhook reaper can rebuild and re-enqueue the
    // processing job for a stranded row.
    payload: {
      pushBody: opts.pushBody,
      notification: JSON.parse(JSON.stringify(payload)),
    },
  });

  if (claim.outcome === "duplicate") {
    log.info("notification already processed, skipping", { storeEventId, kind });
    return { status: "duplicate", kind };
  }
  if (claim.outcome === "in_progress") {
    // Another worker holds a fresh claim. Throw so BullMQ retries with
    // backoff instead of acking — prevents the historical bug where a
    // retry of our own crashed attempt silently dropped the event.
    throw new Error(`webhook ${storeEventId} claim in progress; retry`);
  }
  const webhookEvent = claim.row;

  if (!opts.verifyConfig) {
    log.warn("no verify config, persisting without API verification", {
      projectId: opts.projectId,
      kind,
    });
    await drizzle.webhookEventRepo.updateWebhookEvent(
      drizzle.db,
      webhookEvent.id,
      {
        status: WebhookEventStatus.PROCESSED,
        processedAt: new Date(),
      },
    );
    return {
      status: "persisted-no-verify",
      kind,
      webhookEventId: webhookEvent.id,
    };
  }

  try {
    let outcome: GoogleDispatchOutcome = {};

    if (payload.subscriptionNotification) {
      outcome =
        (await processSubscriptionNotification({
          projectId: opts.projectId,
          notification: payload.subscriptionNotification,
          verifyConfig: opts.verifyConfig,
        })) ?? {};
    } else if (payload.voidedPurchaseNotification) {
      outcome =
        (await processVoidedPurchase({
          projectId: opts.projectId,
          purchaseToken: payload.voidedPurchaseNotification.purchaseToken,
        })) ?? {};
    } else if (payload.oneTimeProductNotification) {
      // One-time purchases are processed (verified, upserted, revenue
      // recorded) by the receipt-verify path, which the SDK calls right
      // after purchase. Wiring the RTDN into that verification/upsert
      // pipeline is deferred — this branch records the event row above
      // and nothing else. NOTE: no server-side acknowledge happens here
      // either (one-time acks are the client SDK's job via BillingClient).
      log.warn(
        "one-time product notification persisted only; processing is deferred to the receipt-verify path",
        { sku: payload.oneTimeProductNotification.sku },
      );
    }

    // Side effects BEFORE the PROCESSED mark — see postProcess docs.
    if (opts.postProcess) {
      await opts.postProcess({
        webhookEventId: webhookEvent.id,
        eventType: kind,
        subscriberId: outcome.subscriberId,
        purchaseId: outcome.purchaseId,
      });
    }

    await drizzle.webhookEventRepo.updateWebhookEvent(
      drizzle.db,
      webhookEvent.id,
      {
        status: WebhookEventStatus.PROCESSED,
        processedAt: new Date(),
        subscriberId: outcome.subscriberId,
        purchaseId: outcome.purchaseId,
      },
    );

    return {
      status: "processed",
      kind,
      webhookEventId: webhookEvent.id,
      subscriberId: outcome.subscriberId,
      purchaseId: outcome.purchaseId,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await drizzle.webhookEventRepo.updateWebhookEvent(
      drizzle.db,
      webhookEvent.id,
      {
        status: WebhookEventStatus.FAILED,
        errorMessage: message,
        incrementRetryCount: true,
      },
    );
    log.error("notification processing failed", {
      storeEventId,
      kind,
      err: message,
    });
    throw err;
  }
}

// =============================================================
// Subscription notification processing
// =============================================================

interface SubscriptionCtx {
  projectId: string;
  notification: GoogleRtdnSubscriptionNotification;
  verifyConfig: GoogleVerifyConfig;
}

async function processSubscriptionNotification(
  ctx: SubscriptionCtx,
): Promise<GoogleDispatchOutcome> {
  const purchase = await verifyGoogleSubscription(
    ctx.verifyConfig,
    ctx.notification.purchaseToken,
  );

  const subscriber = await resolveSubscriber(ctx);

  const lineItem = purchase.lineItems?.[0];
  const productId = lineItem?.productId ?? ctx.notification.subscriptionId;
  const product = await drizzle.offeringRepo.findProductByStoreId(
    drizzle.db,
    ctx.projectId,
    "google",
    productId,
  );
  if (!product) {
    throw new Error(
      `No product mapped for Google productId ${productId} in project ${ctx.projectId}`,
    );
  }

  const status = mapStatus(
    purchase.subscriptionState,
    ctx.notification.notificationType,
  );
  const expiresDate = lineItem?.expiryTime ? new Date(lineItem.expiryTime) : null;
  const startTime = purchase.startTime
    ? new Date(purchase.startTime)
    : new Date();
  const autoRenewStatus = lineItem?.autoRenewingPlan?.autoRenewEnabled ?? null;
  const cancellationDate = extractCancelTime(purchase);

  const pricing = await resolveSubscriptionPricing(ctx.verifyConfig, {
    productId,
    basePlanId: lineItem?.offerDetails?.basePlanId,
    regionCode: purchase.regionCode,
  });

  // FINDING 1: guarded read + upsert in one tx so the FOR UPDATE lock
  // is held across the write (mechanism (a)); upsertPurchase also
  // CASE-guards the terminal status at SQL level (mechanism (b)).
  //
  // Event-time ordering: the status derives from the LIVE
  // subscriptionsv2.get above, so the fetch moment is when this state was
  // true at the store — a retry-reordered older tick can't regress it.
  const eventTime = new Date();
  const { persisted, guard } = await drizzle.db.transaction(async (dbTx) => {
    const decided = await guardStatusWrite({
      db: dbTx,
      projectId: ctx.projectId,
      store: Store.PLAY_STORE,
      storeTransactionId: ctx.notification.purchaseToken,
      to: status,
      source: `google:${ctx.notification.notificationType}`,
      eventTime,
    });

    const row = await drizzle.purchaseRepo.upsertPurchase(dbTx, {
      store: Store.PLAY_STORE,
      storeTransactionId: ctx.notification.purchaseToken,
      create: {
        projectId: ctx.projectId,
        subscriberId: subscriber.id,
        productId: product.id,
        store: Store.PLAY_STORE,
        storeTransactionId: ctx.notification.purchaseToken,
        originalTransactionId:
          purchase.linkedPurchaseToken ?? ctx.notification.purchaseToken,
        status,
        purchaseDate: startTime,
        originalPurchaseDate: startTime,
        expiresDate,
        environment: Environment.PRODUCTION,
        autoRenewStatus,
        cancellationDate,
        // Drizzle decimal columns round-trip as strings.
        priceAmount: pricing?.amount != null ? pricing.amount.toString() : null,
        priceCurrency: pricing?.currency ?? null,
        verifiedAt: new Date(),
        lastStoreEventAt: eventTime,
      },
      update: {
        ...(decided.apply ? { status, lastStoreEventAt: eventTime } : {}),
        expiresDate,
        autoRenewStatus,
        cancellationDate,
        ...(pricing?.amount != null && {
          priceAmount: pricing.amount.toString(),
        }),
        ...(pricing?.currency != null && { priceCurrency: pricing.currency }),
        verifiedAt: new Date(),
      },
    });
    return { persisted: row, guard: decided };
  });

  // Upgrade/downgrade replacement: Google points at the retired token via
  // linkedPurchaseToken and sends no independent RTDN for it — expire that
  // row (and revoke its access) or the old tier stays granted until its
  // frozen expiresDate lapses.
  if (purchase.linkedPurchaseToken) {
    await expireSupersededGooglePurchase({
      projectId: ctx.projectId,
      supersededToken: purchase.linkedPurchaseToken,
      currentToken: ctx.notification.purchaseToken,
      source: `google:${ctx.notification.notificationType}`,
    });
  }

  // When the status write was withheld (illegal transition from a
  // terminal state), don't grant access either — the row keeps its
  // prior terminal status, so access must follow that, not the
  // rejected notification.
  if (guard.apply && isAccessGranting(status)) {
    await grantAccess({
      subscriberId: subscriber.id,
      purchaseId: persisted.id,
      accessIds: product.accessIds,
      expiresDate,
    });
  } else {
    await drizzle.accessRepo.revokeAccessByPurchaseId(drizzle.db, persisted.id);
  }

  await ensureAcknowledged(ctx, purchase);

  const revenueEventType = mapRevenueEventType(
    ctx.notification.notificationType,
  );
  // Only record revenue when the status write actually applied. A
  // guard-rejected (out-of-order / replayed-after-terminal) notification
  // must not emit phantom RENEWAL/REACTIVATION/REFUND revenue.
  if (guard.apply && revenueEventType) {
    if (!pricing) {
      // NEVER fall back to a 0-USD row — a zero-amount event silently
      // corrupts MRR/LTV rollups. Skip the emission and surface the miss;
      // the durable BullMQ job already succeeded on the entitlement side.
      log.error("pricing unresolvable; skipping revenue event", {
        projectId: ctx.projectId,
        tokenPrefix: ctx.notification.purchaseToken.slice(0, 12),
        productId,
        basePlanId: lineItem?.offerDetails?.basePlanId,
        notificationType: ctx.notification.notificationType,
        revenueEventType,
      });
    } else {
      const { amount, currency } = pricing;
      const amountUsd = await convertToUsd(amount, currency);
      // eventDate uses processing time (partition-safe). Replay dedup no longer
      // depends on it — it is enforced by the revenue_event_dedupe table.
      const eventDate = new Date();
      // The order id is period-specific (it gains a `..N` suffix per renewal),
      // unlike purchaseToken which is stable across renewals. Keying on it
      // makes each renewal a distinct economic event while a replay of the
      // same notification dedups, and the coarse kind lets the receipt-verify
      // path converge on the same key for the same order.
      const orderId = effectiveGoogleOrderId(purchase, lineItem);
      await drizzle.revenueEventRepo.createRevenueEvent(drizzle.db, {
        projectId: ctx.projectId,
        subscriberId: subscriber.id,
        purchaseId: persisted.id,
        productId: product.id,
        type: revenueEventType,
        amount: amount.toString(),
        currency,
        amountUsd: amountUsd.toString(),
        store: Store.PLAY_STORE,
        eventDate,
        dedupeKey: `google:${orderId ?? ctx.notification.purchaseToken}:${revenueDedupeKind(revenueEventType)}`,
        // The store's own per-transaction billing country from the LIVE
        // subscriptionsv2.get response — Google's alpha-2 analog of
        // Apple's storefront. Already house-format; normalizeAlpha2Country
        // only validates + fails closed (see ../country.ts).
        country: normalizeAlpha2Country(purchase.regionCode),
      });

      if (revenueEventType === RevenueEventType.REFUND) {
        await maybeEmitRefundDetected(drizzle.db, {
          projectId: ctx.projectId,
          purchaseId: persisted.id,
          productId: product.id,
          amountUsdCents: Math.round(Math.abs(amountUsd) * 100),
          currency,
        });
      }
    }
  }

  return { subscriberId: subscriber.id, purchaseId: persisted.id };
}

async function ensureAcknowledged(
  ctx: SubscriptionCtx,
  purchase: GoogleSubscriptionPurchaseV2,
): Promise<void> {
  if (purchase.acknowledgementState !== GOOGLE_ACKNOWLEDGEMENT_STATE.PENDING) {
    return;
  }

  try {
    await acknowledgeGoogleSubscription(
      ctx.verifyConfig,
      ctx.notification.subscriptionId,
      ctx.notification.purchaseToken,
    );
  } catch (err) {
    // Don't fail the whole notification over an ack hiccup — Google retries
    // the RTDN, and a subsequent event will trigger another ack attempt.
    log.warn("acknowledge failed", {
      subscriptionId: ctx.notification.subscriptionId,
      tokenPrefix: ctx.notification.purchaseToken.slice(0, 12),
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

async function resolveSubscriber(ctx: SubscriptionCtx) {
  // Resolution mirrors the receipt path so both converge on ONE subscriber
  // (RevenueCat/Adapty model). Google Play's purchaseToken is the
  // store-authoritative anchor carried by every RTDN; the client's
  // externalAccountId is NOT used as the subscriber identity — that would
  // fabricate a parallel row keyed by the token, divorced from the
  // receipt-created subscriber, splitting purchase/access from
  // renewal/refund state. The receipt path (reconcileGoogleReceiptSubscriber)
  // converges any synthetic created here once it arrives.
  const existingPurchase =
    await drizzle.purchaseExtRepo.findPurchaseByStoreTransaction(
      drizzle.db,
      ctx.projectId,
      Store.PLAY_STORE,
      ctx.notification.purchaseToken,
    );
  if (existingPurchase) {
    const existingSubscriber = await drizzle.subscriberRepo.findSubscriberById(
      drizzle.db,
      existingPurchase.subscriberId,
    );
    if (existingSubscriber) return existingSubscriber;
  }

  // First sighting (RTDN before any receipt). Key by the stable purchaseToken
  // anchor so a later receipt converges onto this exact row. Upsert (not
  // create) keeps duplicate notifications for the same token idempotent.
  const syntheticId = `google:${ctx.notification.purchaseToken.slice(0, 24)}`;
  return drizzle.subscriberRepo.upsertSubscriber(drizzle.db, {
    projectId: ctx.projectId,
    rovenueId: syntheticId,
    appUserId: syntheticId,
  });
}

interface GrantAccessArgs {
  subscriberId: string;
  purchaseId: string;
  accessIds: string[];
  expiresDate: Date | null;
}

async function grantAccess(args: GrantAccessArgs): Promise<void> {
  for (const accessId of args.accessIds) {
    const existing = await drizzle.accessRepo.findAccessByPurchaseAndAccessId(
      drizzle.db,
      args.subscriberId,
      args.purchaseId,
      accessId,
    );
    if (existing) {
      await drizzle.accessRepo.setAccessActiveAndExpiry(
        drizzle.db,
        existing.id,
        true,
        args.expiresDate,
      );
    } else {
      await drizzle.accessRepo.createAccess(drizzle.db, {
        subscriberId: args.subscriberId,
        purchaseId: args.purchaseId,
        accessId,
        isActive: true,
        expiresDate: args.expiresDate,
        store: Store.PLAY_STORE,
      });
    }
  }
}

// =============================================================
// Voided purchase handling
// =============================================================

interface VoidedPurchaseArgs {
  projectId: string;
  purchaseToken: string;
}

async function processVoidedPurchase(
  args: VoidedPurchaseArgs,
): Promise<GoogleDispatchOutcome> {
  const purchase = await drizzle.purchaseExtRepo.findPurchaseByStoreTransaction(
    drizzle.db,
    args.projectId,
    Store.PLAY_STORE,
    args.purchaseToken,
  );

  if (purchase) {
    // FINDING 1: guarded read + status write in one tx (a); the
    // updatePurchase also CASE-guards the terminal status (b).
    const voidEventTime = new Date();
    const guard = await drizzle.db.transaction(async (dbTx) => {
      const decided = await guardStatusWrite({
        db: dbTx,
        projectId: args.projectId,
        store: Store.PLAY_STORE,
        storeTransactionId: args.purchaseToken,
        to: PurchaseStatus.REFUNDED,
        source: "google:VOIDED_PURCHASE",
        eventTime: voidEventTime,
      });
      await drizzle.purchaseRepo.updatePurchase(dbTx, purchase.id, {
        // Only stamp the refund when the transition actually applies. A
        // guard-rejected void (purchase already terminal — e.g. a prior
        // SUBSCRIPTION_REVOKED) must not overwrite refundDate or re-record
        // the refund, which previously double-counted REVOKE+VOID pairs.
        ...(decided.apply
          ? {
              status: PurchaseStatus.REFUNDED,
              refundDate: voidEventTime,
              lastStoreEventAt: voidEventTime,
            }
          : {}),
      });
      return decided;
    });
    await drizzle.accessRepo.revokeAccessByPurchaseId(drizzle.db, purchase.id);

    // Record the refund financially and fire the refund-detected signal,
    // mirroring the Stripe/Apple inbound-refund handlers — but only when the
    // status transition applied, so a REVOKE-then-VOID (or replay) records a
    // single refund. The VOIDED_PURCHASE RTDN carries no amount, so derive it
    // from the stored purchase price. Positive magnitude per platform
    // convention (analytics net via `gross - refunds`).
    if (guard.apply) {
      if (purchase.priceAmount == null || purchase.priceCurrency == null) {
        // No stored price to derive the refund magnitude from — NEVER write
        // a 0-USD REFUND row (it would silently under-count refunds while
        // pretending one was recorded). The status transition above stands.
        log.error(
          "voided purchase has no stored price; skipping refund revenue event",
          {
            projectId: args.projectId,
            tokenPrefix: args.purchaseToken.slice(0, 12),
            purchaseId: purchase.id,
            productId: purchase.productId,
          },
        );
      } else {
        const amount = Number(purchase.priceAmount);
        const currency = purchase.priceCurrency;
        const amountUsd = await convertToUsd(amount, currency);
        const eventDate = new Date();
        await drizzle.revenueEventRepo.createRevenueEvent(drizzle.db, {
          projectId: args.projectId,
          subscriberId: purchase.subscriberId,
          purchaseId: purchase.id,
          productId: purchase.productId,
          type: RevenueEventType.REFUND,
          amount: amount.toString(),
          currency,
          amountUsd: amountUsd.toString(),
          store: Store.PLAY_STORE,
          eventDate,
          // A void is terminal/once-per-purchase; key on the token. A
          // REVOKE+VOID race is additionally prevented by the guard.apply gate.
          dedupeKey: `google:${args.purchaseToken}:refund`,
          // VERIFIED GAP, not an oversight: `voidedPurchaseNotification`
          // carries no regionCode, and unlike processSubscriptionNotification
          // this path never re-fetches the live subscriptionsv2.get resource
          // (it only ever reads the persisted `purchase` row, which has no
          // country column). No fallback to a stale/borrowed value — a
          // Google refund recorded via VOIDED_PURCHASE has no store-supplied
          // country. `country` intentionally omitted here.
        });
        await maybeEmitRefundDetected(drizzle.db, {
          projectId: args.projectId,
          purchaseId: purchase.id,
          productId: purchase.productId,
          amountUsdCents: Math.round(Math.abs(amountUsd) * 100),
          currency,
        });
      }
    }
  }

  return purchase
    ? { subscriberId: purchase.subscriberId, purchaseId: purchase.id }
    : {};
}
