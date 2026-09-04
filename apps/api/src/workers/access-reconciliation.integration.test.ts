// =============================================================
// runAccessReconciliationSweep — real Postgres integration test
// =============================================================
//
// Drift is injected with DIRECT SQL — never by calling the code under
// test — so a passing run means the reconciler found real corruption
// rather than agreeing with itself. The healthy baseline is likewise
// built by hand (`seedActiveSubscriberWithAccess` inserts the
// subscriber_access row itself instead of calling syncAccess), which is
// what makes the "clean subscriber reports no drift" case an assertion
// about the checker rather than a tautology.
//
// Each case starts from a clean subscriber set. The sweep selects
// candidates GLOBALLY — drift is a property of the write path, not of a
// project — so subscribers left behind by an earlier case (and the demo
// rows the test template is seeded with) join later batches and move the
// circuit breaker's ratio. Distinct project ids do not help; only
// truncation does.
//
// The breaker only applies at or above MIN_BATCH_FOR_CIRCUIT_BREAKER
// candidates, which is why the single-subscriber cases below can assert
// a heal at all.
//
// Follows the inline-seed convention of the other worker integration
// tests (google-reconciliation, expiry-checker): no withTestDb/seedProject
// helper exists in this codebase, so this uses getDb() directly.

import { beforeEach, describe, expect, it } from "vitest";
import { and, asc, eq, sql } from "drizzle-orm";
import {
  access,
  auditLogs,
  getDb,
  products,
  projects,
  purchases,
  subscriberAccess,
  subscribers,
} from "@rovenue/db";
import {
  MIN_BATCH_FOR_CIRCUIT_BREAKER,
  runAccessReconciliationSweep,
} from "./access-reconciliation";

const RUN_ID = Date.now();

/** Purchases are seeded well clear of `now` in both directions so no
 *  assertion can turn on the sweep's own clock. */
const FUTURE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

/** The bogus expiry `wrong_expiry` is injected with — far enough from
 *  the purchase's real expiry that no rounding could reconcile them. */
const CORRUPT_EXPIRY = "2030-01-01T00:00:00.000Z";

let seq = 0;
function nextSuffix(): string {
  seq += 1;
  return `${RUN_ID}_${seq}`;
}

interface SeededSubscriber {
  projectId: string;
  subscriberId: string;
  productId: string;
  purchaseId: string;
  accessId: string;
  expiresDate: Date;
}

/**
 * A subscriber with one ACTIVE, unexpired purchase and the exactly
 * correct `subscriber_access` row for it — i.e. a subscriber the
 * reconciler must report as clean until a test corrupts them.
 */
async function seedActiveSubscriberWithAccess(): Promise<SeededSubscriber> {
  const db = getDb();
  const s = nextSuffix();
  const projectId = `prj_arc_${s}`;
  const accessId = `acc_arc_${s}`;
  const productId = `prod_arc_${s}`;
  const subscriberId = `sub_arc_${s}`;
  const expiresDate = new Date(Date.now() + FUTURE_EXPIRY_MS);

  await db.insert(projects).values({
    id: projectId,
    name: `Access Reconciliation Test ${s}`,
  });
  await db.insert(access).values({
    id: accessId,
    projectId,
    identifier: `pro_arc_${s}`,
    displayName: `Pro ${s}`,
  });
  await db.insert(products).values({
    id: productId,
    projectId,
    identifier: `com.rovenue.test.arc_${s}`,
    type: "SUBSCRIPTION",
    storeIds: {},
    displayName: `Access Reconciliation Product ${s}`,
    accessIds: [accessId],
  });
  await db.insert(subscribers).values({
    id: subscriberId,
    projectId,
    rovenueId: `rovenue_arc_${s}`,
    appUserId: `app_user_arc_${s}`,
  });
  const [purchase] = await db
    .insert(purchases)
    .values({
      projectId,
      subscriberId,
      productId,
      store: "APP_STORE",
      storeTransactionId: `arc_txn_${s}`,
      originalTransactionId: `arc_txn_${s}`,
      status: "ACTIVE",
      isTrial: false,
      isIntroOffer: false,
      isSandbox: false,
      environment: "PRODUCTION",
      purchaseDate: new Date(),
      originalPurchaseDate: new Date(),
      expiresDate,
      priceAmount: "9.99",
      priceCurrency: "USD",
      autoRenewStatus: true,
    })
    .returning();
  if (!purchase) throw new Error("seed: no purchase row returned");

  // Hand-built, not syncAccess-built: the baseline must be independent
  // of the thing being verified.
  await db.insert(subscriberAccess).values({
    subscriberId,
    purchaseId: purchase.id,
    accessId,
    isActive: true,
    expiresDate,
    store: "APP_STORE",
  });

  return {
    projectId,
    subscriberId,
    productId,
    purchaseId: purchase.id,
    accessId,
    expiresDate,
  };
}

