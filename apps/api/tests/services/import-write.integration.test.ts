import { Readable } from "node:stream";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { parseCsvStream, type CanonicalField } from "@rovenue/shared";
import { db } from "../../../../packages/db/src/drizzle/client";
import {
  access,
  auditLogs,
  outboxEvents,
  outgoingWebhooks,
  products,
  projects,
  purchases,
  revenueEventDedupe,
  revenueEvents,
  subscriberAccess,
  subscribers,
} from "../../../../packages/db/src/drizzle/schema";
import * as importJobRepo from "../../../../packages/db/src/drizzle/repositories/import-jobs";
import { buildCanonicalRow } from "../../src/services/import/plan";
import {
  writeImportBatch,
  type ImportWriteRow,
} from "../../src/services/import/write";

// =============================================================
// writeImportBatch — Phase A writer (Task 7)
//
// The two acceptance criteria of this branch live in this file, and both
// observe DATABASE STATE rather than the function's return value:
//
//   1. Idempotency — the same file written twice leaves the same number
//      of subscribers, the same number of purchases and the same summed
//      revenue. A writer that returned `{ skipped: 3 }` while silently
//      inserting three more purchases would pass a return-value check
//      and fail this one.
//   2. No side effects — after an import there are ZERO
//      `SUBSCRIPTION`-aggregate outbox rows and ZERO enqueued outgoing
//      webhooks. This test exists to fail the day someone routes the
//      writer through `runPostProcessing` (services/webhook-processor.ts),
//      which emits both: a customer migrating two years of history would
//      otherwise blast two years of backdated purchase events at their
//      own integrations and webhooks.
//
// Runs against the real per-worker Postgres that `tests/global-setup.ts`
// provisions (the repo's convention for repository-adjacent service
// tests — see services/import-plan.test.ts). Nothing is mocked: the
// writer never touches object storage, so there is no import-store stub
// here at all.
// =============================================================

const PROJECT_ID = `proj_import_write_${createId()}`;
const ACCESS_ID = `acc_import_write_${createId()}`;
const ACCESS_IDENTIFIER = "pro";
const PRODUCT_ID = `prod_import_write_${createId()}`;
const PRODUCT_IDENTIFIER = "pro_monthly";
const APPLE_STORE_PRODUCT_ID = "com.example.pro.monthly";

/** Every fixture date sits inside the `revenue_events` partition range
 *  (2024-01 .. 2028-12, migration 0015) — a range-partitioned table has
 *  no DEFAULT partition, so a date outside it is an insert error, not a
 *  silently misfiled row. */
const PURCHASE_DATE = "2026-01-15 10:00:00";
const SECOND_PURCHASE_DATE = "2026-02-15 10:00:00";
/** Far enough out that every fixture purchase is live (ACTIVE), which is
 *  what makes `syncAccess` observable. */
const FUTURE_EXPIRY = "2028-12-01 00:00:00";

const SOURCE_COLUMNS = [
  "subscriber_id",
  "store",
  "product_id",
  "store_txn_id",
  "purchase_date",
  "expires_date",
  "price_in_usd",
  "renewal_number",
  "is_sandbox",
  "refunded_at",
] as const;

const CANONICAL_MAPPING: Record<string, CanonicalField> = {
  subscriber_id: "subscriberExternalId",
  store: "store",
  product_id: "productIdentifier",
  store_txn_id: "storeTransactionId",
  purchase_date: "purchaseDate",
  expires_date: "expiresDate",
  price_in_usd: "priceUsd",
  renewal_number: "renewalNumber",
  is_sandbox: "isSandbox",
  refunded_at: "refundedAt",
};

const CSV_HEADER = SOURCE_COLUMNS.join(",");

type SourceRow = {
  subscriberId: string;
  store?: string;
  productId?: string;
  storeTxnId?: string;
  purchaseDate?: string;
  expiresDate?: string;
  priceUsd?: string;
  renewalNumber?: string;
  isSandbox?: string;
  refundedAt?: string;
};

