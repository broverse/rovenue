// =============================================================
// renewal-grant end-to-end — real Postgres integration test
// =============================================================
//
// Every other consumer of `rovenue.revenue` in this repo is integration
// delivery, which is allowed to drop a message. This consumer is not: a
// dropped message means a subscriber's purchased credits never arrive.
//
// WHAT THIS FILE PROVES, PRECISELY:
//   - A REAL Postgres write through the real writer
//     (drizzle.revenueEventRepo.createRevenueEvent) produces an outbox row
//     whose payload shape `toRenewalGrantJob` actually accepts (not a
//     hand-built fixture that could carry a wrong field name both sides
//     happen to agree on).
//   - `toRenewalGrantJob`'s event-type filter (RENEWAL/TRIAL_CONVERSION/
//     REACTIVATION granted, INITIAL dropped) runs against that real row.
//   - `runRenewalGrant` + LIVE (non-mocked) `grantProductCurrencies` /
//     `productRepo.findProductById` deps — the same pair
//     workers/renewal-grant.ts's own `liveDeps` wires up — actually moves
//     a subscriber's real credit_ledger balance, and that `addCredits`'
//     (referenceType, referenceId, currencyId) dedup really does swallow a
//     second run of the identical job (the redelivery case).
//
// WHAT THIS FILE DOES NOT PROVE — the seams left for a future test:
//   - The real Kafka wire hop. This file starts no Redpanda container and
//     publishes nothing to `rovenue.revenue`; it reads the outbox row back
//     and reconstructs the message bytes via `toOutboxKafkaMessage`
//     (imported from workers/outbox-dispatcher.ts, not a local copy — see
//     that file for why this used to be its own literal). The dispatcher's
//     OWN publish of that exact function against a real Redpanda is
//     covered by outbox-dispatcher.integration.test.ts, but not for the
//     REVENUE_EVENT topic specifically and not chained into this consumer.
//   - `startRenewalGrantConsumer`'s `consumer.run` loop — the
//     `JSON.parse(message.value)` + `deps.enqueue(...)` hop in
//     services/renewal-grants/consumer.ts — is exercised only by
//     consumer.test.ts's synthetic messages, not here.
//   - The BullMQ leg: `renewal-grants-boot.ts`'s `queue.add(...)` and
//     `ensureRenewalGrantWorker`'s `Worker` picking the job back up. This
//     file calls `runRenewalGrant` directly, never through a real queue.
//   Driving consumer→queue→worker end-to-end against a real Redpanda is a
//   separate, larger task; this file does not attempt it.
//
// The seed goes through the REAL writer — drizzle.revenueEventRepo
// .createRevenueEvent — so the outbox row is produced exactly the way
// production produces it (see insertRevenueRow in
// packages/db/src/drizzle/repositories/revenue-events.ts), never a
// hand-built outbox row.
//
// Follows the inline-seed convention of the other worker integration
// tests (access-reconciliation, google-reconciliation, expiry-checker):
// no withTestDb/seedProject helper exists in this codebase, so this uses
// getDb() directly and seeds every row itself. Reference data
// (product_currency_grants) is seeded via the repository's plain insert
// helper (setProductGrants), never via the RENEWAL trigger's own service.

import { afterAll, beforeEach, describe, expect, test } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import {
  drizzle,
  getDb,
  outboxEvents,
  products,
  projects,
  purchases,
  subscribers,
  type OutboxEvent,
} from "@rovenue/db";
import { getBalance } from "../services/credit-engine";
import { grantProductCurrencies } from "../services/purchase-credits";
import { toRenewalGrantJob } from "../services/renewal-grants/consumer";
import { toOutboxKafkaMessage } from "./outbox-dispatcher";
import { runRenewalGrant, type RenewalGrantDeps } from "./renewal-grant";

const RUN_ID = Date.now();

let seq = 0;
function nextSuffix(): string {
  seq += 1;
  return `${RUN_ID}_${seq}`;
}

