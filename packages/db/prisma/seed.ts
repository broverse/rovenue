import bcrypt from "bcryptjs";
import {
  CreditLedgerType,
  Environment,
  ExperimentStatus,
  ExperimentType,
  FeatureFlagType,
  MemberRole,
  OutgoingWebhookStatus,
  ProductType,
  PurchaseStatus,
  RevenueEventType,
  Store,
  WebhookEventStatus,
  WebhookSource,
} from "@prisma/client";
import prisma from "../src";

const DEMO_USER_ID = "usr_demo";
const DEMO_USER_EMAIL = "demo@rovenue.dev";
const DEV_USER_EMAIL = "dev@rovenue.local";
const DEMO_PROJECT_SLUG = "demo";
const DEMO_PUBLIC_KEY = "rov_pub_demo_production";
const DEMO_API_KEY_ID = "apkdemoseedkey";
const DEMO_SECRET_PLAINTEXT = `rov_sec_${DEMO_API_KEY_ID}_demosecret123456789`;
const PRODUCT_PRO_MONTHLY = "pro_monthly";
const PRODUCT_CREDITS_100 = "credits_100";
const DEFAULT_GROUP = "default";
const SUBSCRIBER_COUNT = 20;
const COUNTRIES = ["TR", "US", "DE", "GB", "BR", "JP", "IN", "FR"];
const PLATFORMS = ["ios", "android", "web"];