function csvOf(rows: SourceRow[]): string {
  const lines = rows.map((r) =>
    [
      r.subscriberId,
      r.store ?? "app_store",
      r.productId ?? PRODUCT_IDENTIFIER,
      r.storeTxnId ?? "",
      r.purchaseDate ?? PURCHASE_DATE,
      r.expiresDate ?? FUTURE_EXPIRY,
      r.priceUsd ?? "",
      r.renewalNumber ?? "",
      r.isSandbox ?? "false",
      r.refundedAt ?? "",
    ].join(","),
  );
  return `${CSV_HEADER}\n${lines.join("\n")}\n`;
}

/** Parses a CSV exactly the way the Task 8 worker will — the real
 *  streaming parser plus the job's confirmed mapping — so these tests
 *  exercise the writer through the same canonical rows production
 *  produces, not hand-built objects. */
async function parseFile(csv: string): Promise<ImportWriteRow[]> {
  const rows: ImportWriteRow[] = [];
  let header: string[] = [];
  for await (const event of parseCsvStream(
    Readable.from([Buffer.from(csv, "utf8")]),
  )) {
    if ("header" in event) {
      header = event.header;
      continue;
    }
    rows.push({
      lineNumber: event.lineNumber,
      row: buildCanonicalRow(header, event.row, CANONICAL_MAPPING),
    });
  }
  return rows;
}

async function seedJob(options?: {
  skipSandbox?: boolean;
  importAnchorless?: boolean;
}): Promise<string> {
  const jobId = `job_${createId()}`;
  await importJobRepo.createImportJob(db, {
    id: jobId,
    projectId: PROJECT_ID,
    sourceLabel: "writer test import",
    presetId: null,
    storageKey: `imports/${PROJECT_ID}/${jobId}/source.csv`,
    fileName: "source.csv",
    fileBytes: 0,
    fileSha256: "deadbeef",
    mapping: CANONICAL_MAPPING,
    options: options ?? {},
  });
  return jobId;
}

/** One "run of the file": parse it and hand every row to the writer as a
 *  single batch. Task 8 slices the same rows into checkpointed batches;
 *  the writer's contract is per-batch either way. */
async function runFile(jobId: string, csv: string) {
  return writeImportBatch(jobId, await parseFile(csv));
}

// -------------------------------------------------------------
// State observation helpers — these are what the assertions read
// -------------------------------------------------------------

async function countSubscribers(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(subscribers)
    .where(eq(subscribers.projectId, PROJECT_ID));
  return row?.n ?? 0;
}

async function countPurchases(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(purchases)
    .where(eq(purchases.projectId, PROJECT_ID));
  return row?.n ?? 0;
}

async function sumRevenueUsd(): Promise<string> {
  const [row] = await db
    .select({
      total: sql<string>`COALESCE(SUM("revenue_events"."amountUsd"), 0)::text`,
    })
    .from(revenueEvents)
    .where(eq(revenueEvents.projectId, PROJECT_ID));
  return row?.total ?? "0";
}

async function projectStateSnapshot() {
  return {
    subscribers: await countSubscribers(),
    purchases: await countPurchases(),
    revenueUsd: await sumRevenueUsd(),
  };
}

/** `outbox_events` has no projectId column, so a project-scoped filter is
 *  impossible for the SUBSCRIPTION aggregate — its aggregateId is a
 *  purchase/subscriber id. A GLOBAL count delta is the honest observation
 *  and is safe here: vitest runs the files inside one worker sequentially
 *  against that worker's own database. */
async function countSubscriptionOutboxRows(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(outboxEvents)
    .where(eq(outboxEvents.aggregateType, "SUBSCRIPTION"));
  return row?.n ?? 0;
}

/** REVENUE_EVENT outbox rows for THIS project — `createRevenueEvent`
 *  writes the projectId into the payload, so this one can be scoped. */
