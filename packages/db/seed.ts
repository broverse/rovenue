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
  paywalls,
  placements,
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

// -------- Seed target --------
//
// With no env vars set the seed owns its data end to end: it creates the demo
// user and demo project, then fills them. To load the same fixture set into an
// account that already exists instead:
//
//   SEED_PROJECT_NAME="my project" SEED_USER_EMAIL=me@example.com pnpm db:seed
//
// (or SEED_PROJECT_ID=<id> to skip the name lookup). In that mode the seed
// never creates a user or a project — it resolves them and fails loudly if
// they are missing, ambiguous, or the user is not a member of the project.
const TARGET_PROJECT_ID = process.env.SEED_PROJECT_ID ?? null;
const TARGET_PROJECT_NAME = process.env.SEED_PROJECT_NAME ?? null;
const TARGET_USER_EMAIL = process.env.SEED_USER_EMAIL ?? null;

const DEFAULT_USER_ID = "usr_demo";
const DEFAULT_USER_EMAIL = "demo@rovenue.io";
const DEFAULT_PROJECT_ID = "proj_demo_seed";
const DEFAULT_PROJECT_NAME = "Demo Project";
// Namespace stamped into every primary key the seed mints, so two projects can
// hold the same fixtures side by side. Most of the natural keys here are
// unique per project, but three are unique GLOBALLY and would otherwise
// collide across projects: api_keys.keyPublic, purchases (store,
// storeTransactionId) and webhook_events (source, storeEventId). The "demo"
// namespace reproduces the historical ids byte for byte, so re-running against
// an already-seeded demo project stays the no-op it has always been.
const DEFAULT_NS = "demo";

const PRODUCT_PRO_MONTHLY = "pro_monthly";
const PRODUCT_CREDITS_100 = "credits_100";
const DEMO_PACKAGE_PRO = "pro_monthly";
const DEMO_PACKAGE_CREDITS = "credits_100";
const DEFAULT_OFFERING = "default";
const SUBSCRIBER_COUNT = 20;
const COUNTRIES = ["TR", "US", "DE", "GB", "BR", "JP", "IN", "FR"];
const PLATFORMS = ["ios", "android", "web"];

/** Every id the seed mints, derived from the target's key namespace. */
function seedIds(ns: string) {
  const apiKeyId = `apk${ns}seedkey`;
  return {
    DEMO_PUBLIC_KEY: `rov_pub_${ns}_production`,
    DEMO_API_KEY_ID: apiKeyId,
    DEMO_SECRET_PLAINTEXT: `rov_sec_${apiKeyId}_${ns}secret123456789`,
    DEMO_PRODUCT_PRO_ID: `prd_${ns}_pro_monthly`,
    DEMO_PRODUCT_CREDITS_ID: `prd_${ns}_credits_100`,
    DEMO_OFFERING_ID: `ofr_${ns}_default`,
    DEMO_ACCESS_PREMIUM_ID: `acs_${ns}_premium000000000`,
    DEMO_ACCESS_ANALYTICS_ID: `acs_${ns}_analytics0000000`,
    DEMO_AUDIENCE_ALL_ID: `aud_${ns}_all`,
    DEMO_AUDIENCE_TR_ID: `aud_${ns}_tr`,
    DEMO_PAYWALL_DEFAULT_ID: `pwl_${ns}_default`,
    DEMO_PAYWALL_PROMO_ID: `pwl_${ns}_promo`,
    DEMO_PLACEMENT_ID: `plc_${ns}_onboarding`,
    DEMO_FLAG_ID: `ff_${ns}_onboarding`,
    DEMO_EXPERIMENT_ID: `exp_${ns}_paywall`,
    DEMO_CURRENCY_GOLD_ID: `vc_${ns}_gold`,
    DEMO_CURRENCY_GEM_ID: `vc_${ns}_gem`,
  };
}

interface SeedTarget {
  ns: string;
  projectId: string;
  projectName: string;
  userEmail: string | null;
  /** Demo path only: the seed owns the account, so it creates it. */
  createsAccount: boolean;
}