async function activeAccessIds(subscriberId: string): Promise<string[]> {
  const rows = await getDb()
    .select({ accessId: subscriberAccess.accessId })
    .from(subscriberAccess)
    .where(
      and(
        eq(subscriberAccess.subscriberId, subscriberId),
        eq(subscriberAccess.isActive, true),
      ),
    )
    .orderBy(asc(subscriberAccess.accessId));
  return rows.map((r) => r.accessId);
}

async function accessRowCount(subscriberId: string): Promise<number> {
  const rows = await getDb()
    .select({ id: subscriberAccess.id })
    .from(subscriberAccess)
    .where(eq(subscriberAccess.subscriberId, subscriberId));
  return rows.length;
}

async function auditRowsFor(
  projectId: string,
  action: string,
): Promise<Array<{ resourceId: string; after: unknown }>> {
  const rows = await getDb()
    .select({ resourceId: auditLogs.resourceId, after: auditLogs.after })
    .from(auditLogs)
    .where(
      and(eq(auditLogs.projectId, projectId), eq(auditLogs.action, action)),
    );
  return rows;
}

async function lastReconciledAt(subscriberId: string): Promise<Date | null> {
  const rows = await getDb()
    .select({ at: subscribers.lastAccessReconciledAt })
    .from(subscribers)
    .where(eq(subscribers.id, subscriberId));
  return rows[0]?.at ?? null;
}

beforeEach(async () => {
  // CASCADE reaches purchases and subscriber_access (and anything else
  // keyed on a subscriber). The template database is seeded with demo
  // subscribers, so this is not merely inter-case hygiene — without it
  // the very first case runs against a batch it did not create.
  await getDb().execute(sql`TRUNCATE TABLE "subscribers" CASCADE`);
});