async function countRevenueOutboxRows(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(outboxEvents)
    .where(
      and(
        eq(outboxEvents.aggregateType, "REVENUE_EVENT"),
        sql`"outbox_events"."payload"->>'projectId' = ${PROJECT_ID}`,
      ),
    );
  return row?.n ?? 0;
}

async function countOutgoingWebhooks(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(outgoingWebhooks)
    .where(eq(outgoingWebhooks.projectId, PROJECT_ID));
  return row?.n ?? 0;
}

async function countAuditLogs(): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(auditLogs)
    .where(eq(auditLogs.projectId, PROJECT_ID));
  return row?.n ?? 0;
}

async function findPurchases() {
  return db
    .select()
    .from(purchases)
    .where(eq(purchases.projectId, PROJECT_ID));
}

beforeAll(async () => {
  await db
    .insert(projects)
    .values({ id: PROJECT_ID, name: "Import Writer Test Project" });
  await db.insert(access).values({
    id: ACCESS_ID,
    projectId: PROJECT_ID,
    identifier: ACCESS_IDENTIFIER,
    displayName: "Pro",
  });
  await db.insert(products).values({
    id: PRODUCT_ID,
    projectId: PROJECT_ID,
    identifier: PRODUCT_IDENTIFIER,
    type: "SUBSCRIPTION",
    storeIds: { apple: APPLE_STORE_PRODUCT_ID },
    accessIds: [ACCESS_ID],
    displayName: "Pro Monthly",
  });
});

beforeEach(async () => {
  // Deleting the subscribers cascades to purchases, subscriber_access and
  // revenue_events. The dedupe-claim table is keyed on projectId, not on
  // a subscriber, so it needs its own delete — leaving a stale claim
  // behind would make a later test's FIRST write look deduped.
  await db.delete(subscribers).where(eq(subscribers.projectId, PROJECT_ID));
  await db
    .delete(revenueEventDedupe)
    .where(eq(revenueEventDedupe.projectId, PROJECT_ID));
  await db
    .delete(outgoingWebhooks)
    .where(eq(outgoingWebhooks.projectId, PROJECT_ID));
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.id, PROJECT_ID));
});

// =============================================================
// Acceptance criterion 1 — idempotency
// =============================================================

describe("writeImportBatch — idempotency", () => {
  const SUB_A = "rc_sub_idem_a";
  const SUB_B = "rc_sub_idem_b";

  const FILE = csvOf([
    {
      subscriberId: SUB_A,
      storeTxnId: "apple_txn_idem_1",
      priceUsd: "9.99",
    },
    {
      subscriberId: SUB_B,
      storeTxnId: "apple_txn_idem_2",
      priceUsd: "19.99",
      purchaseDate: SECOND_PURCHASE_DATE,
    },
    {
      subscriberId: SUB_A,
      storeTxnId: "apple_txn_idem_3",
      priceUsd: "4.99",
      renewalNumber: "1",
      purchaseDate: SECOND_PURCHASE_DATE,
    },
  ]);

  it("leaves subscriber count, purchase count and summed revenue unchanged on a second run", async () => {
    const jobId = await seedJob();

    await runFile(jobId, FILE);
    const afterFirst = await projectStateSnapshot();

    expect(afterFirst.subscribers).toBe(2);
    expect(afterFirst.purchases).toBe(3);
    expect(Number(afterFirst.revenueUsd)).toBeCloseTo(34.97, 2);

    await runFile(jobId, FILE);
    const afterSecond = await projectStateSnapshot();

    expect(afterSecond).toEqual(afterFirst);
  });

  it("grants access through syncAccess and leaves Phase A rows unverified", async () => {
    const jobId = await seedJob();
    await runFile(jobId, FILE);

    const rows = await findPurchases();
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      // Phase A never contacts a store, so nothing here is verified.
      expect(row.verifiedAt).toBeNull();
    }

    const accessRows = await db
      .select()
      .from(subscriberAccess)
      .innerJoin(
        subscribers,
        eq(subscribers.id, subscriberAccess.subscriberId),
      )
      .where(eq(subscribers.projectId, PROJECT_ID));
    // One access row per subscriber: syncAccess collapses a subscriber's
    // purchases onto their single `pro` access id.
    expect(accessRows).toHaveLength(2);
  });

  it("never sets subscribers.platform — that is SDK first-install truth", async () => {
    const jobId = await seedJob();
    await runFile(jobId, FILE);

    const rows = await db
      .select()
      .from(subscribers)
      .where(eq(subscribers.projectId, PROJECT_ID));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(
        (row.attributes as Record<string, unknown>).platform,
      ).toBeUndefined();
    }
  });
});

