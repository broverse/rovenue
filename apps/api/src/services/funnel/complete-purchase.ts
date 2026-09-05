import {
  type Db,
  Environment,
  ProductType,
  PurchaseStatus,
  RevenueEventType,
  Store,
  drizzle,
  revenueDedupeKind,
} from "@rovenue/db";
import { logger } from "../../lib/logger";
import { isUniqueViolationOf } from "../../lib/pg-errors";
import { convertToUsd } from "../fx";
import { grantPurchaseCurrencies } from "../purchase-credits";
import { oneTimeRevenueTypeFor } from "../revenue/one-time-type";
import { emitFunnelEvent } from "./outbox";
import { generateClaimToken, hashToken } from "./token";

/**
 * What `grantOneTimePurchase` hands back to `completeFunnelPurchase` so it
 * can grant virtual currencies for a CONSUMABLE product AFTER the paid
 * transition commits — never inside it. See the comment at the call site.
 */
interface ConsumableGrantInfo {
  subscriberId: string;
  productId: string;
  purchaseId: string;
  productIdentifier: string;
}

// =============================================================
// Completing a paid funnel session
// =============================================================
//
// Two callers race here on purpose: the browser's /confirm and the
// Connect webhook (for the buyer who closed the tab). Either may win, so
// this must be idempotent — and because only the token's HASH is stored,
// the plaintext exists exactly once, in the winner's return value. The
// loser gets `alreadyIssued: true` and no token rather than a fake one.

const log = logger.child("funnel-complete-purchase");

const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The unique constraint on `funnel_claim_tokens.session_id`, created by
 * migration 0050_funnel_core.sql and left in place by 0051 (which drops
 * only the FK into the now-partitioned funnel_sessions).
 *
 * The INSERT below can violate three different unique constraints —
 * this one, `funnel_claim_tokens_token_hash_unique`, and the primary
 * key. Only this one means "another caller already issued the token for
 * this session"; the other two mean the token generator or the id
 * generator collided, which is not a race we may swallow. Reporting
 * those as `alreadyIssued` would roll back the paid transition and
 * leave a buyer who really paid sitting at `pending` with no token, so
 * they must surface as errors.
 */
const SESSION_ID_UNIQUE = "funnel_claim_tokens_session_id_unique";

/**
 * Drizzle does not rethrow the driver's error — it wraps it and hangs
 * the `pg` error off `.cause`, so the code and the constraint live one
 * level down. `isUniqueViolationOf` walks that chain; see lib/pg-errors.
 */
function isSessionTokenRace(err: unknown): boolean {
  return isUniqueViolationOf(err, SESSION_ID_UNIQUE);
}

export type CompleteResult =
  | { alreadyIssued: false; token: string }
  | { alreadyIssued: true };

/**
 * Write the `purchases` row and the entitlement for a ONE-TIME funnel
 * purchase, in the caller's transaction.
 *
 * Why this exists here and only for the one-time case. A recurring
 * package is bought through a Stripe Subscription, and the Connect
 * webhook's `customer.subscription.*` handler is what creates the
 * purchase row and grants access for it. A non-recurring package is
 * charged through a bare `paymentIntents.create` — there is no
 * subscription, `payment_intent.succeeded` is deliberately absent from
 * the webhook's DOMAIN_SYNC map, and nothing else in the codebase builds
 * a purchase from a PaymentIntent. So before this, the one-time buyer
 * paid, `/confirm` returned 200, a claim token was minted, and the claim
 * merged a synthetic subscriber that owned nothing: `entitlements: []`,
 * with no error anywhere.
 *
 * Guarded on `stripeSubscriptionId == null` at the call site so the
 * recurring path keeps using the webhook's machinery untouched and
 * nothing is ever written twice.
 *
 * The shape follows `upsertPurchaseFromSubscription` and `grantAccess`
 * in services/stripe/stripe-webhook.ts rather than inventing its own:
 * same store, same `upsertPurchase` (idempotent on
 * store+storeTransactionId, so a redelivered webhook and a retried
 * `/confirm` converge), same read-then-insert on `subscriber_access`.
 * The differences are all one-time facts: no `expiresDate` (a one-time
 * purchase does not lapse), `autoRenewStatus: false`, `isTrial: false`.
 *
 * NOTHING HERE THROWS on missing data. A funnel purchase row with no
 * `productId`, no PaymentIntent id, or a product that has since been
 * deleted cannot be granted whatever we do — and throwing would abort
 * the transaction, roll back the paid transition, and leave a buyer who
 * really paid with no claim token and a `/confirm` that 500s on every
 * retry. Loud logs and a minted token beat a silent 500 loop; the buyer
 * keeps a path to their purchase and an operator has the ids to fix it.
 *
 * Returns a `ConsumableGrantInfo` when (and only when) the product just
 * purchased is a CONSUMABLE — the caller grants virtual currencies for it
 * AFTER this transaction commits. That has to happen outside: `addCredits`
 * (services/credit-engine.ts) always opens its OWN
 * `drizzle.db.transaction`, never accepts a `tx` to join, so it cannot be
 * folded into this one atomically — nesting it here would either graft an
 * independent, separately-committing transaction onto this one (credits
 * could survive a later rollback of the paid transition, or vice versa) or,
 * if it throws, violate the very "nothing here throws" contract this
 * function documents. Returning `null` for every early-exit branch below is
 * what tells the caller no purchase was actually created, so it must not
 * grant anything.
 */
