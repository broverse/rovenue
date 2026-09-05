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
import { verifyAuditChain } from "../lib/audit";
import { hasAccess, syncAccess } from "../services/access-engine";

const RUN_ID = Date.now();

/** Purchases are seeded well clear of `now` in both directions so no
 *  assertion can turn on the sweep's own clock. */
const FUTURE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

/** How far in the past a lapsed purchase's `expiresDate` sits. */
const PAST_EXPIRY_MS = 24 * 60 * 60 * 1000;

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
async function seedActiveSubscriberWithAccess(opts?: {
  status?: "ACTIVE" | "GRACE_PERIOD";
  /** Past-dated, as a GRACE_PERIOD purchase's `expiresDate` always is. */
  expiredAlready?: boolean;
  /** Skip the hand-built access row (for cases that call syncAccess). */
  withoutAccessRow?: boolean;
  deleted?: boolean;
}): Promise<SeededSubscriber> {
  const db = getDb();
  const s = nextSuffix();
  const projectId = `prj_arc_${s}`;
  const accessId = `acc_arc_${s}`;
  const productId = `prod_arc_${s}`;
  const subscriberId = `sub_arc_${s}`;
  const expiresDate = opts?.expiredAlready
    ? new Date(Date.now() - PAST_EXPIRY_MS)
    : new Date(Date.now() + FUTURE_EXPIRY_MS);

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
    // GDPR/KVKK erasure stamps this and RETAINS the purchases.
    deletedAt: opts?.deleted ? new Date() : null,
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
      status: opts?.status ?? "ACTIVE",
      isTrial: false,
      isIntroOffer: false,
      isSandbox: false,
      environment: "PRODUCTION",
      purchaseDate: new Date(),
      originalPurchaseDate: new Date(),
      expiresDate,
      // Grace runs from the (past) expiry to here.
      gracePeriodExpires: opts?.expiredAlready
        ? new Date(Date.now() + FUTURE_EXPIRY_MS)
        : null,
      priceAmount: "9.99",
      priceCurrency: "USD",
      autoRenewStatus: true,
    })
    .returning();
  if (!purchase) throw new Error("seed: no purchase row returned");

  // Hand-built, not syncAccess-built: the baseline must be independent
  // of the thing being verified.
  if (!opts?.withoutAccessRow) {
    await db.insert(subscriberAccess).values({
      subscriberId,
      purchaseId: purchase.id,
      accessId,
      isActive: true,
      expiresDate,
      store: "APP_STORE",
    });
  }

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

    // The row must also VERIFY. Asserting it EXISTS would not catch a
    // writer and a checker that disagree about how a field is encoded —
    // only re-verifying the chain does. `audit_logs` is DB-enforced
    // append-only, so a row that hashes one way and verifies another can
    // never be repaired, which is why this assertion is here and not a
    // cheaper existence check.
    const chain = await verifyAuditChain(projectId);
    expect(chain.errors).toEqual([]);
    expect(chain.rowCount).toBe(1);
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

  it("excludes erased subscribers from the worklist", async () => {
    // GDPR/KVKK erasure stamps `deletedAt` and retains the purchases, so
    // without the filter an erased subscriber stays a candidate forever:
    // entitlement rows rewritten and a fresh audit row naming their
    // subscriberId written every time they go stale, indefinitely.
    const erased = await seedActiveSubscriberWithAccess({ deleted: true });
    await getDb().execute(
      sql`DELETE FROM "subscriber_access" WHERE "subscriberId" = ${erased.subscriberId}`,
    );

    const result = await runAccessReconciliationSweep(new Date());

    expect(result.candidates).toBe(0);
    expect(result.drifted).toBe(0);
    await expect(activeAccessIds(erased.subscriberId)).resolves.toEqual([]);
    await expect(
      auditRowsFor(erased.projectId, "access.drift_repaired"),
    ).resolves.toHaveLength(0);
    // Never even stamped — the row is not in the worklist at all.
    await expect(lastReconciledAt(erased.subscriberId)).resolves.toBeNull();
  });

  it("still sweeps a merged-away subscriber", async () => {
    // The counterpart to the case above, and the reason `mergedInto` is
    // deliberately NOT filtered: a merged-away subscriber's stranded
    // access rows ARE the orphan/stale classes, and clearing them is the
    // desired repair rather than something to skip.
    const merged = await seedActiveSubscriberWithAccess();
    const survivor = await seedActiveSubscriberWithAccess();
    await getDb().execute(
      sql`UPDATE "subscribers" SET "mergedInto" = ${survivor.subscriberId} WHERE "id" = ${merged.subscriberId}`,
    );

    const result = await runAccessReconciliationSweep(new Date());

    expect(result.candidates).toBe(2);
  });

  it("staleAfterMs lets an operator re-sweep a slice the breaker stamped", async () => {
    const seeded = await seedActiveSubscriberWithAccess();

    // First sweep stamps it, so the default window excludes it.
    await runAccessReconciliationSweep(new Date());
    const blocked = await runAccessReconciliationSweep(new Date());
    expect(blocked.candidates).toBe(0);

    // Now inject drift the way an incident would have left it, and
    // re-sweep with the override rather than hand-written SQL against
    // `subscribers`.
    await getDb().execute(
      sql`DELETE FROM "subscriber_access" WHERE "subscriberId" = ${seeded.subscriberId}`,
    );
    const recovery = await runAccessReconciliationSweep(new Date(), {
      staleAfterMs: 0,
    });

    expect(recovery.candidates).toBe(1);
    expect(recovery.drift.missing_grant).toBe(1);
    expect(recovery.healed).toBe(1);
    await expect(activeAccessIds(seeded.subscriberId)).resolves.toEqual([
      seeded.accessId,
    ]);
  });

  it("writes exactly one audit row across a heal and a clean re-sweep", async () => {
    // HONEST SCOPE: this does NOT exercise the no-op guard's positive
    // branch. That branch fires only when detection races a concurrent
    // write so that `syncAccess` finds nothing left to do, which cannot
    // be produced deterministically here without mocking the very code
    // under test. What this pins is the accounting either side of it —
    // a real heal counts once with `noops: 0`, and a re-sweep of the
    // now-correct subscriber adds no second audit row to an append-only
    // table. The guard itself is covered by review, not by this test.
    const seeded = await seedActiveSubscriberWithAccess();
    await getDb().execute(
      sql`DELETE FROM "subscriber_access" WHERE "subscriberId" = ${seeded.subscriberId}`,
    );

    const first = await runAccessReconciliationSweep(new Date());
    expect(first.healed).toBe(1);
    expect(first.noops).toBe(0);

    // Re-sweep the same, now-correct subscriber: nothing is detected, so
    // nothing is healed and exactly one audit row exists in total.
    const second = await runAccessReconciliationSweep(new Date(), {
      staleAfterMs: 0,
    });
    expect(second.drifted).toBe(0);
    expect(second.healed).toBe(0);
    await expect(
      auditRowsFor(seeded.projectId, "access.drift_repaired"),
    ).resolves.toHaveLength(1);
  });

  // -------------------------------------------------------------
  // GRACE_PERIOD — the empirical question (review Important 4)
  // -------------------------------------------------------------
  //
  // `subscription-status.ts` declares GRACE_PERIOD access-granting. Until
  // Task 12b `computeDesiredAccess` skipped any purchase whose
  // `expiresDate < now` — definitionally every grace-period purchase,
  // since a subscription only enters grace once its paid period lapsed —
  // so that declaration granted nothing and the whole GRACE_PERIOD vs
  // BILLING_ISSUE distinction was empty in entitlement terms. A grace
  // purchase's entitlement now runs to `gracePeriodExpires`.
  //
  // The stored rows here are whatever the WRITER produces: seeded
  // without an access row, then `syncAccess` is called. Whatever it
  // decides is by definition not drift, because the checker calls the
  // same function.
  it("reports no drift for a grace-period subscriber the writer produced", async () => {
    const grace = await seedActiveSubscriberWithAccess({
      status: "GRACE_PERIOD",
      expiredAlready: true,
      withoutAccessRow: true,
    });
    await syncAccess(grace.subscriberId);

    const storedByWriter = await activeAccessIds(grace.subscriberId);
    const result = await runAccessReconciliationSweep(new Date());

    expect(result.candidates).toBe(1);
    expect(result.drifted).toBe(0);
    expect(result.drift.stale_grant).toBe(0);
    expect(result.drift.missing_grant).toBe(0);
    // CHANGED BY TASK 12b — this asserted `[]` before, which is exactly
    // the contradiction the task fixed: the writer granted a grace
    // subscriber nothing at all. It now grants the access, and the
    // checker agrees with it (drifted: 0), because both call
    // `computeDesiredAccess`.
    expect(storedByWriter).toEqual([grace.accessId]);
    // Asserted through the READ path, not just the table: a row whose
    // stored expiry were the purchase's lapsed `expiresDate` would be
    // filtered out by `findActiveAccess` and grant nothing.
    await expect(hasAccess(grace.subscriberId, grace.accessId)).resolves.toBe(
      true,
    );
  });

  // The shape ABOVE is not how a grace-period subscriber actually reaches
  // the database. `apple-webhook.ts`'s `applyFailedRenewal` writes only
  // the purchase's status + `gracePeriodExpires`; it calls neither
  // `grantAccess` nor `revokeAccessForTransaction`, so the access row
  // from the prior ACTIVE period survives untouched — still `isActive`,
  // still carrying the lapsed period's expiry. THAT is the production
  // shape: seeded already-lapsed (purchase AND access row carry the same
  // past expiry, as they do the moment a renewal fails), then only the
  // status is flipped, which is all the webhook writes.
  it("heals a real Apple grace-period subscriber into live access", async () => {
    const grace = await seedActiveSubscriberWithAccess({
      expiredAlready: true,
    });
    // Exactly what applyFailedRenewal writes: the status. The seed
    // already carries the lapsed `expiresDate` and the future
    // `gracePeriodExpires`, and `subscriber_access` is left untouched.
    await getDb().execute(
      sql`UPDATE "purchases" SET "status" = 'GRACE_PERIOD' WHERE "id" = ${grace.purchaseId}`,
    );

    // Nothing serves this subscriber before the sweep: the surviving row
    // is active but its expiry is in the past.
    await expect(hasAccess(grace.subscriberId, grace.accessId)).resolves.toBe(
      false,
    );

    const dry = await runAccessReconciliationSweep(new Date(), {
      dryRun: true,
    });

    // CHANGED BY TASK 12b. This case asserted `stale_grant: 1` before:
    // the grace purchase produced no desired entry at all, so the
    // surviving row had no counterpart and the sweep's "repair" was to
    // REVOKE it. The purchase now grants until `gracePeriodExpires`, so
    // the row has a counterpart and the only disagreement left is its
    // expiry — the lapsed period's end rather than the grace window's.
    //
    // Note this is `wrong_expiry`, not "no drift": the stored row was
    // written before the grace window existed and genuinely must be
    // rewritten for the read path (`expiresDate > now`) to serve it. The
    // heal below EXTENDS the entitlement; nothing is taken away.
    expect(dry.drift.stale_grant).toBe(0);
    expect(dry.drift.wrong_expiry).toBe(1);
    expect(dry.drifted).toBe(1);

    const healed = await runAccessReconciliationSweep(new Date(), {
      staleAfterMs: 0,
    });
    expect(healed.healed).toBe(1);

    // The observable proof: a subscriber who could not read their
    // entitlement now can, through the same read path the SDK uses.
    await expect(hasAccess(grace.subscriberId, grace.accessId)).resolves.toBe(
      true,
    );
    const [row] = await getDb()
      .select({ expiresDate: subscriberAccess.expiresDate })
      .from(subscriberAccess)
      .where(eq(subscriberAccess.subscriberId, grace.subscriberId));
    expect(row?.expiresDate?.getTime()).toBeGreaterThan(Date.now());
  });

  // The other half of the rule: a grace window that has itself elapsed
  // grants nothing, so the row is revoked rather than extended. Without
  // this, "grace grants access" would have no upper bound in the tests.
  it("revokes a grace-period subscriber whose grace window has elapsed", async () => {
    const grace = await seedActiveSubscriberWithAccess({
      expiredAlready: true,
    });
    await getDb().execute(
      sql`UPDATE "purchases"
          SET "status" = 'GRACE_PERIOD',
              "gracePeriodExpires" = now() - interval '1 hour'
          WHERE "id" = ${grace.purchaseId}`,
    );

    const result = await runAccessReconciliationSweep(new Date());

    expect(result.drift.stale_grant).toBe(1);
    expect(result.healed).toBe(1);
    await expect(activeAccessIds(grace.subscriberId)).resolves.toEqual([]);
    await expect(hasAccess(grace.subscriberId, grace.accessId)).resolves.toBe(
      false,
    );
  });
});