async function resolveTarget(): Promise<SeedTarget> {
  if (!TARGET_PROJECT_ID && !TARGET_PROJECT_NAME) {
    return {
      ns: DEFAULT_NS,
      projectId: DEFAULT_PROJECT_ID,
      projectName: DEFAULT_PROJECT_NAME,
      userEmail: DEFAULT_USER_EMAIL,
      createsAccount: true,
    };
  }

  const matches = await db
    .select({ id: projects.id, name: projects.name })
    .from(projects)
    .where(
      TARGET_PROJECT_ID
        ? eq(projects.id, TARGET_PROJECT_ID)
        : eq(projects.name, TARGET_PROJECT_NAME!),
    );

  const wanted = TARGET_PROJECT_ID
    ? `SEED_PROJECT_ID=${TARGET_PROJECT_ID}`
    : `SEED_PROJECT_NAME=${TARGET_PROJECT_NAME}`;
  if (matches.length === 0) {
    throw new Error(`${wanted} matches no project.`);
  }
  if (matches.length > 1) {
    throw new Error(
      `${wanted} matches ${matches.length} projects (${matches
        .map((p) => p.id)
        .join(", ")}). Re-run with SEED_PROJECT_ID.`,
    );
  }
  const project = matches[0]!;

  if (TARGET_USER_EMAIL) {
    const [owner] = await db
      .select({ id: userTable.id })
      .from(userTable)
      .where(eq(userTable.email, TARGET_USER_EMAIL))
      .limit(1);
    if (!owner) {
      throw new Error(`SEED_USER_EMAIL=${TARGET_USER_EMAIL} matches no user.`);
    }
    // Guard against seeding someone else's project by mistyping either half.
    const [membership] = await db
      .select({ role: projectMembers.role })
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, project.id),
          eq(projectMembers.userId, owner.id),
        ),
      )
      .limit(1);
    if (!membership) {
      throw new Error(
        `${TARGET_USER_EMAIL} is not a member of project "${project.name}" (${project.id}).`,
      );
    }
  }

  return {
    // The project id itself: unique by construction, so no chance of two
    // seeded projects sharing a namespace.
    ns: project.id,
    projectId: project.id,
    projectName: project.name,
    userEmail: TARGET_USER_EMAIL,
    createsAccount: false,
  };
}

