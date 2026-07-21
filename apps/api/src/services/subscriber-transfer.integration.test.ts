process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "@rovenue/db";
import { addCredits, getAllBalances } from "./credit-engine";
import { reassignAllAssets, transferSubscriber } from "./subscriber-transfer";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_st_${RUN_ID}`;
const FROM_ID = `sub_st_from_${RUN_ID}`;
const TO_ID = `sub_st_to_${RUN_ID}`;

describe("subscriber-transfer multi-currency", () => {
  let goldId: string;
  let gemId: string;

  afterAll(async () => {
    // The project cascade hits credit_ledger, whose append-only trigger
    // rejects unauthorized DELETEs — teardown must opt in per tx.
    await drizzle.creditLedgerRepo.withLedgerDeleteAuthorized(
      drizzle.db,
      async (tx) => {
        await tx
          .delete(drizzle.schema.projects)
          .where(eq(drizzle.schema.projects.id, PROJECT_ID));
      },
    );
  });

  it("sets up project, two subscribers, and two currencies", async () => {
    await drizzle.db
      .insert(drizzle.schema.projects)
      .values({ id: PROJECT_ID, name: `ST ${RUN_ID}` });

    await drizzle.db.insert(drizzle.schema.subscribers).values([
      {
        id: FROM_ID,
        projectId: PROJECT_ID,
        rovenueId: `rov_st_from_${RUN_ID}`,
        appUserId: `user_from_${RUN_ID}`,
      },
      {
        id: TO_ID,
        projectId: PROJECT_ID,
        rovenueId: `rov_st_to_${RUN_ID}`,
        appUserId: `user_to_${RUN_ID}`,
      },
    ]);

    goldId = (
      await drizzle.virtualCurrencyRepo.createVirtualCurrency(drizzle.db, {
        projectId: PROJECT_ID,
        code: "GLD",
        name: "Gold",
      })
    ).id;
    gemId = (
      await drizzle.virtualCurrencyRepo.createVirtualCurrency(drizzle.db, {
        projectId: PROJECT_ID,
        code: "GEM",
        name: "Gems",
      })
    ).id;

    expect(goldId).toBeTruthy();
    expect(gemId).toBeTruthy();
  });

  it("grants two currencies to the FROM subscriber", async () => {
    await addCredits({ subscriberId: FROM_ID, currencyId: goldId, amount: 200 });
    await addCredits({ subscriberId: FROM_ID, currencyId: gemId, amount: 50 });

    const balances = await getAllBalances(FROM_ID);
    const map = Object.fromEntries(
      balances.map((b) => [b.currencyId, b.balance]),
    );
    expect(map[goldId]).toBe(200);
    expect(map[gemId]).toBe(50);
  });

  it("transfers ALL currency balances from FROM to TO", async () => {
    const result = await transferSubscriber(
      PROJECT_ID,
      `user_from_${RUN_ID}`,
      `user_to_${RUN_ID}`,
    );

    // Return contract: creditsTransferred = sum of all currencies moved
    expect(result.creditsTransferred).toBe(250); // 200 gold + 50 gems

    // TO subscriber now holds both balances
    const toBalances = await getAllBalances(TO_ID);
    const toMap = Object.fromEntries(
      toBalances.map((b) => [b.currencyId, b.balance]),
    );
    expect(toMap[goldId]).toBe(200);
    expect(toMap[gemId]).toBe(50);

    // FROM subscriber balances are net 0 for both currencies
    const fromBalances = await getAllBalances(FROM_ID);
    const fromMap = Object.fromEntries(
      fromBalances.map((b) => [b.currencyId, b.balance]),
    );
    expect(fromMap[goldId] ?? 0).toBe(0);
    expect(fromMap[gemId] ?? 0).toBe(0);
  });
});

// =============================================================
// Merge integrity: revenue_events must follow the survivor
// =============================================================
//
// Leaving revenue rows on the soft-deleted synthetic permanently
// under-counts the canonical subscriber's lifetime revenue
// (revenue_lifetime_subscriber_mv / Refund Shield) and breaks the
// expiry-checker's per-subscriber dedup lookup.

describe("reassignAllAssets revenue-event convergence", () => {
  const REV_PROJECT = `prj_st_rev_${RUN_ID}`;
  const REV_PRODUCT = `prod_st_rev_${RUN_ID}`;

  afterAll(async () => {
    await drizzle.db
      .delete(drizzle.schema.projects)
      .where(eq(drizzle.schema.projects.id, REV_PROJECT));
  });

  it("moves revenue_events onto the surviving subscriber", async () => {
    const db = drizzle.db;
    const OTXN = `otxn_st_rev_${RUN_ID}`;
    await db
      .insert(drizzle.schema.projects)
      .values({ id: REV_PROJECT, name: `ST-REV ${RUN_ID}` });
    await db.insert(drizzle.schema.products).values({
      id: REV_PRODUCT,
      projectId: REV_PROJECT,
      identifier: `com.app.strev.${RUN_ID}`,
      type: "SUBSCRIPTION",
      storeIds: { apple: `com.app.strev.${RUN_ID}` },
      displayName: `ST-REV Product ${RUN_ID}`,
      accessIds: [],
    });

    // Webhook-first synthetic owner with a purchase + INITIAL revenue event.
    const [synthetic] = await db
      .insert(drizzle.schema.subscribers)
      .values({
        projectId: REV_PROJECT,
        rovenueId: `apple:${OTXN}`,
        appUserId: `apple:${OTXN}`,
      })
      .returning();
    const [canonical] = await db
      .insert(drizzle.schema.subscribers)
      .values({
        projectId: REV_PROJECT,
        rovenueId: `rov_st_rev_${RUN_ID}`,
        appUserId: `user_st_rev_${RUN_ID}`,
      })
      .returning();
    const [purchase] = await db
      .insert(drizzle.schema.purchases)
      .values({
        projectId: REV_PROJECT,
        subscriberId: synthetic!.id,
        productId: REV_PRODUCT,
        store: "APP_STORE",
        storeTransactionId: `txn_${OTXN}`,
        originalTransactionId: OTXN,
        status: "ACTIVE",
        isTrial: false,
        isIntroOffer: false,
        isSandbox: true,
        environment: "SANDBOX",
        purchaseDate: new Date(),
        originalPurchaseDate: new Date(),
        expiresDate: new Date(Date.now() + 30 * 86_400_000),
        priceAmount: "9.99",
        priceCurrency: "USD",
        autoRenewStatus: true,
      })
      .returning();
    await db.insert(drizzle.schema.revenueEvents).values({
      projectId: REV_PROJECT,
      subscriberId: synthetic!.id,
      purchaseId: purchase!.id,
      type: "INITIAL",
      amount: "9.99",
      currency: "USD",
      amountUsd: "9.99",
      store: "APP_STORE",
      productId: REV_PRODUCT,
      eventDate: new Date(),
    });

    await db.transaction(async (tx) => {
      await reassignAllAssets(
        tx,
        REV_PROJECT,
        { id: synthetic!.id, label: synthetic!.appUserId! },
        { id: canonical!.id, label: canonical!.appUserId! },
      );
    });

    const events = await db
      .select()
      .from(drizzle.schema.revenueEvents)
      .where(eq(drizzle.schema.revenueEvents.projectId, REV_PROJECT));
    expect(events).toHaveLength(1);
    expect(events[0]!.subscriberId).toBe(canonical!.id);
  });
});

// =============================================================
// GDPR/KVKK erasure must release the Apple appAccountToken
// =============================================================
//
// The partial unique index on (projectId, appleAppAccountToken) only
// excludes NULL — not deletedAt rows — so a kept token either resurrects
// the anonymized row on the next webhook or 23505s the receipt path's
// rebind onto the user's next subscriber.

describe("anonymizeSubscriberRow", () => {
  const ANON_PROJECT = `prj_st_anon_${RUN_ID}`;
  const TOKEN = "6f9619ff-8b86-d011-b42d-00c04fc964ff";

  afterAll(async () => {
    await drizzle.db
      .delete(drizzle.schema.projects)
      .where(eq(drizzle.schema.projects.id, ANON_PROJECT));
  });

  it("releases the appleAppAccountToken so the erased row can't shadow future bindings", async () => {
    const db = drizzle.db;
    await db
      .insert(drizzle.schema.projects)
      .values({ id: ANON_PROJECT, name: `ST-ANON ${RUN_ID}` });
    const [sub] = await db
      .insert(drizzle.schema.subscribers)
      .values({
        projectId: ANON_PROJECT,
        rovenueId: `rov_st_anon_${RUN_ID}`,
        appUserId: `erase_me_${RUN_ID}`,
        appleAppAccountToken: TOKEN,
      })
      .returning();

    await drizzle.subscriberRepo.anonymizeSubscriberRow(
      db,
      sub!.id,
      `anon:${RUN_ID}`,
      new Date(),
    );

    const [after] = await db
      .select()
      .from(drizzle.schema.subscribers)
      .where(eq(drizzle.schema.subscribers.id, sub!.id));
    expect(after!.deletedAt).not.toBeNull();
    expect(after!.appUserId).toBe(`anon:${RUN_ID}`);
    expect(after!.appleAppAccountToken).toBeNull();
  });
});