// The same pair workers/renewal-grant.ts's own (unexported) `liveDeps`
// wires up: grantProductCurrencies for the grant, productRepo.findProductById
// (project-scoped) for the product lookup. Reconstructed here rather than
// imported because liveDeps is not exported — bootRenewalGrants is the only
// production caller and it goes through ensureRenewalGrantWorker instead.
const liveDeps: RenewalGrantDeps = {
  grant: (args) => grantProductCurrencies(args),
  loadProduct: async (projectId, productId) => {
    const product = await drizzle.productRepo.findProductById(
      drizzle.db,
      projectId,
      productId,
    );
    return product ? { identifier: product.identifier } : null;
  },
};

interface RenewalFixture {
  projectId: string;
  subscriberId: string;
  productId: string;
  purchaseId: string;
  currencyId: string;
}

/**
 * A project with a SUBSCRIPTION product carrying one currency grant, a
 * subscriber, and an ACTIVE purchase for that product/subscriber pair —
 * i.e. exactly the rows createRevenueEvent's FK constraints require
 * (revenue_events.purchaseId/productId/subscriberId all reference these).
 */
async function seedRenewalFixture(
  grantOn: "RENEWAL" | "BOTH",
  amount: number,
): Promise<RenewalFixture> {
  const db = getDb();
  const s = nextSuffix();
  const projectId = `prj_rgr_${s}`;
  const productId = `prod_rgr_${s}`;
  const subscriberId = `sub_rgr_${s}`;

  await db.insert(projects).values({
    id: projectId,
    name: `Renewal Grant Test ${s}`,
  });

  const currency = await drizzle.virtualCurrencyRepo.createVirtualCurrency(
    db,
    { projectId, code: `GEMS_${s}`, name: `Gems ${s}` },
  );

  await db.insert(products).values({
    id: productId,
    projectId,
    identifier: `com.rovenue.test.rgr_${s}`,
    type: "SUBSCRIPTION",
    storeIds: {},
    displayName: `Renewal Grant Product ${s}`,
  });

  await drizzle.productCurrencyGrantRepo.setProductGrants(db, productId, [
    { currencyId: currency.id, amount, grantOn },
  ]);

  await db.insert(subscribers).values({
    id: subscriberId,
    projectId,
    rovenueId: `rovenue_rgr_${s}`,
    appUserId: `app_user_rgr_${s}`,
  });

  const [purchase] = await db
    .insert(purchases)
    .values({
      projectId,
      subscriberId,
      productId,
      store: "APP_STORE",
      storeTransactionId: `rgr_txn_${s}`,
      originalTransactionId: `rgr_txn_${s}`,
      status: "ACTIVE",
      isTrial: false,
      isIntroOffer: false,
      isSandbox: false,
      environment: "PRODUCTION",
      purchaseDate: new Date(),
      originalPurchaseDate: new Date(),
      expiresDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      priceAmount: "9.99",
      priceCurrency: "USD",
      autoRenewStatus: true,
    })
    .returning();
  if (!purchase) throw new Error("seed: no purchase row returned");

  return {
    projectId,
    subscriberId,
    productId,
    purchaseId: purchase.id,
    currencyId: currency.id,
  };
}

/** Reads the (single) outbox row co-written by createRevenueEvent for this
 *  revenue event id -- never the code under test's own claim/publish path. */
async function readRevenueOutboxRow(revenueEventId: string): Promise<OutboxEvent> {
  const rows = await getDb()
    .select()
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.aggregateType, "REVENUE_EVENT"),
        eq(outboxEvents.aggregateId, revenueEventId),
      ),
    );
  expect(rows).toHaveLength(1);
  const row = rows[0];
  if (!row) throw new Error("no outbox row found for revenue event");
  return row;
}

beforeEach(async () => {
  // CASCADE reaches purchases, revenue_events, outbox_events rows keyed
  // on these subscribers/products are NOT cascaded from subscribers, so
  // clear them explicitly too -- otherwise a leftover outbox row from a
  // previous run's project could be picked up by a loose aggregateId
  // match (it can't here, ids are unique per suffix, but the table still
  // needs to be habitable for readRevenueOutboxRow's toHaveLength(1)).
  await getDb().execute(sql`TRUNCATE TABLE "subscribers" CASCADE`);
  await getDb().execute(sql`TRUNCATE TABLE "outbox_events"`);
});

afterAll(async () => {
  await getDb().execute(sql`TRUNCATE TABLE "subscribers" CASCADE`);
  await getDb().execute(sql`TRUNCATE TABLE "outbox_events"`);
});

