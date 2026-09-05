import { Queue, Worker, type Job } from "bullmq";
import { createBullConnection } from "../lib/redis";
import type Stripe from "stripe";
import { drizzle } from "@rovenue/db";
import {
  isRovenueEventKey,
  resolveStorePublicKey,
  toWebhookEventCategory,
  type StoreEventContext,
} from "@rovenue/shared";
import { logger } from "../lib/logger";
import { loadGoogleCredentials } from "../lib/project-credentials";
import { requireConnectedStripe } from "../lib/stripe-platform";
import { syncAccess } from "./access-engine";
import { grantProductCurrencies } from "./purchase-credits";
import {
  handleAppleNotification,
  type HandleAppleNotificationResult,
} from "./apple/apple-webhook";
import {
  handleGoogleNotification,
  type GooglePubSubPushBody,
  type GoogleServiceAccountCredentials,
  type GoogleVerifyConfig,
  type HandleGoogleNotificationResult,
} from "./google";
import {
  processStripeEvent,
  type HandleStripeNotificationResult,
} from "./stripe/stripe-webhook";

const log = logger.child("webhook-processor");

export const WEBHOOK_QUEUE_NAME = "rovenue-webhooks";

// =============================================================
// Job shapes
// =============================================================

export type WebhookJobData =
  | {
      source: "APPLE";
      projectId: string;
      signedPayload: string;
    }
  | {
      source: "GOOGLE";
      projectId: string;
      pushBody: GooglePubSubPushBody;
    }
  | {
      // NOTE: Stripe events are verified synchronously at the route edge
      // so the raw body and webhook secret never land in Redis. The worker
      // only re-processes the parsed event.
      source: "STRIPE";
      projectId: string;
      event: Stripe.Event;
    };

export type WebhookJobResult =
  | HandleAppleNotificationResult
  | HandleGoogleNotificationResult
  | HandleStripeNotificationResult;

/**
 * Side-effect hook the processor injects into every handler. Handlers
 * call it AFTER their domain writes but BEFORE marking the
 * webhook_events row PROCESSED: if a side effect fails, the handler's
 * catch marks the row FAILED (re-claimable) and rethrows so BullMQ
 * retries — marking PROCESSED first would make the retry dedupe to
 * `duplicate` and lose the side effect permanently (e.g. a
 * webhook-only consumable credit grant). All side effects are
 * idempotent on re-run (`guardStatusWrite`, addCredits' purchase
 * dedupe, the outgoing enqueue's webhookEventId dedupe).
 */
export type WebhookPostProcess = (ctx: {
  webhookEventId: string;
  eventType: string;
  subscriberId?: string;
  purchaseId?: string;
  /**
   * Disambiguating fact a handler can thread alongside `eventType` for
   * the store-native types `resolveStorePublicKey` (packages/shared)
   * can't resolve on the bare type alone (currently: Apple
   * `DID_CHANGE_RENEWAL_STATUS`'s auto-renew direction). Optional —
   * every other caller keeps passing a bare `eventType` and behaves
   * identically to before this field existed.
   */
  eventContext?: StoreEventContext;
  /**
   * Set only by Apple's `applyRenewal` (DID_RENEW) — see
   * `DispatchOutcome.isRenewalCharge` in apple-webhook.ts. Tells
   * `runPostProcessing` to withhold the PURCHASE-trigger product-currency
   * grant: a renewal is granted exclusively through the RENEWAL trigger
   * (services/renewal-grants), never through the purchase path. Every
   * other caller leaves this undefined and behaves identically to
   * before this field existed.
   */
  isRenewalCharge?: boolean;
}) => Promise<void>;

// =============================================================
// BullMQ connection + queue
// =============================================================