describe("runAccessReconciliationSweep", () => {
  it("reports no drift for a correctly-granted subscriber", async () => {
    const { subscriberId, accessId } = await seedActiveSubscriberWithAccess();

    const result = await runAccessReconciliationSweep(new Date());

    expect(result.candidates).toBe(1);
    expect(result.drifted).toBe(0);
    expect(result.healed).toBe(0);
    expect(result.errors).toBe(0);
    // Still granted, and stamped as checked.
    await expect(activeAccessIds(subscriberId)).resolves.toEqual([accessId]);
    await expect(lastReconciledAt(subscriberId)).resolves.toBeInstanceOf(Date);
  });

  it("classifies and heals a missing grant", async () => {
    const { subscriberId, accessId } = await seedActiveSubscriberWithAccess();
    await getDb().execute(
      sql`DELETE FROM "subscriber_access" WHERE "subscriberId" = ${subscriberId}`,
    );

    const result = await runAccessReconciliationSweep(new Date());

    expect(result.drift.missing_grant).toBe(1);
    expect(result.drifted).toBe(1);
    expect(result.healed).toBe(1);
    expect(result.circuitBroken).toBe(false);
    await expect(activeAccessIds(subscriberId)).resolves.toEqual([accessId]);
  });

  it("classifies and heals a stale grant", async () => {
    const { subscriberId, purchaseId } = await seedActiveSubscriberWithAccess();
    // The purchase itself moved on; the access row was never revoked.
    await getDb().execute(
      sql`UPDATE "purchases" SET "status" = 'EXPIRED' WHERE "id" = ${purchaseId}`,
    );

    const result = await runAccessReconciliationSweep(new Date());

    expect(result.drift.stale_grant).toBe(1);
    expect(result.drift.missing_grant).toBe(0);
    expect(result.healed).toBe(1);
    await expect(activeAccessIds(subscriberId)).resolves.toEqual([]);
  });

  it("classifies and heals a wrong expiry", async () => {
    const { subscriberId, accessId, expiresDate } =
      await seedActiveSubscriberWithAccess();
    await getDb().execute(
      sql`UPDATE "subscriber_access" SET "expiresDate" = ${CORRUPT_EXPIRY} WHERE "subscriberId" = ${subscriberId}`,
    );

    const result = await runAccessReconciliationSweep(new Date());

    expect(result.drift.wrong_expiry).toBe(1);
    // The grant itself was never in doubt — only its window.
    expect(result.drift.missing_grant).toBe(0);
    expect(result.drift.stale_grant).toBe(0);
    expect(result.healed).toBe(1);
    await expect(activeAccessIds(subscriberId)).resolves.toEqual([accessId]);

    const [row] = await getDb()
      .select({ expiresDate: subscriberAccess.expiresDate })
      .from(subscriberAccess)
      .where(eq(subscriberAccess.subscriberId, subscriberId));
    expect(row?.expiresDate?.getTime()).toBe(expiresDate.getTime());
  });

  it("classifies an orphan row whose purchase left the subscriber", async () => {
    const a = await seedActiveSubscriberWithAccess();
    const b = await seedActiveSubscriberWithAccess();
    // A transfer/merge that moved the purchase and left the access row
    // behind: A's access row now points at a purchase A does not own.
    await getDb().execute(
      sql`UPDATE "subscriber_access" SET "purchaseId" = ${b.purchaseId} WHERE "subscriberId" = ${a.subscriberId}`,
    );

    const result = await runAccessReconciliationSweep(new Date());

    expect(result.drift.orphan_row).toBe(1);
    expect(result.drift.stale_grant).toBe(0);
    // A's own purchase still entitles them, from a row that is missing.
    expect(result.drift.missing_grant).toBe(1);
    // B was untouched and must not be reported.
    expect(result.drifted).toBe(1);
    await expect(activeAccessIds(a.subscriberId)).resolves.toEqual([
      a.accessId,
    ]);
    await expect(activeAccessIds(b.subscriberId)).resolves.toEqual([
      b.accessId,
    ]);
  });

  it("writes an audit row for every heal", async () => {
    const { subscriberId, projectId } = await seedActiveSubscriberWithAccess();
    await getDb().execute(
      sql`DELETE FROM "subscriber_access" WHERE "subscriberId" = ${subscriberId}`,
    );

    await runAccessReconciliationSweep(new Date());

    const rows = await auditRowsFor(projectId, "access.drift_repaired");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.resourceId).toBe(subscriberId);
    const after = rows[0]?.after as {
      classes?: string[];
      source?: string;
      backfill?: boolean;
    };
    expect(after.classes).toEqual(["missing_grant"]);
    expect(after.source).toBe("access:reconciliation-sweep");
    expect(after.backfill).toBe(false);
  });

  it("records backfill mode on the audit row", async () => {
    const { subscriberId, projectId } = await seedActiveSubscriberWithAccess();
    await getDb().execute(
      sql`DELETE FROM "subscriber_access" WHERE "subscriberId" = ${subscriberId}`,
    );

    await runAccessReconciliationSweep(new Date(), { backfill: true });

    const rows = await auditRowsFor(projectId, "access.drift_repaired");
    expect(rows).toHaveLength(1);
    expect((rows[0]?.after as { backfill?: boolean }).backfill).toBe(true);
  });

  it("dryRun reports drift and writes nothing", async () => {
    const { subscriberId } = await seedActiveSubscriberWithAccess();
    await getDb().execute(
      sql`DELETE FROM "subscriber_access" WHERE "subscriberId" = ${subscriberId}`,
    );

    const result = await runAccessReconciliationSweep(new Date(), {
      dryRun: true,
    });

    expect(result.drift.missing_grant).toBe(1);
    expect(result.healed).toBe(0);
    await expect(activeAccessIds(subscriberId)).resolves.toEqual([]);
    // Not even the "I checked you" stamp — a dry run leaves the worklist
    // exactly as it found it, so the next real sweep still sees the row.
    await expect(lastReconciledAt(subscriberId)).resolves.toBeNull();
  });

  // -------------------------------------------------------------
  // The circuit breaker
  // -------------------------------------------------------------
  //
  // This is the whole safety story for auto-heal: if computeDesiredAccess
  // were ever wrong, this is what stops the worker from faithfully
  // revoking (or granting) everyone's entitlements at machine speed.
  //
  // It asserts on the DATA, not on the flag: every seeded subscriber is
  // corrupted, so a sweep with the breaker removed would heal all of
  // them and every `activeAccessIds` below would come back non-empty.
  it("refuses to heal when drift exceeds MAX_DRIFT_HEAL_RATIO", async () => {
    const seeded: SeededSubscriber[] = [];
    for (let i = 0; i < MIN_BATCH_FOR_CIRCUIT_BREAKER; i += 1) {
      seeded.push(await seedActiveSubscriberWithAccess());
    }
    await getDb().execute(sql`DELETE FROM "subscriber_access"`);

    const result = await runAccessReconciliationSweep(new Date());

    expect(result.candidates).toBe(MIN_BATCH_FOR_CIRCUIT_BREAKER);
    expect(result.drifted).toBe(MIN_BATCH_FOR_CIRCUIT_BREAKER);
    expect(result.circuitBroken).toBe(true);
    expect(result.healed).toBe(0);
    for (const s of seeded) {
      await expect(activeAccessIds(s.subscriberId)).resolves.toEqual([]);
      // Not "revoked" — untouched. The sweep inserted nothing at all.
      await expect(accessRowCount(s.subscriberId)).resolves.toBe(0);
      const rows = await auditRowsFor(s.projectId, "access.drift_repaired");
      expect(rows).toHaveLength(0);
    }
  });

  // The mirror image, and the reason MAX_DRIFT_HEAL_RATIO is a ratio
  // rather than a switch: a batch just as large, with drift at the
  // threshold rather than above it, still heals.
  it("heals a large batch whose drift is at the threshold", async () => {
    const seeded: SeededSubscriber[] = [];
    for (let i = 0; i < MIN_BATCH_FOR_CIRCUIT_BREAKER; i += 1) {
      seeded.push(await seedActiveSubscriberWithAccess());
    }
    const victim = seeded[0];
    if (!victim) throw new Error("seed: empty batch");
    await getDb().execute(
      sql`DELETE FROM "subscriber_access" WHERE "subscriberId" = ${victim.subscriberId}`,
    );

    const result = await runAccessReconciliationSweep(new Date());

    // 1/20 = 0.05, which is not GREATER than MAX_DRIFT_HEAL_RATIO.
    expect(result.candidates).toBe(MIN_BATCH_FOR_CIRCUIT_BREAKER);
    expect(result.drifted).toBe(1);
    expect(result.circuitBroken).toBe(false);
    expect(result.healed).toBe(1);
    await expect(activeAccessIds(victim.subscriberId)).resolves.toEqual([
      victim.accessId,
    ]);
  });

  it("stamps checked subscribers so a second sweep finds nothing", async () => {
    await seedActiveSubscriberWithAccess();

    const first = await runAccessReconciliationSweep(new Date());
    expect(first.candidates).toBe(1);

    // ACCESS_RECONCILE_STALE_AFTER_MS has not elapsed, so the stamped
    // row is out of the worklist entirely.
    const second = await runAccessReconciliationSweep(new Date());
    expect(second.candidates).toBe(0);
    expect(second.drifted).toBe(0);
  });
});