async function grantOneTimePurchase(
  tx: Db,
  args: {
    projectId: string;
    sessionId: string;
    funnelPurchaseId: string;
    productId: string | null;
    amountCents: number | null;
    currency: string | null;
    subscriberId: string;
    stripePaymentIntentId: string | null;
    // Precomputed by the caller BEFORE the transaction opened — see the
    // FX comment on completeFunnelPurchase. `null` means either the
    // funnel row had no price to convert, or conversion itself is moot
    // (recurring callers never reach this function).
    amountUsd: string | null;
  },
): Promise<ConsumableGrantInfo | null> {
  if (!args.stripePaymentIntentId) {
    // No subscription AND no PaymentIntent: the row records nothing that
    // could have been charged, so there is no natural key to anchor a
    // purchase on. Only the dev-mode stub in routes/public/funnels.ts
    // writes such a row, and it mints its own token.
    log.error("one-time funnel purchase has no payment intent to record", {
      sessionId: args.sessionId,
      funnelPurchaseId: args.funnelPurchaseId,
    });
    return null;
  }
  if (!args.productId) {
    log.error("one-time funnel purchase has no product to grant", {
      sessionId: args.sessionId,
      funnelPurchaseId: args.funnelPurchaseId,
      paymentIntentId: args.stripePaymentIntentId,
    });
    return null;
  }

  const [product] = await drizzle.offeringRepo.findProductsByIds(
    tx,
    args.projectId,
    [args.productId],
  );
  if (!product) {
    log.error("one-time funnel purchase names a product that no longer exists", {
      sessionId: args.sessionId,
      projectId: args.projectId,
      productId: args.productId,
    });
    return null;
  }

  const purchasedAt = new Date();
  // Drizzle decimal columns round-trip as strings, and the funnel row
  // stores minor units — same conversion the webhook does.
  const priceAmount =
    args.amountCents != null ? (args.amountCents / 100).toString() : null;
  const priceCurrency = args.currency ? args.currency.toUpperCase() : null;

  const purchase = await drizzle.purchaseRepo.upsertPurchase(tx, {
    store: Store.STRIPE,
    storeTransactionId: args.stripePaymentIntentId,
    create: {
      projectId: args.projectId,
      subscriberId: args.subscriberId,
      productId: args.productId,
      store: Store.STRIPE,
      storeTransactionId: args.stripePaymentIntentId,
      originalTransactionId: args.stripePaymentIntentId,
      status: PurchaseStatus.ACTIVE,
      isTrial: false,
      purchaseDate: purchasedAt,
      originalPurchaseDate: purchasedAt,
      // A one-time purchase never expires. `grantAccess` below passes the
      // same null through to the access row.
      expiresDate: null,
      environment: Environment.PRODUCTION,
      priceAmount,
      priceCurrency,
      autoRenewStatus: false,
      verifiedAt: purchasedAt,
    },
    update: {
      status: PurchaseStatus.ACTIVE,
      verifiedAt: purchasedAt,
    },
  });

  for (const accessId of product.accessIds) {
    const existing = await drizzle.accessRepo.findAccessByPurchaseAndAccessId(
      tx,
      args.subscriberId,
      purchase.id,
      accessId,
    );
    if (existing) {
      await drizzle.accessRepo.setAccessActiveAndExpiry(tx, existing.id, true, null);
    } else {
      await drizzle.accessRepo.createAccess(tx, {
        subscriberId: args.subscriberId,
        purchaseId: purchase.id,
        accessId,
        isActive: true,
        expiresDate: null,
        store: Store.STRIPE,
      });
    }
  }

  // The money finally counts. Before this, a one-time funnel purchase
  // wrote a purchases row and an entitlement and nothing else: no
  // revenue_events row means no REVENUE_EVENT outbox row, which means no
  // rovenue.revenue topic, which means no ClickHouse and no integration
  // provider. The sale was invisible everywhere but the funnel tables.
  //
  // INSIDE the transaction, not after it: both /confirm and the webhook
  // backstop short-circuit on `status === "paid"`, so a post-commit emit
  // that failed would never be retried by anything.
  //
  // Skips rather than throws on missing data, matching this function's
  // documented contract — a throw would roll back the paid transition and
  // leave a buyer who really paid with no claim token.
  //
  // grantOneTimePurchase is only reached when stripeSubscriptionId == null
  // — a bare PaymentIntent, which by definition does not renew. So a
  // SUBSCRIPTION-typed product here (the dashboard defaults new products to
  // that type) is a misconfiguration, not a reason to drop the money: fall
  // back to NON_RENEWING_PURCHASE rather than skip the revenue row.
  const declaredRevenueType = oneTimeRevenueTypeFor(product.type);
  const revenueType = declaredRevenueType ?? RevenueEventType.NON_RENEWING_PURCHASE;
  if (declaredRevenueType == null) {
    log.warn("one-time funnel purchase names a SUBSCRIPTION-typed product; recording as NON_RENEWING_PURCHASE", {
      sessionId: args.sessionId,
      productId: args.productId,
    });
  }
  if (priceAmount == null || priceCurrency == null || args.amountUsd == null) {
    log.error("one-time funnel purchase has no price to record as revenue", {
      sessionId: args.sessionId,
      purchaseId: purchase.id,
    });
  } else {
    // createRevenueEvent can throw (e.g. a dedupe-key conflict), and this
    // function's contract is that NOTHING here throws — a throw would roll
    // back the paid transition and strand a buyer who really paid. Every
    // other call site in this codebase shares this same unguarded gap; this
    // one gets the guard because it is the call this fix wave is about.
    try {
      await drizzle.revenueEventRepo.createRevenueEvent(tx, {
        projectId: args.projectId,
        subscriberId: args.subscriberId,
        purchaseId: purchase.id,
        productId: args.productId,
        type: revenueType,
        amount: priceAmount,
        currency: priceCurrency,
        amountUsd: args.amountUsd,
        store: Store.STRIPE,
        eventDate: purchasedAt,
        // Both racers converge on one key; the loser's transaction rolls
        // back anyway, and a redelivered webhook is a no-op.
        dedupeKey: `stripe:${args.stripePaymentIntentId}:${revenueDedupeKind(revenueType)}`,
        // No country: a PaymentIntent carries no per-transaction country, and
        // reading the Charge would put a Stripe call inside an open
        // transaction. Same documented gap, same reason, as applyInvoicePaid.
      });
    } catch (err) {
      log.error("createRevenueEvent threw while granting a one-time funnel purchase", {
        sessionId: args.sessionId,
        purchaseId: purchase.id,
        err: err instanceof Error ? err.message : String(err),
      });
    }
  }

  log.info("granted a one-time funnel purchase", {
    sessionId: args.sessionId,
    projectId: args.projectId,
    purchaseId: purchase.id,
    subscriberId: args.subscriberId,
    accessCount: product.accessIds.length,
  });

  // Gated on CONSUMABLE, mirroring routes/v1/receipts.ts's call site — a
  // NON_CONSUMABLE or SUBSCRIPTION product grants access rows above and
  // nothing further. The grant itself does not happen here; see the
  // ConsumableGrantInfo doc comment above for why.
  if (product.type !== ProductType.CONSUMABLE) return null;
  return {
    subscriberId: args.subscriberId,
    productId: args.productId,
    purchaseId: purchase.id,
    productIdentifier: product.identifier,
  };
}