describe("renewal grant end to end", () => {
  test("a renewal revenue event grants the product's RENEWAL currency once", async () => {
    // 1. Seed: a project, a virtual currency, a SUBSCRIPTION product, and a
    //    product_currency_grants row with amount 500 and grantOn 'RENEWAL'.
    const fixture = await seedRenewalFixture("RENEWAL", 500);

    // 2. Write a RENEWAL revenue event through
    //    drizzle.revenueEventRepo.createRevenueEvent -- the real writer, so
    //    the outbox row is produced the way production produces it.
    const revenueEvent = await drizzle.revenueEventRepo.createRevenueEvent(
      getDb(),
      {
        projectId: fixture.projectId,
        subscriberId: fixture.subscriberId,
        purchaseId: fixture.purchaseId,
        productId: fixture.productId,
        type: "RENEWAL",
        amount: "9.99",
        currency: "USD",
        amountUsd: "9.99",
        store: "APP_STORE",
        eventDate: new Date(),
      },
    );
    if (!revenueEvent) throw new Error("createRevenueEvent returned null");

    // 3. Read the outbox row back and hand its Kafka envelope to
    //    toRenewalGrantJob + runRenewalGrant with LIVE deps (not mocks),
    //    which is the same path bootRenewalGrants wires up.
    const outboxRow = await readRevenueOutboxRow(revenueEvent.id);
    const parsed = toRenewalGrantJob(JSON.parse(toOutboxKafkaMessage(outboxRow).value));
    expect(parsed).not.toBeNull();
    if (!parsed) throw new Error("toRenewalGrantJob returned null");
    expect(parsed.job).toEqual({
      revenueEventId: revenueEvent.id,
      projectId: fixture.projectId,
      subscriberId: fixture.subscriberId,
      productId: fixture.productId,
      type: "RENEWAL",
    });

    const outcome1 = await runRenewalGrant(parsed.job, liveDeps);
    expect(outcome1).toBe("granted");

    // 4. Assert the subscriber's balance for that currency is 500.
    await expect(
      getBalance(fixture.subscriberId, fixture.currencyId),
    ).resolves.toBe(500);

    // 5. Run the same job a second time with the same revenueEventId.
    //    Assert the balance is STILL 500 -- this is the redelivery case,
    //    and addCredits' reference dedup is what must catch it.
    const outcome2 = await runRenewalGrant(parsed.job, liveDeps);
    expect(outcome2).toBe("granted");
    await expect(
      getBalance(fixture.subscriberId, fixture.currencyId),
    ).resolves.toBe(500);
  });

  test("an INITIAL revenue event grants nothing on the renewal path", async () => {
    // Same seed, but grantOn is BOTH rather than RENEWAL -- otherwise the
    // assertion would be vacuous (a RENEWAL-only row can't fire on
    // PURCHASE/INITIAL regardless of this consumer). BOTH is the row that
    // is actually at risk of a double grant: it is meant to pay once on
    // day one via the synchronous PURCHASE-trigger path in
    // webhook-processor.ts/receipts.ts (not exercised here), and this
    // renewal path must not ALSO pay it for the same INITIAL event.
    const fixture = await seedRenewalFixture("BOTH", 500);

    const revenueEvent = await drizzle.revenueEventRepo.createRevenueEvent(
      getDb(),
      {
        projectId: fixture.projectId,
        subscriberId: fixture.subscriberId,
        purchaseId: fixture.purchaseId,
        productId: fixture.productId,
        type: "INITIAL",
        amount: "9.99",
        currency: "USD",
        amountUsd: "9.99",
        store: "APP_STORE",
        eventDate: new Date(),
      },
    );
    if (!revenueEvent) throw new Error("createRevenueEvent returned null");

    const outboxRow = await readRevenueOutboxRow(revenueEvent.id);
    const parsed = toRenewalGrantJob(JSON.parse(toOutboxKafkaMessage(outboxRow).value));

    // RENEWAL_GRANT_EVENT_TYPES deliberately excludes INITIAL -- it is the
    // PURCHASE trigger's event, and matching both here would double-grant
    // a BOTH row on day one. The consumer must drop it before it ever
    // becomes a job.
    expect(parsed).toBeNull();

    await expect(
      getBalance(fixture.subscriberId, fixture.currencyId),
    ).resolves.toBe(0);
  });
});