// -------------------------------------------------------------
// Retry/lease invariant: total retry span > claim lease.
//
// A worker that dies mid-claim leaves the webhook_events row
// PROCESSING with a live lease (WEBHOOK_CLAIM_LEASE_MS = 5 min,
// packages/db webhook-events repo); every BullMQ retry inside that
// lease sees claimWebhookEvent → "in_progress" and throws, so at
// least one retry MUST land after the lease expires or all attempts
// burn on the stale claim and the event strands until the reaper.
// Exponential backoff from 5s over 8 attempts spans
// 5+10+20+40+80+160+320 = 635s > 300s. The invariant is asserted by
// webhook-processor.test.ts against the exported lease constant.
// -------------------------------------------------------------
export const WEBHOOK_JOB_ATTEMPTS = 8;
export const WEBHOOK_JOB_BACKOFF_INITIAL_MS = 5_000;

/** Sum of BullMQ exponential-backoff delays across all retries. */
export function webhookRetrySpanMs(
  attempts: number,
  initialDelayMs: number,
): number {
  let span = 0;
  for (let retry = 0; retry < attempts - 1; retry++) {
    span += initialDelayMs * 2 ** retry;
  }
  return span;
}

let cachedQueue: Queue<WebhookJobData, WebhookJobResult> | undefined;

export function getWebhookQueue(): Queue<WebhookJobData, WebhookJobResult> {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue<WebhookJobData, WebhookJobResult>(
    WEBHOOK_QUEUE_NAME,
    {
      connection: createBullConnection("webhook-processor"),
      defaultJobOptions: {
        attempts: WEBHOOK_JOB_ATTEMPTS,
        backoff: { type: "exponential", delay: WEBHOOK_JOB_BACKOFF_INITIAL_MS },
        removeOnComplete: { count: 1000, age: 24 * 60 * 60 },
        removeOnFail: { count: 1000, age: 7 * 24 * 60 * 60 },
      },
    },
  );
  log.debug("webhook queue initialised");
  return cachedQueue;
}

export async function enqueueWebhookEvent(
  data: WebhookJobData,
): Promise<Job<WebhookJobData, WebhookJobResult>> {
  return getWebhookQueue().add(`${data.source}:${data.projectId}`, data);
}

// =============================================================
// processWebhookEvent — BullMQ job body
// =============================================================

export async function processWebhookEvent(
  data: WebhookJobData,
): Promise<WebhookJobResult> {
  log.info("processing webhook event", {
    source: data.source,
    projectId: data.projectId,
  });

  // Handlers invoke this between their domain writes and the PROCESSED
  // mark (see WebhookPostProcess). A throw here surfaces through the
  // handler's catch: row → FAILED, job → retry.
  const postProcess: WebhookPostProcess = async (ctx) => {
    if (!ctx.subscriberId) return;
    await runPostProcessing({
      projectId: data.projectId,
      subscriberId: ctx.subscriberId,
      purchaseId: ctx.purchaseId,
      eventType: ctx.eventType,
      webhookEventId: ctx.webhookEventId,
      eventContext: ctx.eventContext,
      isRenewalCharge: ctx.isRenewalCharge,
    });
  };

  return dispatchToHandler(data, postProcess);
}

async function dispatchToHandler(
  data: WebhookJobData,
  postProcess: WebhookPostProcess,
): Promise<WebhookJobResult> {
  switch (data.source) {
    case "APPLE":
      return handleAppleNotification({
        projectId: data.projectId,
        signedPayload: data.signedPayload,
        postProcess,
      });
    case "GOOGLE": {
      const verifyConfig = await resolveGoogleVerifyConfig(data.projectId);
      return handleGoogleNotification({
        projectId: data.projectId,
        pushBody: data.pushBody,
        verifyConfig,
        postProcess,
      });
    }
    case "STRIPE": {
      // Throws StripeNotConnectedError when the project has no active
      // connection, which BullMQ treats as a retry signal (same as the
      // old "credentials not configured" throw did).
      const connected = await requireConnectedStripe(data.projectId);
      return processStripeEvent({
        projectId: data.projectId,
        event: data.event,
        // Already bound to the customer's connected account, so nothing
        // dispatch does can reach Rovenue's own Stripe account.
        account: connected.account,
        postProcess,
      });
    }
  }
}

