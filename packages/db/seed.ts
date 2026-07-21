import bcrypt from "bcryptjs";
import { and, eq } from "drizzle-orm";
import {
  access,
  audiences,
  apiKeys,
  billingTierLimits,
  creditLedger,
  experimentAssignments,
  experiments,
  featureFlags,
  offerings,
  outgoingWebhooks,
  productCurrencyGrants,
  products,
  projectMembers,
  projects,
  purchases,
  revenueEvents,
  subscriberAccess,
  subscribers,
  user as userTable,
  virtualCurrencies,
  webhookEvents,
} from "./src/drizzle/schema";
import { getPool } from "./src/drizzle/pool";
import { db } from "./src/drizzle/client";

// =============================================================
// Seed — demo project + subscribers + fixtures
// =============================================================
//
// Writes an idempotent demo dataset against the live database.
// Every insert uses `ON CONFLICT DO NOTHING` so re-running the
// script against a seeded DB is a no-op.

const DEMO_USER_ID = "usr_demo";
const DEMO_USER_EMAIL = "demo@rovenue.io";
const DEMO_PROJECT_ID = "proj_demo_seed";
const DEMO_PROJECT_SLUG = "demo";
const DEMO_PUBLIC_KEY = "rov_pub_demo_production";
const DEMO_API_KEY_ID = "apkdemoseedkey";
const DEMO_SECRET_PLAINTEXT = `rov_sec_${DEMO_API_KEY_ID}_demosecret123456789`;
const PRODUCT_PRO_MONTHLY = "pro_monthly";
const PRODUCT_CREDITS_100 = "credits_100";
const DEMO_PRODUCT_PRO_ID = "prd_demo_pro_monthly";
const DEMO_PRODUCT_CREDITS_ID = "prd_demo_credits_100";
const DEMO_OFFERING_ID = "ofr_demo_default";
const DEMO_ACCESS_PREMIUM_ID = "acs_demo_premium000000000";
const DEMO_ACCESS_ANALYTICS_ID = "acs_demo_analytics0000000";
const DEMO_AUDIENCE_ALL_ID = "aud_demo_all";
const DEMO_AUDIENCE_TR_ID = "aud_demo_tr";
const DEMO_FLAG_ID = "ff_demo_onboarding";
const DEMO_EXPERIMENT_ID = "exp_demo_paywall";
const DEMO_CURRENCY_GOLD_ID = "vc_demo_gold";
const DEMO_CURRENCY_GEM_ID = "vc_demo_gem";
const DEFAULT_OFFERING = "default";
const SUBSCRIBER_COUNT = 20;
const COUNTRIES = ["TR", "US", "DE", "GB", "BR", "JP", "IN", "FR"];
const PLATFORMS = ["ios", "android", "web"];

