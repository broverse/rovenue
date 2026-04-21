import bcrypt from "bcryptjs";
import { and, eq } from "drizzle-orm";
import {
  audiences,
  apiKeys,
  creditLedger,
  experimentAssignments,
  experiments,
  featureFlags,
  outgoingWebhooks,
  productGroups,
  products,
  projectMembers,
  projects,
  purchases,
  revenueEvents,
  subscriberAccess,
  subscribers,
  user as userTable,
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
const DEMO_USER_EMAIL = "demo@rovenue.dev";
const DEV_USER_EMAIL = "dev@rovenue.local";
const DEMO_PROJECT_ID = "proj_demo_seed";
const DEMO_PROJECT_SLUG = "demo";
const DEMO_PUBLIC_KEY = "rov_pub_demo_production";
const DEMO_API_KEY_ID = "apkdemoseedkey";
const DEMO_SECRET_PLAINTEXT = `rov_sec_${DEMO_API_KEY_ID}_demosecret123456789`;
const PRODUCT_PRO_MONTHLY = "pro_monthly";
const PRODUCT_CREDITS_100 = "credits_100";
const DEMO_PRODUCT_PRO_ID = "prd_demo_pro_monthly";
const DEMO_PRODUCT_CREDITS_ID = "prd_demo_credits_100";
const DEMO_GROUP_ID = "pg_demo_default";
const DEMO_AUDIENCE_ALL_ID = "aud_demo_all";
const DEMO_AUDIENCE_TR_ID = "aud_demo_tr";
const DEMO_FLAG_ID = "ff_demo_onboarding";
const DEMO_EXPERIMENT_ID = "exp_demo_paywall";
const DEFAULT_GROUP = "default";
const SUBSCRIBER_COUNT = 20;
const COUNTRIES = ["TR", "US", "DE", "GB", "BR", "JP", "IN", "FR"];
const PLATFORMS = ["ios", "android", "web"];

async function main() {
  console.log("Seeding database...");
  const now = new Date();

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
      entitlementKeys: ["premium", "analytics"],
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
      entitlementKeys: [],
      creditAmount: 100,
      isActive: true,
    })
    .onConflictDoNothing();

  await db
    .insert(productGroups)
    .values({
      id: DEMO_GROUP_ID,
      projectId: DEMO_PROJECT_ID,
      identifier: DEFAULT_GROUP,
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

  // Dev user lookup — optional ADMIN attachment.
  const devUserRows = await db
    .select({ id: userTable.id })
    .from(userTable)
    .where(eq(userTable.email, DEV_USER_EMAIL))
    .limit(1);
  const devUserId = devUserRows[0]?.id ?? null;
  if (devUserId) {
    await db
      .insert(projectMembers)
      .values({
        projectId: DEMO_PROJECT_ID,
        userId: devUserId,
        role: "ADMIN",
      })
      .onConflictDoNothing();
  }

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
        appUserId,
        attributes: { country, platform, appVersion: "1.2.0" },
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
        for (const entitlement of ["premium", "analytics"]) {
          // subscriber_access has no composite unique in the
          // schema, so we check-then-insert.
          const existing = await db
            .select({ id: subscriberAccess.id })
            .from(subscriberAccess)
            .where(
              and(
                eq(subscriberAccess.subscriberId, subId),
                eq(subscriberAccess.purchaseId, purId),
                eq(subscriberAccess.entitlementKey, entitlement),
              ),
            )
            .limit(1);
          if (existing.length === 0) {
            await db.insert(subscriberAccess).values({
              subscriberId: subId,
              purchaseId: purId,
              entitlementKey: entitlement,
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
    // checking for any existing BONUS entry for this subscriber.
    if (i % 3 === 0) {
      const existingCredit = await db
        .select({ id: creditLedger.id })
        .from(creditLedger)
        .where(
          and(
            eq(creditLedger.subscriberId, subId),
            eq(creditLedger.type, "BONUS"),
          ),
        )
        .limit(1);
      if (existingCredit.length === 0) {
        await db.insert(creditLedger).values({
          projectId: DEMO_PROJECT_ID,
          subscriberId: subId,
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
  if (devUserId) {
    console.log(
      `  dev user:    ${DEV_USER_EMAIL} → ADMIN on ${DEMO_PROJECT_SLUG}`,
    );
  } else {
    console.log(
      `  (tip: click "Continue as Dev User" on /login, then re-run seed)`,
    );
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await getPool().end();
  });