// =============================================================
// Acceptance criterion 2 — no side effects
// =============================================================

describe("writeImportBatch — no side effects", () => {
  const FILE = csvOf([
    {
      subscriberId: "rc_sub_sidefx",
      storeTxnId: "apple_txn_sidefx_1",
      priceUsd: "9.99",
    },
  ]);

  it("writes no SUBSCRIPTION outbox row and enqueues no outgoing webhook", async () => {
    const jobId = await seedJob();

    const subscriptionOutboxBefore = await countSubscriptionOutboxRows();

    await runFile(jobId, FILE);

    // Both assertions fail the moment the writer is routed through
    // runPostProcessing, which emits a SUBSCRIPTION outbox row AND
    // enqueues an outgoing webhook for every processed purchase.
    expect(await countSubscriptionOutboxRows()).toBe(subscriptionOutboxBefore);
    expect(await countOutgoingWebhooks()).toBe(0);
  });

  it("writes no audit row per imported row", async () => {
    const jobId = await seedJob();
    const auditBefore = await countAuditLogs();

    await runFile(jobId, FILE);

    // The audit boundary is one entry per JOB (import.started at upload,
    // import.completed at the end of the run), never one per row.
    expect(await countAuditLogs()).toBe(auditBefore);
  });
});

// =============================================================
// Revenue does reach analytics
// =============================================================

describe("writeImportBatch — revenue events", () => {
  const FILE = csvOf([
    {
      subscriberId: "rc_sub_rev",
      storeTxnId: "apple_txn_rev_1",
      priceUsd: "9.99",
    },
    {
      subscriberId: "rc_sub_rev",
      storeTxnId: "apple_txn_rev_2",
      priceUsd: "9.99",
      renewalNumber: "1",
      purchaseDate: SECOND_PURCHASE_DATE,
    },
  ]);

  it("emits REVENUE_EVENT outbox rows on the first run and none on the second", async () => {
    const jobId = await seedJob();

    // `outbox_events` rows are not cascade-deleted with the subscribers
    // the beforeEach removes (the table has no project FK at all), so the
    // observation has to be a DELTA, not an absolute count.
    const outboxBefore = await countRevenueOutboxRows();

    await runFile(jobId, FILE);
    const afterFirst = await countRevenueOutboxRows();
    expect(afterFirst - outboxBefore).toBe(2);

    await runFile(jobId, FILE);
    expect(await countRevenueOutboxRows()).toBe(afterFirst);

    const events = await db
      .select()
      .from(revenueEvents)
      .where(eq(revenueEvents.projectId, PROJECT_ID));
    expect(events).toHaveLength(2);
    // The dedupe key derives ONLY from the source transaction — never
    // from the job id, which would double lifetime revenue on a retry.
    for (const event of events) {
      expect(event.dedupeKey).not.toContain(jobId);
      expect(event.dedupeKey?.startsWith("import:")).toBe(true);
    }
  });

  it("uses a dedupe key that survives a DIFFERENT job importing the same file", async () => {
    const firstJobId = await seedJob();
    await runFile(firstJobId, FILE);
    const afterFirst = await projectStateSnapshot();

    const secondJobId = await seedJob();
    await runFile(secondJobId, FILE);

    expect(await projectStateSnapshot()).toEqual(afterFirst);
  });
});

// =============================================================
// Merge chains
// =============================================================