async function main() {
  console.log("Seeding database...");
  const now = new Date();

  // =============================================================
  // Tier limits reference data — 6 tiers x 2 cycles
  // =============================================================
  //
  // Idempotent: ON CONFLICT DO NOTHING. Update via a new migration when
  // prices change; never patch the seed in place — production-seeded
  // rows would not pick up the change.

  const TIER_LIMITS = [
    // Free
    { tier: "free",       cycle: "monthly", priceCents:      0, mtrMin:      0, mtrMax:   5000, events:     5_000_000, sql:  100, retention:   30, audit:    7 },
    { tier: "free",       cycle: "annual",  priceCents:      0, mtrMin:      0, mtrMax:   5000, events:     5_000_000, sql:  100, retention:   30, audit:    7 },
    // Indie (merged former indie+pro band)
    { tier: "indie",      cycle: "monthly", priceCents:   4900, mtrMin:   5000, mtrMax:  50000, events:    50_000_000, sql: 2500, retention:  180, audit:   90 },
    { tier: "indie",      cycle: "annual",  priceCents:  49000, mtrMin:   5000, mtrMax:  50000, events:    50_000_000, sql: 2500, retention:  180, audit:   90 },
    // Studio (former scale bracket)
    { tier: "studio",     cycle: "monthly", priceCents:  39900, mtrMin:  50000, mtrMax: 250000, events:   250_000_000, sql: null, retention:  365, audit:  365 },
    { tier: "studio",     cycle: "annual",  priceCents: 399000, mtrMin:  50000, mtrMax: 250000, events:   250_000_000, sql: null, retention:  365, audit:  365 },
    // Enterprise
    { tier: "enterprise", cycle: "monthly", priceCents:      0, mtrMin: 250000, mtrMax:   null, events:          null, sql: null, retention: 1825, audit: 1825 },
    { tier: "enterprise", cycle: "annual",  priceCents:      0, mtrMin: 250000, mtrMax:   null, events:          null, sql: null, retention: 1825, audit: 1825 },
  ] as const;

  const indieMonthlyPriceId =
    process.env.STRIPE_BILLING_INDIE_MONTHLY_PRICE_ID ?? null;

  await db
    .insert(billingTierLimits)
    .values(
      TIER_LIMITS.map((r) => ({
        tier: r.tier,
        cycle: r.cycle,
        priceUsdCents: r.priceCents,
        stripePriceId:
          r.tier === "indie" && r.cycle === "monthly"
            ? indieMonthlyPriceId
            : null,
        mtrMin: String(r.mtrMin),
        mtrMax: r.mtrMax === null ? null : String(r.mtrMax),
        eventsLimit: r.events,
        sqlLimit: r.sql,
        retentionDays: r.retention,
        auditLogDays: r.audit,
      })),
    )
    .onConflictDoNothing();

  await db
    .insert(userTable)
    .values({
      id: DEMO_USER_ID,
      name: "Demo User",
      email: DEMO_USER_EMAIL,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing();

  await db
    .insert(projects)
    .values({
      id: DEMO_PROJECT_ID,
      name: "Demo Project",
      slug: DEMO_PROJECT_SLUG,
      settings: {},
    })
    .onConflictDoNothing();

  await db
    .insert(projectMembers)
    .values({
      projectId: DEMO_PROJECT_ID,
      userId: DEMO_USER_ID,
      role: "OWNER",
    })
    .onConflictDoNothing();

  await db
    .insert(apiKeys)
    .values({
      id: DEMO_API_KEY_ID,
      projectId: DEMO_PROJECT_ID,
      label: "Default production key",
      keyPublic: DEMO_PUBLIC_KEY,
      keySecretHash: await bcrypt.hash(DEMO_SECRET_PLAINTEXT, 10),
      environment: "PRODUCTION",
    })
    .onConflictDoNothing();

  // -------- Access catalog (replaces free-form entitlement keys) --------
  await db
    .insert(access)
    .values({
      id: DEMO_ACCESS_PREMIUM_ID,
      projectId: DEMO_PROJECT_ID,
      identifier: "premium",
      displayName: "Premium",
      description: "Unlocks premium features",
    })
    .onConflictDoNothing();
  await db
    .insert(access)
    .values({
      id: DEMO_ACCESS_ANALYTICS_ID,
      projectId: DEMO_PROJECT_ID,
      identifier: "analytics",
      displayName: "Analytics",
      description: "Advanced analytics dashboards",
    })
    .onConflictDoNothing();

  await db
    .insert(products)
    .values({
      id: DEMO_PRODUCT_PRO_ID,
      projectId: DEMO_PROJECT_ID,
      identifier: PRODUCT_PRO_MONTHLY,
      type: "SUBSCRIPTION",
      displayName: "Pro Monthly",
      storeIds: {
        apple: "com.rovenue.demo.pro.monthly",
        google: PRODUCT_PRO_MONTHLY,
        stripe: "price_demo_pro_monthly",
      },
      accessIds: [DEMO_ACCESS_PREMIUM_ID, DEMO_ACCESS_ANALYTICS_ID],
      isActive: true,
    })
    .onConflictDoNothing();

  await db
    .insert(products)
    .values({
      id: DEMO_PRODUCT_CREDITS_ID,
      projectId: DEMO_PROJECT_ID,
      identifier: PRODUCT_CREDITS_100,
      type: "CONSUMABLE",
      displayName: "100 Credits",
      storeIds: {
        apple: "com.rovenue.demo.credits.100",
        google: PRODUCT_CREDITS_100,
        stripe: "price_demo_credits_100",
      },
      accessIds: [],
      creditAmount: 100,
      isActive: true,
    })
    .onConflictDoNothing();

  // -------- Virtual currencies --------
  await db
    .insert(virtualCurrencies)
    .values([
      { id: DEMO_CURRENCY_GOLD_ID, projectId: DEMO_PROJECT_ID, code: "GLD", name: "Coins" },
      { id: DEMO_CURRENCY_GEM_ID, projectId: DEMO_PROJECT_ID, code: "GEM", name: "Gems" },
    ])
    .onConflictDoNothing();

  await db
    .insert(productCurrencyGrants)
    .values([
      { productId: DEMO_PRODUCT_CREDITS_ID, currencyId: DEMO_CURRENCY_GOLD_ID, amount: 1000 },
      { productId: DEMO_PRODUCT_CREDITS_ID, currencyId: DEMO_CURRENCY_GEM_ID, amount: 5 },
    ])
    .onConflictDoNothing();

  await db
    .insert(offerings)
    .values({
      id: DEMO_OFFERING_ID,
      projectId: DEMO_PROJECT_ID,
      accessId: DEMO_ACCESS_PREMIUM_ID,
      identifier: DEFAULT_OFFERING,
      isDefault: true,
      products: [
        {
          productId: DEMO_PRODUCT_PRO_ID,
          order: 1,
          isPromoted: true,
          metadata: {},
        },
        {
          productId: DEMO_PRODUCT_CREDITS_ID,
          order: 2,
          isPromoted: false,
          metadata: {},
        },
      ],
      metadata: {
        title: "Choose your plan",
        description: "Upgrade to Pro or top up credits",
        theme: "default",
      },
    })
    .onConflictDoNothing();

  await db
    .insert(audiences)
    .values({
      id: DEMO_AUDIENCE_ALL_ID,
      projectId: DEMO_PROJECT_ID,
      name: "All Users",
      description: "Every subscriber in the project",
      rules: {},
      isDefault: true,
    })
    .onConflictDoNothing();

  await db
    .insert(audiences)
    .values({
      id: DEMO_AUDIENCE_TR_ID,
      projectId: DEMO_PROJECT_ID,
      name: "Turkey",
      description: "Subscribers with attributes.country = TR",
      rules: { country: { $eq: "TR" } },
      isDefault: false,
    })
    .onConflictDoNothing();

  // =============================================================
  // Subscribers + purchases + access + credits
  // =============================================================
  interface DemoSub {
    id: string;
    appUserId: string;
  }
  const demoSubscribers: DemoSub[] = [];
  for (let i = 0; i < SUBSCRIBER_COUNT; i++) {
    const appUserId = `demo_user_${String(i + 1).padStart(3, "0")}`;
    const country = COUNTRIES[i % COUNTRIES.length]!;
    const platform = PLATFORMS[i % PLATFORMS.length]!;
    const firstSeen = new Date(now.getTime() - (60 - i) * 86_400_000);
    const lastSeen = new Date(now.getTime() - (i % 10) * 86_400_000);
    const subId = `sub_demo_${String(i + 1).padStart(3, "0")}`;

    await db
      .insert(subscribers)
      .values({
        id: subId,
        projectId: DEMO_PROJECT_ID,
        rovenueId: appUserId,
        appUserId,
        attributes: {
          country: { value: country, updatedAt: "2026-01-01T00:00:00.000Z", source: "legacy" },
          platform: { value: platform, updatedAt: "2026-01-01T00:00:00.000Z", source: "legacy" },
          appVersion: { value: "1.2.0", updatedAt: "2026-01-01T00:00:00.000Z", source: "legacy" },
        },
        firstSeenAt: firstSeen,
        lastSeenAt: lastSeen,
      })
      .onConflictDoNothing();
    demoSubscribers.push({ id: subId, appUserId });

    // ~60% of subscribers have an active pro_monthly purchase
    if (i % 5 !== 0 && i % 7 !== 0) {
      const txId = `demo_tx_${i + 1}`;
      const purId = `pur_demo_${i + 1}`;
      const purchasedAt = new Date(firstSeen.getTime() + 86_400_000);
      const expiresAt = new Date(purchasedAt.getTime() + 30 * 86_400_000);
      const status =
        i % 11 === 0
          ? "EXPIRED"
          : i % 13 === 0
            ? "GRACE_PERIOD"
            : "ACTIVE";

      await db
        .insert(purchases)
        .values({
          id: purId,
          projectId: DEMO_PROJECT_ID,
          subscriberId: subId,
          productId: DEMO_PRODUCT_PRO_ID,
          store: "APP_STORE",
          storeTransactionId: txId,
          originalTransactionId: txId,
          status,
          isTrial: false,
          isIntroOffer: false,
          purchaseDate: purchasedAt,
          expiresDate: expiresAt,
          originalPurchaseDate: purchasedAt,
          priceAmount: "9.99",
          priceCurrency: "USD",
          environment: "PRODUCTION",
          autoRenewStatus: status === "ACTIVE",
        })
        .onConflictDoNothing();

      if (status !== "EXPIRED") {
        for (const accessId of [DEMO_ACCESS_PREMIUM_ID, DEMO_ACCESS_ANALYTICS_ID]) {
          // subscriber_access has no composite unique in the
          // schema, so we check-then-insert.
          const existing = await db
            .select({ id: subscriberAccess.id })
            .from(subscriberAccess)
            .where(
              and(
                eq(subscriberAccess.subscriberId, subId),
                eq(subscriberAccess.purchaseId, purId),
                eq(subscriberAccess.accessId, accessId),
              ),
            )
            .limit(1);
          if (existing.length === 0) {
            await db.insert(subscriberAccess).values({
              subscriberId: subId,
              purchaseId: purId,
              accessId,
              isActive: true,
              expiresDate: expiresAt,
              store: "APP_STORE",
            });
          }
        }
      }

      const existingRev = await db
        .select({ id: revenueEvents.id })
        .from(revenueEvents)
        .where(
          and(
            eq(revenueEvents.purchaseId, purId),
            eq(revenueEvents.type, "INITIAL"),
          ),
        )
        .limit(1);
      if (existingRev.length === 0) {
        // Intentional repo bypass: dev seeding does not flow through
        // revenueEventRepo.createRevenueEvent so the outbox is not
        // populated. Keeps bootstrap offline-friendly (no Redpanda
        // required to seed) and avoids dispatcher backlog on fresh
        // dev setups. Production code paths all go through the repo.
        await db.insert(revenueEvents).values({
          projectId: DEMO_PROJECT_ID,
          subscriberId: subId,
          purchaseId: purId,
          productId: DEMO_PRODUCT_PRO_ID,
          type: "INITIAL",
          amount: "9.99",
          currency: "USD",
          amountUsd: "9.99",
          store: "APP_STORE",
          eventDate: purchasedAt,
        });
      }
    }

    // Credit ledger: every 3rd subscriber gets a 100-credit grant.
    // Append-only with no natural dedup key; idempotency comes from
    // checking for any existing BONUS entry for this subscriber + currency.
    if (i % 3 === 0) {
      const existingCredit = await db
        .select({ id: creditLedger.id })
        .from(creditLedger)
        .where(
          and(
            eq(creditLedger.subscriberId, subId),
            eq(creditLedger.type, "BONUS"),
            eq(creditLedger.currencyId, DEMO_CURRENCY_GOLD_ID),
          ),
        )
        .limit(1);
      if (existingCredit.length === 0) {
        // Intentional repo bypass — same reasoning as the revenue
        // insert above; outbox not populated for dev seed data.
        await db.insert(creditLedger).values({
          projectId: DEMO_PROJECT_ID,
          subscriberId: subId,
          currencyId: DEMO_CURRENCY_GOLD_ID,
          type: "BONUS",
          amount: 100,
          balance: 100,
          referenceType: "bonus",
          description: "Welcome bonus",
        });
      }
    }
  }

  // =============================================================
  // Feature flag
  // =============================================================
  await db
    .insert(featureFlags)
    .values({
      id: DEMO_FLAG_ID,
      projectId: DEMO_PROJECT_ID,
      key: "new_onboarding",
      type: "BOOLEAN",
      defaultValue: false,
      rules: [],
      isEnabled: true,
      description: "Roll out the revamped onboarding wizard",
    })
    .onConflictDoNothing();

  // =============================================================
  // Experiment (RUNNING) — paywall A/B test
  // =============================================================
  await db
    .insert(experiments)
    .values({
      id: DEMO_EXPERIMENT_ID,
      projectId: DEMO_PROJECT_ID,
      name: "Paywall price test",
      description: "Compare $9.99 vs $7.99 monthly",
      type: "PAYWALL",
      key: "paywall_price_test",
      audienceId: DEMO_AUDIENCE_TR_ID,
      status: "RUNNING",
      variants: [
        {
          id: "control",
          name: "Control ($9.99)",
          value: { priceId: "price_999" },
          weight: 0.5,
        },
        {
          id: "treatment",
          name: "Treatment ($7.99)",
          value: { priceId: "price_799" },
          weight: 0.5,
        },
      ],
      metrics: ["purchase"],
      startedAt: new Date(now.getTime() - 14 * 86_400_000),
    })
    .onConflictDoNothing();

  for (let i = 0; i < Math.min(demoSubscribers.length, 12); i++) {
    const sub = demoSubscribers[i]!;
    const variantId = i % 2 === 0 ? "control" : "treatment";
    const converted = i % 3 === 0;
    await db
      .insert(experimentAssignments)
      .values({
        experimentId: DEMO_EXPERIMENT_ID,
        subscriberId: sub.id,
        variantId,
        assignedAt: new Date(now.getTime() - (12 - i) * 86_400_000),
        convertedAt: converted
          ? new Date(now.getTime() - (10 - i) * 86_400_000)
          : null,
        revenue: converted ? "9.99" : null,
        events: [
          { type: "paywall_viewed", timestamp: new Date().toISOString() },
          ...(converted
            ? [{ type: "purchase", timestamp: new Date().toISOString() }]
            : []),
        ],
      })
      .onConflictDoNothing({
        target: [
          experimentAssignments.experimentId,
          experimentAssignments.subscriberId,
        ],
      });
  }

  // =============================================================
  // Outgoing webhooks: 1 SENT, 1 DEAD (DLQ). No natural dedup key;
  // we skip this block after the first seed by checking for any
  // existing row for the first subscriber.
  // =============================================================
  if (demoSubscribers.length > 0) {
    const s = demoSubscribers[0]!;
    const existing = await db
      .select({ id: outgoingWebhooks.id })
      .from(outgoingWebhooks)
      .where(eq(outgoingWebhooks.subscriberId, s.id))
      .limit(1);
    if (existing.length === 0) {
      await db.insert(outgoingWebhooks).values({
        projectId: DEMO_PROJECT_ID,
        eventType: "purchase",
        subscriberId: s.id,
        payload: { eventType: "purchase", subscriberId: s.id, amount: 9.99 },
        url: "https://example.com/hook",
        status: "SENT",
        httpStatus: 200,
        attempts: 1,
        sentAt: new Date(now.getTime() - 86_400_000),
      });
      await db.insert(outgoingWebhooks).values({
        projectId: DEMO_PROJECT_ID,
        eventType: "purchase",
        subscriberId: s.id,
        payload: { eventType: "purchase", subscriberId: s.id },
        url: "https://example.com/broken-hook",
        status: "DEAD",
        httpStatus: 500,
        attempts: 5,
        lastErrorMessage: "connection refused",
        deadAt: new Date(now.getTime() - 6 * 3600_000),
      });
    }
  }

  // =============================================================
  // Webhook events (incoming) for visual filler
  // =============================================================
  const subForEvent = demoSubscribers[0];
  if (subForEvent) {
    await db
      .insert(webhookEvents)
      .values({
        projectId: DEMO_PROJECT_ID,
        subscriberId: subForEvent.id,
        source: "APPLE",
        eventType: "DID_RENEW",
        storeEventId: "demo_evt_1",
        status: "PROCESSED",
        payload: { demo: true },
        processedAt: new Date(now.getTime() - 86_400_000),
      })
      .onConflictDoNothing({
        target: [webhookEvents.source, webhookEvents.storeEventId],
      });
  }

  console.log("Seed complete");
  console.log(`  user:        ${DEMO_USER_EMAIL}`);
  console.log(`  project:     ${DEMO_PROJECT_SLUG} (${DEMO_PROJECT_ID})`);
  console.log(`  public key:  ${DEMO_PUBLIC_KEY}`);
  console.log(`  secret key:  ${DEMO_SECRET_PLAINTEXT} (DEV ONLY)`);
  console.log(`  subscribers: ${SUBSCRIBER_COUNT}`);
  console.log(`  experiments: 1 (paywall_price_test, RUNNING)`);
  console.log(`  flags:       1 (new_onboarding)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await getPool().end();
  });