async function main() {
  console.log("Seeding database...");

  const now = new Date();

  const user = await prisma.user.upsert({
    where: { email: DEMO_USER_EMAIL },
    update: {},
    create: {
      id: DEMO_USER_ID,
      name: "Demo User",
      email: DEMO_USER_EMAIL,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    },
  });

  const project = await prisma.project.upsert({
    where: { slug: DEMO_PROJECT_SLUG },
    update: {},
    create: {
      name: "Demo Project",
      slug: DEMO_PROJECT_SLUG,
      settings: {},
    },
  });

  await prisma.projectMember.upsert({
    where: {
      projectId_userId: { projectId: project.id, userId: user.id },
    },
    update: {},
    create: {
      projectId: project.id,
      userId: user.id,
      role: MemberRole.OWNER,
    },
  });

  // Secret key format: `rov_sec_<apiKeyId>_<random>`. The id is encoded in
  // the token so the auth middleware can look up the row without bcrypting
  // every candidate.
  await prisma.apiKey.upsert({
    where: { keyPublic: DEMO_PUBLIC_KEY },
    update: {},
    create: {
      id: DEMO_API_KEY_ID,
      projectId: project.id,
      label: "Default production key",
      keyPublic: DEMO_PUBLIC_KEY,
      keySecretHash: await bcrypt.hash(DEMO_SECRET_PLAINTEXT, 10),
      environment: Environment.PRODUCTION,
    },
  });

  const subscription = await prisma.product.upsert({
    where: {
      projectId_identifier: {
        projectId: project.id,
        identifier: PRODUCT_PRO_MONTHLY,
      },
    },
    update: {},
    create: {
      projectId: project.id,
      identifier: PRODUCT_PRO_MONTHLY,
      type: ProductType.SUBSCRIPTION,
      displayName: "Pro Monthly",
      storeIds: {
        apple: "com.rovenue.demo.pro.monthly",
        google: PRODUCT_PRO_MONTHLY,
        stripe: "price_demo_pro_monthly",
      },
      entitlementKeys: ["premium", "analytics"],
      isActive: true,
    },
  });

  const creditPack = await prisma.product.upsert({
    where: {
      projectId_identifier: {
        projectId: project.id,
        identifier: PRODUCT_CREDITS_100,
      },
    },
    update: {},
    create: {
      projectId: project.id,
      identifier: PRODUCT_CREDITS_100,
      type: ProductType.CONSUMABLE,
      displayName: "100 Credits",
      storeIds: {
        apple: "com.rovenue.demo.credits.100",
        google: PRODUCT_CREDITS_100,
        stripe: "price_demo_credits_100",
      },
      entitlementKeys: [],
      creditAmount: 100,
      isActive: true,
    },
  });

  await prisma.productGroup.upsert({
    where: {
      projectId_identifier: {
        projectId: project.id,
        identifier: DEFAULT_GROUP,
      },
    },
    update: {},
    create: {
      projectId: project.id,
      identifier: DEFAULT_GROUP,
      isDefault: true,
      products: [
        {
          productId: subscription.id,
          order: 1,
          isPromoted: true,
          metadata: {},
        },
        {
          productId: creditPack.id,
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
    },
  });

  // =============================================================
  // Dev user: if the "Continue as Dev User" button has run at least
  // once, a User row exists for dev@rovenue.local. Attach it to the
  // demo project as an ADMIN so the seed is immediately useful.
  // =============================================================
  const devUser = await prisma.user.findUnique({
    where: { email: DEV_USER_EMAIL },
    select: { id: true },
  });
  if (devUser) {
    await prisma.projectMember.upsert({
      where: {
        projectId_userId: { projectId: project.id, userId: devUser.id },
      },
      update: {},
      create: {
        projectId: project.id,
        userId: devUser.id,
        role: MemberRole.ADMIN,
      },
    });
  }

  // =============================================================
  // Default audience (matches everyone)
  // =============================================================
  await prisma.audience.upsert({
    where: { projectId_name: { projectId: project.id, name: "All Users" } },
    update: {},
    create: {
      projectId: project.id,
      name: "All Users",
      description: "Every subscriber in the project",
      rules: {},
      isDefault: true,
    },
  });

  const turkeyAudience = await prisma.audience.upsert({
    where: { projectId_name: { projectId: project.id, name: "Turkey" } },
    update: {},
    create: {
      projectId: project.id,
      name: "Turkey",
      description: "Subscribers with attributes.country = TR",
      rules: { country: { $eq: "TR" } },
      isDefault: false,
    },
  });

  // =============================================================
  // Subscribers + purchases + access + credits
  // =============================================================
  const subscribers: { id: string; appUserId: string }[] = [];
  for (let i = 0; i < SUBSCRIBER_COUNT; i++) {
    const appUserId = `demo_user_${String(i + 1).padStart(3, "0")}`;
    const country = COUNTRIES[i % COUNTRIES.length]!;
    const platform = PLATFORMS[i % PLATFORMS.length]!;
    const firstSeen = new Date(now.getTime() - (60 - i) * 86_400_000);
    const lastSeen = new Date(now.getTime() - (i % 10) * 86_400_000);

    const sub = await prisma.subscriber.upsert({
      where: {
        projectId_appUserId: { projectId: project.id, appUserId },
      },
      update: {},
      create: {
        projectId: project.id,
        appUserId,
        attributes: { country, platform, appVersion: "1.2.0" },
        firstSeenAt: firstSeen,
        lastSeenAt: lastSeen,
      },
    });
    subscribers.push({ id: sub.id, appUserId });

    // ~60% of subscribers have an active pro_monthly purchase
    if (i % 5 !== 0 && i % 7 !== 0) {
      const txId = `demo_tx_${i + 1}`;
      const purchasedAt = new Date(firstSeen.getTime() + 86_400_000);
      const expiresAt = new Date(purchasedAt.getTime() + 30 * 86_400_000);
      const status =
        i % 11 === 0
          ? PurchaseStatus.EXPIRED
          : i % 13 === 0
            ? PurchaseStatus.GRACE_PERIOD
            : PurchaseStatus.ACTIVE;

      const purchase = await prisma.purchase.upsert({
        where: {
          store_storeTransactionId: { store: Store.APP_STORE, storeTransactionId: txId },
        },
        update: {},
        create: {
          projectId: project.id,
          subscriberId: sub.id,
          productId: subscription.id,
          store: Store.APP_STORE,
          storeTransactionId: txId,
          originalTransactionId: txId,
          status,
          isTrial: false,
          isIntroOffer: false,
          purchaseDate: purchasedAt,
          expiresDate: expiresAt,
          originalPurchaseDate: purchasedAt,
          priceAmount: 9.99,
          priceCurrency: "USD",
          environment: Environment.PRODUCTION,
          autoRenewStatus: status === PurchaseStatus.ACTIVE,
        },
      });

      if (status !== PurchaseStatus.EXPIRED) {
        for (const entitlement of ["premium", "analytics"]) {
          await prisma.subscriberAccess.upsert({
            where: {
              subscriberId_purchaseId_entitlementKey: {
                subscriberId: sub.id,
                purchaseId: purchase.id,
                entitlementKey: entitlement,
              },
            },
            update: {},
            create: {
              subscriberId: sub.id,
              purchaseId: purchase.id,
              entitlementKey: entitlement,
              isActive: true,
              expiresDate: expiresAt,
              store: Store.APP_STORE,
            },
          }).catch(() => {
            // subscriber_access has no composite unique in current
            // schema; fall through silently if it already exists.
          });
        }
      }

      // Revenue event for this purchase (no unique — idempotency
      // comes from the purchase upsert above; re-running seed skips
      // duplicates by the purchase existing check).
      const existingRev = await prisma.revenueEvent.findFirst({
        where: { purchaseId: purchase.id, type: RevenueEventType.INITIAL },
        select: { id: true },
      });
      if (!existingRev) {
        await prisma.revenueEvent.create({
          data: {
            projectId: project.id,
            subscriberId: sub.id,
            purchaseId: purchase.id,
            productId: subscription.id,
            type: RevenueEventType.INITIAL,
            amount: 9.99,
            currency: "USD",
            amountUsd: 9.99,
            store: Store.APP_STORE,
            eventDate: purchasedAt,
          },
        });
      }
    }

    // Credit ledger: every 3rd subscriber gets a 100-credit grant
    if (i % 3 === 0) {
      await prisma.creditLedger.create({
        data: {
          projectId: project.id,
          subscriberId: sub.id,
          type: CreditLedgerType.BONUS,
          amount: 100,
          balance: 100,
          referenceType: "bonus",
          description: "Welcome bonus",
        },
      });
    }
  }

  // =============================================================
  // Feature flag
  // =============================================================
  await prisma.featureFlag.upsert({
    where: { projectId_key: { projectId: project.id, key: "new_onboarding" } },
    update: {},
    create: {
      projectId: project.id,
      key: "new_onboarding",
      type: FeatureFlagType.BOOLEAN,
      defaultValue: false,
      rules: [],
      isEnabled: true,
      description: "Roll out the revamped onboarding wizard",
    },
  });

  // =============================================================
  // Experiment (RUNNING) — paywall A/B test
  // =============================================================
  const experiment = await prisma.experiment.upsert({
    where: { projectId_key: { projectId: project.id, key: "paywall_price_test" } },
    update: {},
    create: {
      projectId: project.id,
      name: "Paywall price test",
      description: "Compare $9.99 vs $7.99 monthly",
      type: ExperimentType.PAYWALL,
      key: "paywall_price_test",
      audienceId: turkeyAudience.id,
      status: ExperimentStatus.RUNNING,
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
    },
  });

  // Assignments: half to each variant, a third of each converted
  for (let i = 0; i < Math.min(subscribers.length, 12); i++) {
    const sub = subscribers[i]!;
    const variantId = i % 2 === 0 ? "control" : "treatment";
    const converted = i % 3 === 0;
    await prisma.experimentAssignment.upsert({
      where: {
        experimentId_subscriberId: {
          experimentId: experiment.id,
          subscriberId: sub.id,
        },
      },
      update: {},
      create: {
        experimentId: experiment.id,
        subscriberId: sub.id,
        variantId,
        assignedAt: new Date(now.getTime() - (12 - i) * 86_400_000),
        convertedAt: converted
          ? new Date(now.getTime() - (10 - i) * 86_400_000)
          : null,
        revenue: converted ? 9.99 : null,
        events: [
          { type: "paywall_viewed", timestamp: new Date().toISOString() },
          ...(converted
            ? [{ type: "purchase", timestamp: new Date().toISOString() }]
            : []),
        ],
      },
    });
  }

  // =============================================================
  // Outgoing webhooks: 3 SENT, 1 DEAD (DLQ)
  // =============================================================
  if (subscribers.length > 0) {
    const s = subscribers[0]!;
    await prisma.outgoingWebhook.create({
      data: {
        projectId: project.id,
        eventType: "purchase",
        subscriberId: s.id,
        payload: { eventType: "purchase", subscriberId: s.id, amount: 9.99 },
        url: "https://example.com/hook",
        status: OutgoingWebhookStatus.SENT,
        httpStatus: 200,
        attempts: 1,
        sentAt: new Date(now.getTime() - 86_400_000),
      },
    });
    await prisma.outgoingWebhook.create({
      data: {
        projectId: project.id,
        eventType: "purchase",
        subscriberId: s.id,
        payload: { eventType: "purchase", subscriberId: s.id },
        url: "https://example.com/broken-hook",
        status: OutgoingWebhookStatus.DEAD,
        httpStatus: 500,
        attempts: 5,
        lastErrorMessage: "connection refused",
        deadAt: new Date(now.getTime() - 6 * 3600_000),
      },
    });
  }

  // =============================================================
  // Webhook events (incoming) for visual filler
  // =============================================================
  const subForEvent = subscribers[0];
  if (subForEvent) {
    await prisma.webhookEvent.upsert({
      where: {
        source_storeEventId: {
          source: WebhookSource.APPLE,
          storeEventId: "demo_evt_1",
        },
      },
      update: {},
      create: {
        projectId: project.id,
        subscriberId: subForEvent.id,
        source: WebhookSource.APPLE,
        eventType: "DID_RENEW",
        storeEventId: "demo_evt_1",
        status: WebhookEventStatus.PROCESSED,
        payload: { demo: true },
        processedAt: new Date(now.getTime() - 86_400_000),
      },
    });
  }

  console.log("Seed complete");
  console.log(`  user:        ${user.email}`);
  console.log(`  project:     ${project.slug} (${project.id})`);
  console.log(`  public key:  ${DEMO_PUBLIC_KEY}`);
  console.log(`  secret key:  ${DEMO_SECRET_PLAINTEXT} (DEV ONLY)`);
  console.log(`  subscribers: ${SUBSCRIBER_COUNT}`);
  console.log(`  experiments: 1 (paywall_price_test, RUNNING)`);
  console.log(`  flags:       1 (new_onboarding)`);
  if (devUser) {
    console.log(`  dev user:    ${DEV_USER_EMAIL} → ADMIN on ${project.slug}`);
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
    await prisma.$disconnect();
  });