describe("writeImportBatch — merge chains", () => {
  const MERGED_AWAY_ROVENUE_ID = "rc_sub_merged_away";
  const SURVIVOR_ROVENUE_ID = "rc_sub_survivor";

  it("writes onto the surviving row, not the row that was merged away", async () => {
    const survivorId = `sub_survivor_${createId()}`;
    const deadId = `sub_dead_${createId()}`;

    await db.insert(subscribers).values({
      id: survivorId,
      projectId: PROJECT_ID,
      rovenueId: SURVIVOR_ROVENUE_ID,
    });
    await db.insert(subscribers).values({
      id: deadId,
      projectId: PROJECT_ID,
      rovenueId: MERGED_AWAY_ROVENUE_ID,
      deletedAt: new Date(),
      mergedInto: survivorId,
    });

    const jobId = await seedJob();
    await runFile(
      jobId,
      csvOf([
        {
          subscriberId: MERGED_AWAY_ROVENUE_ID,
          storeTxnId: "apple_txn_merge_1",
          priceUsd: "9.99",
        },
      ]),
    );

    const rows = await findPurchases();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subscriberId).toBe(survivorId);

    // And no third subscriber was invented for the retired rovenueId.
    expect(await countSubscribers()).toBe(2);
  });

  it("follows the merge chain when the file names a retired row by its legacy appUserId", async () => {
    const survivorId = `sub_survivor_legacy_${createId()}`;
    const deadId = `sub_dead_legacy_${createId()}`;
    const legacyAppUserId = "rc_sub_legacy_app_user";

    await db.insert(subscribers).values({
      id: survivorId,
      projectId: PROJECT_ID,
      rovenueId: `${SURVIVOR_ROVENUE_ID}_legacy`,
    });
    await db.insert(subscribers).values({
      id: deadId,
      projectId: PROJECT_ID,
      rovenueId: `${MERGED_AWAY_ROVENUE_ID}_legacy`,
      // `findSubscriberByAppUserId` does NOT filter deletedAt, so this
      // retired row is exactly what the legacy fallback returns for the
      // identity the file names.
      appUserId: legacyAppUserId,
      deletedAt: new Date(),
      mergedInto: survivorId,
    });

    const jobId = await seedJob();
    await runFile(
      jobId,
      csvOf([
        {
          subscriberId: legacyAppUserId,
          storeTxnId: "apple_txn_merge_legacy_1",
          priceUsd: "9.99",
        },
      ]),
    );

    const rows = await findPurchases();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.subscriberId).toBe(survivorId);
  });

  it("refuses to write onto an erased identity that has no live survivor", async () => {
    const erasedRovenueId = "rc_sub_erased";
    await db.insert(subscribers).values({
      id: `sub_erased_${createId()}`,
      projectId: PROJECT_ID,
      rovenueId: erasedRovenueId,
      // GDPR erasure soft-deletes with the rovenueId intact and no
      // mergedInto target — there is no row this import may write to.
      deletedAt: new Date(),
    });

    const jobId = await seedJob();
    const outcome = await runFile(
      jobId,
      csvOf([
        {
          subscriberId: erasedRovenueId,
          storeTxnId: "apple_txn_erased_1",
          priceUsd: "9.99",
        },
      ]),
    );

    expect(outcome.outcomes.invalidRow).toBe(1);
    expect(await countPurchases()).toBe(0);
    expect(await countSubscribers()).toBe(1);
  });
});

// =============================================================
// Terminal states
// =============================================================

describe("writeImportBatch — terminal states", () => {
  const FILE = csvOf([
    {
      subscriberId: "rc_sub_terminal",
      storeTxnId: "apple_txn_terminal_1",
      priceUsd: "9.99",
    },
  ]);

  it("does not resurrect a REFUNDED purchase when an older file is re-imported", async () => {
    const jobId = await seedJob();
    await runFile(jobId, FILE);

    const [created] = await findPurchases();
    expect(created?.status).toBe("ACTIVE");

    // A refund arrived after the file was exported.
    await db
      .update(purchases)
      .set({ status: "REFUNDED", refundDate: new Date() })
      .where(eq(purchases.id, created!.id));

    await runFile(jobId, FILE);

    const [afterReimport] = await findPurchases();
    expect(afterReimport?.status).toBe("REFUNDED");
  });
});