async function main() {
  const target = await resolveTarget();
  const DEMO_PROJECT_ID = target.projectId;
  const {
    DEMO_PUBLIC_KEY,
    DEMO_API_KEY_ID,
    DEMO_SECRET_PLAINTEXT,
    DEMO_PRODUCT_PRO_ID,
    DEMO_PRODUCT_CREDITS_ID,
    DEMO_OFFERING_ID,
    DEMO_ACCESS_PREMIUM_ID,
    DEMO_ACCESS_ANALYTICS_ID,
    DEMO_AUDIENCE_ALL_ID,
    DEMO_AUDIENCE_TR_ID,
    DEMO_PAYWALL_DEFAULT_ID,
    DEMO_PAYWALL_PROMO_ID,
    DEMO_PLACEMENT_ID,
    DEMO_FLAG_ID,
    DEMO_EXPERIMENT_ID,
    DEMO_CURRENCY_GOLD_ID,
    DEMO_CURRENCY_GEM_ID,
  } = seedIds(target.ns);

  console.log("Seeding database...");
  const now = new Date();

  // =============================================================
  // Tier limits reference data — 6 tiers x 2 cycles
  // =============================================================
  //
  // Idempotent: ON CONFLICT DO NOTHING. Update via a new migration when
  // prices change; never patch the seed in place — production-seeded
  // rows would not pick up the change.

  // Byte units for the storage column, so the ladder below reads as the
  // ladder rather than as nine-digit constants. `null` = unlimited.
  const MB = 1024 * 1024;
  const GB = 1024 * MB;

  const TIER_LIMITS = [
    // Free
    { tier: "free",       cycle: "monthly", priceCents:      0, mtrMin:      0, mtrMax:   5000, events:     5_000_000, sql:  100, retention:   30, audit:    7, storage:      250 * MB },
    { tier: "free",       cycle: "annual",  priceCents:      0, mtrMin:      0, mtrMax:   5000, events:     5_000_000, sql:  100, retention:   30, audit:    7, storage:      250 * MB },
    // Indie (merged former indie+pro band)
    { tier: "indie",      cycle: "monthly", priceCents:   4900, mtrMin:   5000, mtrMax:  50000, events:    50_000_000, sql: 2500, retention:  180, audit:   90, storage:        5 * GB },
    { tier: "indie",      cycle: "annual",  priceCents:  49000, mtrMin:   5000, mtrMax:  50000, events:    50_000_000, sql: 2500, retention:  180, audit:   90, storage:        5 * GB },
    // Studio (former scale bracket)
    { tier: "studio",     cycle: "monthly", priceCents:  39900, mtrMin:  50000, mtrMax: 250000, events:   250_000_000, sql: null, retention:  365, audit:  365, storage:       50 * GB },
    { tier: "studio",     cycle: "annual",  priceCents: 399000, mtrMin:  50000, mtrMax: 250000, events:   250_000_000, sql: null, retention:  365, audit:  365, storage:       50 * GB },
    // Enterprise
    { tier: "enterprise", cycle: "monthly", priceCents:      0, mtrMin: 250000, mtrMax:   null, events:          null, sql: null, retention: 1825, audit: 1825, storage:      null     },
    { tier: "enterprise", cycle: "annual",  priceCents:      0, mtrMin: 250000, mtrMax:   null, events:          null, sql: null, retention: 1825, audit: 1825, storage:      null     },
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
        // Migration 0101 repairs this on databases seeded before the
        // column existed; it is listed here so a fresh `db:seed` never
        // needs the repair in the first place. NULL would mean unlimited.
        assetStorageBytesLimit: r.storage,
      })),
    )
    .onConflictDoNothing();

  // Migration 0100 now seeds this ladder, so the insert above is a no-op on
  // any migrated database and its `stripePriceId` never lands. The price id
  // is the one field here that is environment-specific rather than reference
  // data — the migration leaves it NULL on purpose — so set it explicitly.
  // Guarded on the env var: without it this would blank a configured id.
  if (indieMonthlyPriceId) {
    await db
      .update(billingTierLimits)
      .set({ stripePriceId: indieMonthlyPriceId })
      .where(
        and(
          eq(billingTierLimits.tier, "indie"),
          eq(billingTierLimits.cycle, "monthly"),
        ),
      );
  }

  // Only the demo path mints an account; a targeted run seeds into a user and
  // project that already exist and leaves both untouched.
  if (target.createsAccount) {
    await db
      .insert(userTable)
      .values({
        id: DEFAULT_USER_ID,
        name: "Demo User",
        email: DEFAULT_USER_EMAIL,
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing();

    await db
      .insert(projects)
      .values({
        id: DEMO_PROJECT_ID,
        name: DEFAULT_PROJECT_NAME,
        settings: {},
      })
      .onConflictDoNothing();

    await db
      .insert(projectMembers)
      .values({
        projectId: DEMO_PROJECT_ID,
        userId: DEFAULT_USER_ID,
        role: "OWNER",
      })
      .onConflictDoNothing();
  }

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
      identifier: DEFAULT_OFFERING,
      isDefault: true,
      // Package slots (migration 0074 replaced the old `products` jsonb +
      // `accessId` column). Identifiers are what a paywall's builderConfig
      // `packageList.packageIds` references — keep them in sync with
      // DEMO_PACKAGE_* below.
      packages: [
        {
          identifier: DEMO_PACKAGE_PRO,
          productId: DEMO_PRODUCT_PRO_ID,
          order: 1,
          isPromoted: true,
          metadata: {},
        },
        {
          identifier: DEMO_PACKAGE_CREDITS,
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
  // Paywalls — one builder paywall (configFormatVersion 2, the
  // component tree the web/native renderers decode) and one
  // remote-config-only paywall (format 1, the pre-builder path).
  // Both hang off the default offering, so packageList ids must be
  // the offering's package slot identifiers.
  // =============================================================
  const demoBuilderConfig = {
    formatVersion: 2,
    defaultLocale: "en",
    localizations: {
      en: {
        "hero.title": "Go Pro",
        "hero.subtitle": "Unlock every feature, cancel anytime.",
        "cta.purchase": "Start free trial",
        "cta.restore": "Restore purchases",
        "cta.terms": "Terms & Privacy",
      },
      tr: {
        "hero.title": "Pro'ya geç",
        "hero.subtitle": "Tüm özellikler açılsın, istediğin an iptal et.",
        "cta.purchase": "Ücretsiz denemeyi başlat",
        "cta.restore": "Satın alımları geri yükle",
        "cta.terms": "Şartlar ve Gizlilik",
      },
    },
    background: { light: "#FFFFFF", dark: "#0B0B0F" },
    root: {
      type: "stack",
      id: "root",
      axis: "v",
      spacing: 16,
      align: "center",
      padding: { t: 24, r: 20, b: 32, l: 20 },
      size: { width: "fill", height: "fill" },
      children: [
        {
          type: "image",
          id: "hero-image",
          url: {
            light: "https://placehold.co/600x320/EEF2FF/1E1B4B.png",
            dark: "https://placehold.co/600x320/1E1B4B/EEF2FF.png",
          },
          height: 160,
          cornerRadius: 12,
          alt: "Demo paywall hero",
        },
        {
          type: "text",
          id: "hero-title",
          key: "hero.title",
          role: "title",
          align: "center",
        },
        {
          type: "text",
          id: "hero-subtitle",
          key: "hero.subtitle",
          role: "subtitle",
          align: "center",
          color: { light: "#4B5563", dark: "#9CA3AF" },
        },
        { type: "spacer", id: "hero-spacer", size: 8 },
        {
          type: "packageList",
          id: "packages",
          packageIds: [DEMO_PACKAGE_PRO, DEMO_PACKAGE_CREDITS],
          defaultSelected: DEMO_PACKAGE_PRO,
          cellLayout: "column",
        },
        {
          type: "purchaseButton",
          id: "purchase-cta",
          labelKey: "cta.purchase",
        },
        {
          type: "button",
          id: "restore-cta",
          labelKey: "cta.restore",
          style: "plain",
          action: { kind: "restore" },
        },
        {
          type: "button",
          id: "terms-cta",
          labelKey: "cta.terms",
          style: "plain",
          action: { kind: "url", url: "https://example.com/terms" },
        },
      ],
    },
  };

  await db
    .insert(paywalls)
    .values({
      id: DEMO_PAYWALL_DEFAULT_ID,
      projectId: DEMO_PROJECT_ID,
      identifier: "demo_default",
      name: "Demo Default Paywall",
      offeringId: DEMO_OFFERING_ID,
      remoteConfig: {
        defaultLocale: "en",
        locales: {
          en: { headline: "Go Pro", cta: "Start free trial" },
          tr: { headline: "Pro'ya geç", cta: "Ücretsiz denemeyi başlat" },
        },
      },
      // Server-derived in the API: 2 whenever builderConfig is present.
      configFormatVersion: 2,
      builderConfig: demoBuilderConfig,
      isActive: true,
      metadata: { source: "seed" },
    })
    .onConflictDoNothing();

  await db
    .insert(paywalls)
    .values({
      id: DEMO_PAYWALL_PROMO_ID,
      projectId: DEMO_PROJECT_ID,
      identifier: "demo_promo",
      name: "Demo Promo Paywall (remote config only)",
      offeringId: DEMO_OFFERING_ID,
      remoteConfig: {
        defaultLocale: "tr",
        locales: {
          tr: {
            headline: "Sana özel %40 indirim",
            cta: "İndirimi kullan",
            badge: "TR",
          },
          en: { headline: "40% off, just for you", cta: "Claim discount", badge: "TR" },
        },
      },
      configFormatVersion: 1,
      builderConfig: null,
      isActive: true,
      metadata: { source: "seed" },
    })
    .onConflictDoNothing();

  // =============================================================
  // Placement — ordered rows, first match wins. The all-users row
  // (audienceId null) must be last; see placementRowsSchema.
  // =============================================================
  await db
    .insert(placements)
    .values({
      id: DEMO_PLACEMENT_ID,
      projectId: DEMO_PROJECT_ID,
      identifier: "onboarding",
      name: "Onboarding",
      rows: [
        {
          audienceId: DEMO_AUDIENCE_TR_ID,
          target: { type: "paywall", paywallId: DEMO_PAYWALL_PROMO_ID },
        },
        {
          audienceId: null,
          target: { type: "paywall", paywallId: DEMO_PAYWALL_DEFAULT_ID },
        },
      ],
      isActive: true,
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
    const appUserId = `${target.ns}_user_${String(i + 1).padStart(3, "0")}`;
    const country = COUNTRIES[i % COUNTRIES.length]!;
    const platform = PLATFORMS[i % PLATFORMS.length]!;
    const firstSeen = new Date(now.getTime() - (60 - i) * 86_400_000);
    const lastSeen = new Date(now.getTime() - (i % 10) * 86_400_000);
    const subId = `sub_${target.ns}_${String(i + 1).padStart(3, "0")}`;

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
      // (store, storeTransactionId) is unique across the whole table, not per
      // project, so txId has to carry the namespace.
      const txId = `${target.ns}_tx_${i + 1}`;
      const purId = `pur_${target.ns}_${i + 1}`;
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
        // Also globally unique, paired with `source`.
        storeEventId: `${target.ns}_evt_1`,
        status: "PROCESSED",
        payload: { demo: true },
        processedAt: new Date(now.getTime() - 86_400_000),
      })
      .onConflictDoNothing({
        target: [webhookEvents.source, webhookEvents.storeEventId],
      });
  }

  console.log("Seed complete");
  console.log(`  user:        ${target.userEmail ?? "(existing members)"}`);
  console.log(`  project:     ${target.projectName} (${DEMO_PROJECT_ID})`);
  console.log(`  public key:  ${DEMO_PUBLIC_KEY}`);
  console.log(`  secret key:  ${DEMO_SECRET_PLAINTEXT} (DEV ONLY)`);
  console.log(`  subscribers: ${SUBSCRIBER_COUNT}`);
  console.log(`  experiments: 1 (paywall_price_test, RUNNING)`);
  console.log(`  flags:       1 (new_onboarding)`);
  console.log(`  paywalls:    2 (demo_default [builder], demo_promo [remote config])`);
  console.log(`  placements:  1 (onboarding → TR:demo_promo, all:demo_default)`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await getPool().end();
  });