export async function completeFunnelPurchase(input: {
  sessionId: string;
  stripeCustomerId: string;
  stripeSubscriptionId: string | null;
  stripePaymentIntentId: string | null;
}): Promise<CompleteResult> {
  const plaintext = generateClaimToken();

  // FX BEFORE the transaction, deliberately. convertToUsd's ladder is
  // Redis -> fx_rates -> a static table (services/fx.ts): no HTTP, but
  // two Redis round trips. This transaction sits on the paid-conversion
  // critical path and holds the funnel_claim_tokens.session_id unique-
  // index race; a cache round trip does not belong inside it.
  //
  // The row is read again inside the transaction below — that read is
  // what decides the paid/already-paid race — so this extra read changes
  // no semantics.
  //
  // Skipped entirely for the recurring path (stripeSubscriptionId set): a
  // Stripe Subscription's revenue is recorded by the Connect webhook's
  // invoice.paid handler, not here, and grantOneTimePurchase itself never
  // runs when a subscription id is present (see below) — converting an
  // amount nothing would use would just spend two Redis round trips on
  // every recurring confirm.
  const preRead = input.stripeSubscriptionId
    ? null
    : await drizzle.funnelPurchaseRepo.findBySession(
        drizzle.db,
        input.sessionId,
      );
  const amountUsd =
    preRead?.amountCents != null && preRead.currency
      ? (
          await convertToUsd(preRead.amountCents / 100, preRead.currency)
        ).toString()
      : null;

  // Set inside the transaction below, read after it commits — see the
  // ConsumableGrantInfo doc comment on grantOneTimePurchase for why the
  // credit grant itself cannot happen inside that transaction.
  let consumableGrant: ConsumableGrantInfo | null = null;

  const result = await drizzle.db.transaction(async (tx): Promise<CompleteResult> => {
    const session = await drizzle.funnelSessionRepo.findById(tx, input.sessionId);
    if (!session) throw new Error(`funnel session ${input.sessionId} not found`);

    const purchase = await drizzle.funnelPurchaseRepo.findBySession(
      tx,
      input.sessionId,
    );
    if (!purchase) {
      throw new Error(`no purchase for funnel session ${input.sessionId}`);
    }
    if (purchase.status === "paid") {
      log.info("funnel session already completed; not minting a second token", {
        sessionId: input.sessionId,
      });
      return { alreadyIssued: true };
    }

    // Anchor a synthetic subscriber on the Stripe customer. The Connect
    // webhook's resolveSubscriber falls back to the same `stripe:<id>`
    // shape, so both paths converge on one row instead of fabricating
    // two identities for the same buyer. The claim merges it into the
    // installed subscriber later.
    const subscriber = await drizzle.subscriberRepo.upsertSubscriber(tx, {
      projectId: session.projectId,
      rovenueId: `stripe:${input.stripeCustomerId}`,
      appUserId: `stripe:${input.stripeCustomerId}`,
      createAttributes: { stripe_customer_id: input.stripeCustomerId },
    });

    await drizzle.funnelPurchaseRepo.markPaid(tx, purchase.id, {
      stripeCustomerId: input.stripeCustomerId,
      stripeSubscriptionId: input.stripeSubscriptionId,
      stripePaymentIntentId: input.stripePaymentIntentId,
      subscriberId: subscriber.id,
    });
    await drizzle.funnelSessionRepo.setState(tx, input.sessionId, "paid");

    // The `status === "paid"` read above is a cheap short-circuit, not the
    // thing that makes this safe: at READ COMMITTED two racers can both
    // read `pending` and both arrive here. What actually decides the race
    // is the unique index on `funnel_claim_tokens.session_id` — exactly
    // one INSERT can win. The loser's 23505 aborts its transaction, so
    // everything it wrote above (markPaid, setState) is rolled back, which
    // is harmless precisely because the winner committed the identical
    // transition. All that is left to do is report it honestly instead of
    // letting a routine race surface as a 500.
    let tokenRow: { id: string };
    try {
      tokenRow = await drizzle.funnelClaimTokenRepo.insert(tx, {
        tokenHash: hashToken(plaintext),
        sessionId: input.sessionId,
        projectId: session.projectId,
        // Carried across from the purchase row, which is where the
        // payment-intent route parked it — this transaction never sees
        // the address itself, and asking Stripe for it would put a
        // network call inside an open transaction. Without this copy the
        // magic-link path has nothing to match on, which is the entire
        // reason a buyer who never returns to the tab can be reached at
        // all.
        //
        // `?? null` and not a throw: rows written before migration 0091
        // carry no hash, and a buyer who has genuinely paid must still
        // get their token. They simply lose the email fallback and keep
        // the session-id and deferred-match paths.
        emailHash: purchase.emailHash ?? null,
        expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
      });
    } catch (err) {
      if (!isSessionTokenRace(err)) throw err;
      log.info("lost the claim-token insert race; another caller issued it", {
        sessionId: input.sessionId,
      });
      return { alreadyIssued: true };
    }

    // Only the one-time path. A recurring package's purchase row and
    // entitlement are written by the Connect webhook's subscription
    // handler; running this for it too would write the same purchase
    // twice under two different natural keys. See grantOneTimePurchase.
    //
    // Placed AFTER the token insert on purpose: the insert is what
    // decides the confirm/webhook race, so by here we know this
    // transaction is the one that will commit, and the loser has already
    // returned without touching purchases or subscriber_access.
    if (!input.stripeSubscriptionId) {
      consumableGrant = await grantOneTimePurchase(tx as Db, {
        projectId: session.projectId,
        sessionId: input.sessionId,
        funnelPurchaseId: purchase.id,
        productId: purchase.productId,
        amountCents: purchase.amountCents,
        currency: purchase.currency,
        subscriberId: subscriber.id,
        stripePaymentIntentId: input.stripePaymentIntentId,
        amountUsd,
      });
    }

    const payload = {
      funnel_id: session.funnelId,
      version_id: session.funnelVersionId,
      project_id: session.projectId,
      purchase_id: purchase.id,
      token_id: tokenRow.id,
    };
    await emitFunnelEvent(tx, "funnel.session.paid", input.sessionId, payload);
    await emitFunnelEvent(
      tx,
      "funnel.claim_token.issued",
      input.sessionId,
      payload,
    );

    return { alreadyIssued: false, token: plaintext };
  });

  // Consumable credits, AFTER the paid transition has committed.
  //
  // `addCredits` (services/credit-engine.ts) always opens its own
  // `drizzle.db.transaction` — it has no parameter to join an existing one
  // — so it cannot be folded into the transaction above atomically no
  // matter how it is called: nesting it there would graft an
  // independently-committing transaction onto this one (credits could
  // survive a later rollback of the paid transition, or the reverse), and
  // letting it throw inside that transaction would violate
  // grantOneTimePurchase's "nothing here throws" contract, rolling back a
  // buyer's paid transition over a credit-grant hiccup.
  //
  // `addCredits` dedupes on (subscriberId, referenceType: "purchase",
  // referenceId: purchaseId, currencyId), so re-granting for the same
  // purchase is always safe. Nothing currently re-invokes this call
  // automatically on failure, though — a second `completeFunnelPurchase`
  // for the same session short-circuits on `purchase.status === "paid"`
  // before it would ever reach here again — so a failure is logged loudly
  // rather than silently dropped, for an operator to re-run by hand.
  if (consumableGrant) {
    const grant: ConsumableGrantInfo = consumableGrant;
    try {
      await grantPurchaseCurrencies(grant);
    } catch (err) {
      log.error(
        "failed to grant consumable currencies for a one-time funnel purchase",
        {
          sessionId: input.sessionId,
          purchaseId: grant.purchaseId,
          productId: grant.productId,
          err: err instanceof Error ? err.message : String(err),
        },
      );
    }
  }

  return result;
}