// =============================================================
// Anchorless rows (RevenueCat `promotional`)
// =============================================================

describe("writeImportBatch — anchorless rows", () => {
  it("yields exactly one MANUAL purchase when a promotional row is imported twice", async () => {
    const jobId = await seedJob();
    const file = csvOf([
      {
        subscriberId: "rc_sub_promo",
        store: "promotional",
        storeTxnId: "",
        priceUsd: "0",
      },
    ]);

    await runFile(jobId, file);
    await runFile(jobId, file);

    const rows = await findPurchases();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.store).toBe("MANUAL");
    // Deterministic, not random: the same row always resolves to the same
    // synthetic transaction id, which is what makes the re-run a no-op.
    expect(rows[0]!.storeTransactionId.startsWith("comp_import_")).toBe(true);
    expect(rows[0]!.originalTransactionId).toBe(rows[0]!.storeTransactionId);
  });

  it("preserves a real store transaction id on a promotional row instead of minting a synthetic one", async () => {
    const jobId = await seedJob();
    const realTxnId = "apple_txn_promo_real_1";

    await runFile(
      jobId,
      csvOf([
        {
          subscriberId: "rc_sub_promo_real",
          store: "promotional",
          storeTxnId: realTxnId,
          priceUsd: "0",
        },
      ]),
    );

    const rows = await findPurchases();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.store).toBe("MANUAL");
    // The only value that could later match a store webhook — never
    // overwritten with a synthetic id.
    expect(rows[0]!.storeTransactionId).toBe(realTxnId);
  });

  it("skips anchorless rows when the job opted out", async () => {
    const jobId = await seedJob({ importAnchorless: false });

    const outcome = await runFile(
      jobId,
      csvOf([
        {
          subscriberId: "rc_sub_promo_optout",
          store: "promotional",
          storeTxnId: "",
          priceUsd: "0",
        },
      ]),
    );

    expect(outcome.outcomes.anchorless).toBe(1);
    expect(await countPurchases()).toBe(0);
  });
});

// =============================================================
// Rows the writer must not write
// =============================================================

describe("writeImportBatch — non-writable rows", () => {
  it("skips sandbox rows by default and imports them when asked", async () => {
    const file = csvOf([
      {
        subscriberId: "rc_sub_sandbox",
        storeTxnId: "apple_txn_sandbox_1",
        priceUsd: "9.99",
        isSandbox: "true",
      },
    ]);

    const skippingJobId = await seedJob();
    const skipped = await runFile(skippingJobId, file);
    expect(skipped.outcomes.skippedSandbox).toBe(1);
    expect(await countPurchases()).toBe(0);

    const importingJobId = await seedJob({ skipSandbox: false });
    const imported = await runFile(importingJobId, file);
    expect(imported.outcomes.willCreate).toBe(1);
    expect(await countPurchases()).toBe(1);
  });

  it("skips rows whose product does not resolve, and rows that do not normalize", async () => {
    const jobId = await seedJob();

    const outcome = await runFile(
      jobId,
      csvOf([
        {
          subscriberId: "rc_sub_unresolved",
          storeTxnId: "apple_txn_unresolved_1",
          productId: "no_such_product",
          priceUsd: "9.99",
        },
        {
          subscriberId: "",
          storeTxnId: "apple_txn_invalid_1",
          priceUsd: "9.99",
        },
      ]),
    );

    expect(outcome.outcomes.unresolvedProduct).toBe(1);
    expect(outcome.outcomes.invalidRow).toBe(1);
    expect(await countPurchases()).toBe(0);
    expect(await countSubscribers()).toBe(0);
  });
});