async function resolveGoogleVerifyConfig(
  projectId: string,
): Promise<GoogleVerifyConfig | undefined> {
  const creds = await loadGoogleCredentials(projectId);
  if (!creds) return undefined;
  return {
    packageName: creds.packageName,
    credentials: creds.serviceAccount as GoogleServiceAccountCredentials,
  };
}

// =============================================================
// Post-processing: access sync + credit add + outgoing webhook
// =============================================================

interface PostProcessingArgs {
  projectId: string;
  subscriberId: string;
  purchaseId?: string;
  eventType: string;
  webhookEventId: string;
  eventContext?: StoreEventContext;
  /** See `WebhookPostProcess`'s field of the same name. */
  isRenewalCharge?: boolean;
}

/**
 * Runs the three side effects, in order, and PROPAGATES the first
 * failure. The handler then marks the webhook_events row FAILED and
 * rethrows so BullMQ retries the whole job — every step here is
 * idempotent on re-run, so a partial success simply replays. Never
 * swallow these: with the row already PROCESSED a swallowed failure
 * was permanently lost (redeliveries dedupe to `duplicate`).
 */
async function runPostProcessing(args: PostProcessingArgs): Promise<void> {
  try {
    await syncAccess(args.subscriberId);
  } catch (err) {
    log.error("access sync failed; failing job for retry", {
      subscriberId: args.subscriberId,
      err: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  // The PURCHASE-trigger grant fires for a charge that is NOT a renewal:
  // a consumable/non-consumable purchase, or a subscription's first
  // charge. `isRenewalCharge` is set only by Apple's `applyRenewal`
  // (DID_RENEW) — every other caller leaves it undefined, so this gate
  // is a no-op for them. Skipping it here, rather than inside
  // `maybeCreditConsumablePurchase`, keeps that function's job the same
  // ("credit this purchase") and keeps the renewal exclusion visible
  // alongside the other post-processing steps.
  if (args.purchaseId && !args.isRenewalCharge) {
    try {
      await maybeCreditConsumablePurchase(args.subscriberId, args.purchaseId);
    } catch (err) {
      log.error("consumable credit add failed; failing job for retry", {
        subscriberId: args.subscriberId,
        purchaseId: args.purchaseId,
        err: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  }

  try {
    await enqueueOutgoingWebhook({
      projectId: args.projectId,
      subscriberId: args.subscriberId,
      purchaseId: args.purchaseId,
      eventType: args.eventType,
      webhookEventId: args.webhookEventId,
      eventContext: args.eventContext,
    });
  } catch (err) {
    log.error("outgoing webhook enqueue failed; failing job for retry", {
      projectId: args.projectId,
      eventType: args.eventType,
      err: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

async function maybeCreditConsumablePurchase(
  subscriberId: string,
  purchaseId: string,
): Promise<void> {
  const purchase = await drizzle.purchaseExtRepo.findPurchaseWithCreditInfo(
    drizzle.db,
    purchaseId,
  );
  if (!purchase) return;

  // No product-type gate: whether a grant fires is decided by the
  // product's grant rows and their trigger, not by the product's type.
  // Callers are responsible for not reaching this function at all for a
  // renewal charge — see `runPostProcessing`'s `isRenewalCharge` gate —
  // so this always fires the PURCHASE trigger, never RENEWAL.
  await grantProductCurrencies({
    subscriberId,
    productId: purchase.product.id,
    referenceId: purchaseId,
    productIdentifier: purchase.product.identifier,
    trigger: "PURCHASE",
  });

  log.debug("credited consumable purchase", { subscriberId, purchaseId });
}

interface EnqueueOutgoingWebhookArgs {
  projectId: string;
  subscriberId: string;
  purchaseId?: string;
  eventType: string;
  /** Inbound webhook_events row id — the retry-safe dedup key. */
  webhookEventId: string;
  eventContext?: StoreEventContext;
}

async function enqueueOutgoingWebhook(
  args: EnqueueOutgoingWebhookArgs,
): Promise<void> {
  const config = await drizzle.projectRepo.findProjectWebhookConfig(
    drizzle.db,
    args.projectId,
  );

  // No existing tx at this call site — wrap the outbox bridge and the
  // v1 outgoing-webhook write (category filter + dedupe + insert) in a
  // minimal transaction so they commit atomically. The outbox insert is
  // independent of webhookUrl/category — v2 subscribers must get the
  // event even when no v1 webhookUrl is configured, or when the
  // project's category filter would have dropped it for v1 delivery
  // (it is gated only on the event type being deliverable, see below) —
  // and it IS deduped (dedupe and v1-config gating are orthogonal):
  // runPostProcessing re-runs whole on a BullMQ retry, and without a
  // dedupe check here a retry would insert a fresh outbox_events row
  // (fresh id) every attempt. The dedupe key is the INBOUND
  // webhookEventId whenever there is one — see the key-selection comment
  // at the lookup below for why the purchase-keyed variant is only a
  // fallback here (it differs from the v1 dedupe further down).
  await drizzle.db.transaction(async (tx) => {
    // Only bridge event types the integrations fan-out can actually
    // deliver. This call site passes the STORE-NATIVE type (DID_RENEW,
    // SUBSCRIPTION_ON_HOLD, DID_FAIL_TO_RENEW, …); toFanoutEnvelope maps
    // only normalized Rovenue keys, so bridging a raw type wrote an
    // outbox row that every consumer drops — a permanent dead write on
    // the store-webhook hot path. Gated before the dedupe query so that
    // path skips the SELECT as well as the INSERT.
    //
    // Two-step resolution (Wave-1 narrow store-lifecycle normalization):
    // args.eventType is already a public key for the scheduled-actions /
    // expiry-checker producers (subscription.cancel_requested /
    // subscription.expired) — pass it through unchanged. Otherwise it's
    // a store-native type; resolveStorePublicKey narrowly maps the
    // handful of store signals that unambiguously mean a NEW public key
    // (billing_issue / grace_period / uncancelled / product_changed —
    // see store-event-normalization.ts for the exact table, the rows
    // deliberately excluded from it, and the optional `eventContext` a
    // handler can pass to resolve the ones that need more than the bare
    // type). Everything else stays unmapped and is dropped here exactly
    // as before this change.
    const publicKey = isRovenueEventKey(args.eventType)
      ? args.eventType
      : resolveStorePublicKey(args.eventType, args.eventContext);
    if (publicKey) {
      // DEDUPE KEY SELECTION — the inbound webhookEventId wins.
      //
      // The unit of replay this dedupe exists to absorb is one BullMQ retry
      // of runPostProcessing, i.e. one inbound webhook_events row, so that
      // row's id is exactly the right key. Keying on the PURCHASE instead
      // (the previous behavior, mirroring the v1 dedupe below) is wrong
      // here because normalization deliberately collapses several DISTINCT
      // store events onto ONE public key: Apple DID_FAIL_TO_RENEW and a
      // later GRACE_PERIOD_EXPIRED both bridge to
      // `subscription.billing_issue` for the same purchase, Google
      // PRICE_CHANGE_CONFIRMED and DEFERRED both to
      // `subscription.product_changed`, and a billing issue recurs every
      // renewal cycle. Purchase-keyed and time-unbounded, the second and
      // every later one of those was silently dropped forever — while v1,
      // which dedupes per inbound event id, still delivered them. Purchase
      // keying stays only as the fallback for a producer that carries no
      // inbound webhook event — no live caller reaches the purchase-keyed
      // branch today, webhookEventId is required on the only production path.
      const alreadyBridged = args.webhookEventId
        ? await drizzle.outboxRepo.findByWebhookEventAndType(
            tx,
            "SUBSCRIPTION",
            args.subscriberId,
            publicKey,
            args.webhookEventId,
          )
        : args.purchaseId
          ? await drizzle.outboxRepo.findByPurchaseAndType(
              tx,
              "SUBSCRIPTION",
              args.subscriberId,
              publicKey,
              args.purchaseId,
            )
          : null;
      if (!alreadyBridged) {
        await drizzle.outboxRepo.insert(tx, {
          aggregateType: "SUBSCRIPTION",
          aggregateId: args.subscriberId,
          eventType: publicKey,
          payload: {
            projectId: args.projectId,
            subscriberId: args.subscriberId,
            purchaseId: args.purchaseId ?? null,
            webhookEventId: args.webhookEventId,
            // The store's own event type that produced this key. Several
            // store events legitimately share one public key — Stripe's
            // `invoice.payment_failed` and `invoice.payment_action_required`
            // both mean `subscription.billing_issue`, because the subscriber
            // must act either way. But "your card was declined" and "tap to
            // approve in your banking app" are different emails, and without
            // this field a consumer receiving the key cannot write either
            // one. Additive and always present; consumers that ignore it are
            // unaffected.
            storeEventType: args.eventType,
            timestamp: new Date().toISOString(),
          },
        });
      }
    }

    if (!config?.url) return;

    // Category filter — empty list means "all events". For a non-empty
    // list, drop events whose category isn't subscribed. Unmapped events
    // (category === null) fail open so unknown/new types aren't lost.
    if (config.eventCategories.length > 0) {
      const category = toWebhookEventCategory(args.eventType);
      if (category !== null && !config.eventCategories.includes(category)) {
        return;
      }
    }

    // Idempotency across BullMQ retries (post-processing re-runs whole):
    // purchase events dedupe on (project, subscriber, type, purchase);
    // purchase-less events dedupe on the inbound webhookEventId stamped
    // into the outgoing payload below.
    if (args.purchaseId) {
      const existing =
        await drizzle.outgoingWebhookRepo.findRecentOutgoingByPurchaseAndType(
          tx,
          args.projectId,
          args.subscriberId,
          args.eventType,
          args.purchaseId,
        );
      if (existing) return;
    } else {
      const existing =
        await drizzle.outgoingWebhookRepo.findOutgoingByWebhookEvent(
          tx,
          args.projectId,
          args.subscriberId,
          args.eventType,
          args.webhookEventId,
        );
      if (existing) return;
    }

    const payload = {
      eventType: args.eventType,
      subscriberId: args.subscriberId,
      purchaseId: args.purchaseId ?? null,
      webhookEventId: args.webhookEventId,
      timestamp: new Date().toISOString(),
    };

    await drizzle.outgoingWebhookRepo.enqueueOutgoingWebhook(tx, {
      projectId: args.projectId,
      eventType: args.eventType,
      subscriberId: args.subscriberId,
      purchaseId: args.purchaseId ?? null,
      payload,
      url: config.url,
    });
  });
}

// =============================================================
// Worker
// =============================================================

let cachedWorker: Worker<WebhookJobData, WebhookJobResult> | undefined;

export function createWebhookWorker(): Worker<
  WebhookJobData,
  WebhookJobResult
> {
  if (cachedWorker) return cachedWorker;

  cachedWorker = new Worker<WebhookJobData, WebhookJobResult>(
    WEBHOOK_QUEUE_NAME,
    async (job) => processWebhookEvent(job.data),
    {
      connection: createBullConnection("webhook-processor"),
      concurrency: 8,
    },
  );

  cachedWorker.on("failed", (job, err) => {
    log.error("webhook job failed", {
      jobId: job?.id,
      attemptsMade: job?.attemptsMade,
      err: err.message,
    });
  });

  cachedWorker.on("completed", (job) => {
    log.debug("webhook job completed", { jobId: job.id });
  });

  log.info("webhook worker started", { queue: WEBHOOK_QUEUE_NAME });
  return cachedWorker;
}

export {
  enqueueOutgoingWebhook as __test_enqueueOutgoingWebhook,
  maybeCreditConsumablePurchase as __test_maybeCreditConsumablePurchase,
  runPostProcessing as __test_runPostProcessing,
};
