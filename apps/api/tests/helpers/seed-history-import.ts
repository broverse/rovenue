// =============================================================
// seed-history-import — purchase fixtures written by the REAL writer
// =============================================================
//
// Every purchase row this helper produces is created by driving
// `writeImportBatch` (src/services/import/write.ts) with generated CSV
// content, parsed through the same `parseCsvStream` + `buildCanonicalRow`
// pipeline the Task 8 worker uses. Nothing here inserts into `purchases`
// with drizzle.
//
// That constraint is the point. The Google purchase-token enrichment
// resolver matches on values the writer MINTS rather than on values a
// fixture chooses:
//
//   - `storeTransactionId` is either the file's value or, for anchorless
//     (store = `promotional` -> MANUAL) rows only, a sha256-derived
//     synthetic id (`buildSyntheticTransactionId`). A PLAY_STORE row with
//     no transaction id is NOT synthesized — it is rejected outright with
//     MISSING_STORE_TRANSACTION_ID — so every Play row here carries one.
//   - `originalTransactionId` is `normalized.originalTransactionId ??
//     storeTransactionId`. That fallback is what makes a Play row with no
//     original-transaction column its OWN one-row chain, which is exactly
//     the shape `additionalChain` below relies on to produce a genuine
//     second chain.
//
// A hand-inserted fixture could have picked any of those values and the
// resolver would have passed against a row shape production never emits.
import { Readable } from "node:stream";
import { eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { db, drizzle, access, products, projects, purchases } from "@rovenue/db";
import { parseCsvStream, type CanonicalField } from "@rovenue/shared";
import { buildCanonicalRow } from "../../src/services/import/plan";
import { writeImportBatch, type ImportWriteRow } from "../../src/services/import/write";

// -------------------------------------------------------------
// Named fixture constants
// -------------------------------------------------------------

/** Source-file column names. Arbitrary on purpose: the mapping below is
 *  what binds them to canonical fields, exactly as an operator's
 *  confirmed mapping does in production. */
const SOURCE_COLUMNS = [
  "subscriber_id",
  "store",
  "product_id",
  "store_txn_id",
  "original_txn_id",
  "purchase_date",
  "expires_date",
  "price_in_usd",
] as const;

const CANONICAL_MAPPING: Record<string, CanonicalField> = {
  subscriber_id: "subscriberExternalId",
  store: "store",
  product_id: "productIdentifier",
  store_txn_id: "storeTransactionId",
  original_txn_id: "originalTransactionId",
  purchase_date: "purchaseDate",
  expires_date: "expiresDate",
  price_in_usd: "priceUsd",
};

const CSV_HEADER = SOURCE_COLUMNS.join(",");

/** `normalize.ts`'s STORE_VALUE_MAP keys — the only values the importer
 *  accepts, case-insensitively. */
const SOURCE_STORE_PLAY = "play_store";
const SOURCE_STORE_APPLE = "app_store";

/** Inside `revenue_events`' provisioned partition range (migration 0015
 *  covers 2024-01..2028-12) and far enough apart that renewal rows sort
 *  deterministically. A range-partitioned table has no DEFAULT
 *  partition, so a date outside the range is an insert error. */
const FIRST_PURCHASE_DATE = "2026-01-15 10:00:00";
/** One month per renewal after the first. */
const RENEWAL_INTERVAL_DAYS = 30;
/** Deliberately distinct from every `playChain` row's date so the second
 *  chain can never collide on (store, storeTransactionId). */
const ADDITIONAL_CHAIN_PURCHASE_DATE = "2026-06-20 10:00:00";
const APPLE_PURCHASE_DATE = "2026-03-10 10:00:00";
/** Beyond every fixture purchase date, so rows land ACTIVE. */
const FUTURE_EXPIRY = "2028-12-01 00:00:00";
const FIXTURE_PRICE_USD = "9.99";

const MILLIS_PER_DAY = 24 * 60 * 60 * 1000;

// -------------------------------------------------------------
// CSV construction + the real write path
// -------------------------------------------------------------

type SourceRow = {
  subscriberId: string;
  store: string;
  productId: string;
  storeTxnId: string;
  originalTxnId?: string;
  purchaseDate: string;
  expiresDate?: string;
  priceUsd?: string;
};

function csvOf(rows: SourceRow[]): string {
  const lines = rows.map((r) =>
    [
      r.subscriberId,
      r.store,
      r.productId,
      r.storeTxnId,
      r.originalTxnId ?? "",
      r.purchaseDate,
      r.expiresDate ?? FUTURE_EXPIRY,
      r.priceUsd ?? FIXTURE_PRICE_USD,
    ].join(","),
  );
  return `${CSV_HEADER}\n${lines.join("\n")}\n`;
}

/** Parses exactly the way the import worker does — real streaming CSV
 *  parser plus the job's confirmed mapping — so the writer receives the
 *  same canonical rows production hands it. */
async function parseFile(csv: string): Promise<ImportWriteRow[]> {
  const rows: ImportWriteRow[] = [];
  let header: string[] = [];
  for await (const event of parseCsvStream(Readable.from([Buffer.from(csv, "utf8")]))) {
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

async function createHistoryJob(projectId: string): Promise<string> {
  const jobId = `job_${createId()}`;
  await drizzle.importJobRepo.createImportJob(db, {
    id: jobId,
    projectId,
    sourceLabel: "seed-history-import fixture",
    presetId: null,
    storageKey: `imports/${projectId}/${jobId}/source.csv`,
    fileName: "source.csv",
    fileBytes: 0,
    fileSha256: "deadbeef",
    mapping: CANONICAL_MAPPING,
    options: {},
  });
  return jobId;
}

/**
 * Runs one generated file through the real writer and asserts nothing
 * was silently dropped.
 *
 * The guard matters: `writeImportBatch` never throws on a bad row, it
 * buckets it (`invalidRow`, `unresolvedProduct`, `skippedSandbox`, …).
 * Without this check a fixture whose mapping or store value stopped
 * being accepted would seed ZERO purchases, and the resolver tests would
 * then pass by reporting `noMatch` for every case — green, and proving
 * nothing.
 */
async function writeFile(projectId: string, rows: SourceRow[]): Promise<void> {
  const jobId = await createHistoryJob(projectId);
  const outcome = await writeImportBatch(jobId, await parseFile(csvOf(rows)));
  const written =
    outcome.outcomes.willCreate + outcome.outcomes.willUpdate + outcome.outcomes.androidNoToken;
  if (written !== rows.length) {
    throw new Error(
      `seed-history-import: writer produced ${written} purchase row(s) for a ${rows.length}-row file — ` +
        `outcomes ${JSON.stringify(outcome.outcomes)}; report ${JSON.stringify(outcome.reportRows)}`,
    );
  }
}

// -------------------------------------------------------------
// Catalog
// -------------------------------------------------------------

async function createProject(): Promise<string> {
  const projectId = `proj_seed_import_${createId()}`;
  await db.insert(projects).values({ id: projectId, name: "Enrichment fixture project" });
  await db.insert(access).values({
    id: `acc_seed_import_${createId()}`,
    projectId,
    identifier: "pro",
    displayName: "Pro",
  });
  return projectId;
}

/**
 * A catalog product plus the identifier an import file would carry for
 * it on the given store.
 *
 * `resolveProduct` (plan.ts) tries `products.storeIds[<store>]` FIRST and
 * only falls back to `products.identifier`. Both fixtures below exercise
 * a real branch of that: the Play product is addressed by its
 * `storeIds.google` value (what a Google export contains), the Apple one
 * by its `products.identifier` (which is how an enrichment row naming an
 * Apple-only product still resolves a product while matching no Play
 * purchase at all).
 */
async function createPlayProduct(projectId: string): Promise<{
  productId: string;
  /** The value an import row / enrichment row uses to name this product. */
  productIdentifier: string;
}> {
  const suffix = createId();
  const productId = `prod_seed_play_${suffix}`;
  const playStoreId = `com.example.seed.play.${suffix}`;
  await db.insert(products).values({
    id: productId,
    projectId,
    identifier: `seed_play_${suffix}`,
    type: "SUBSCRIPTION",
    storeIds: { google: playStoreId },
    accessIds: [],
    displayName: "Seed Play Monthly",
  });
  return { productId, productIdentifier: playStoreId };
}

async function createAppleProduct(projectId: string): Promise<{
  productId: string;
  productIdentifier: string;
  appleStoreId: string;
}> {
  const suffix = createId();
  const productId = `prod_seed_apple_${suffix}`;
  const identifier = `seed_apple_${suffix}`;
  const appleStoreId = `com.example.seed.apple.${suffix}`;
  await db.insert(products).values({
    id: productId,
    projectId,
    identifier,
    type: "SUBSCRIPTION",
    storeIds: { apple: appleStoreId },
    accessIds: [],
    displayName: "Seed Apple Monthly",
  });
  return { productId, productIdentifier: identifier, appleStoreId };
}

function dateAfter(base: string, days: number): string {
  const start = new Date(`${base.replace(" ", "T")}Z`);
  const shifted = new Date(start.getTime() + days * MILLIS_PER_DAY);
  return shifted.toISOString().slice(0, 19).replace("T", " ");
}

// -------------------------------------------------------------
// Public fixture surface
// -------------------------------------------------------------

/** The three writer-minted values a test may need to assert on, read
 *  back off the row the writer actually wrote. */
export type SeededPurchase = {
  id: string;
  storeTransactionId: string;
  originalTransactionId: string;
};

export type SeededChain = {
  projectId: string;
  subscriberExternalId: string;
  /** The value an enrichment row would carry to name this product. */
  productIdentifier: string;
  productId: string;
  /** Every row the writer created, oldest first. Exposed as the full
   *  triple rather than just the chain key so a test can assert the
   *  SHAPE the writer produced — in particular whether
   *  `originalTransactionId` is a real chain id or the NOT NULL fallback
   *  onto the row's own `storeTransactionId`. Asserting that from the
   *  fixture's own inputs instead would prove nothing. */
  rows: SeededPurchase[];
  /** Purchase ids the writer created, oldest first. */
  purchaseIds: string[];
  /** Distinct `originalTransactionId` values across those rows — i.e.
   *  the number of chains the resolver will see. */
  chainKeys: string[];
};

async function playStorePurchasesFor(
  projectId: string,
  productId: string,
  subscriberExternalId: string,
) {
  const subscriber = await drizzle.subscriberRepo.resolveSubscriberByRovenueIdOrLegacy(db, {
    projectId,
    key: subscriberExternalId,
  });
  if (!subscriber) {
    throw new Error(
      `seed-history-import: writer did not create subscriber "${subscriberExternalId}"`,
    );
  }
  return drizzle.purchaseRepo.findPlayStorePurchasesBySubscriberAndProduct(db, {
    projectId,
    subscriberId: subscriber.id,
    productId,
  });
}

export const seedHistoryImport = {
  /** A project with its own catalog namespace, so files never collide. */
  async freshProject(): Promise<{ projectId: string }> {
    return { projectId: await createProject() };
  },

  /**
   * `renewals` PLAY_STORE purchase rows for one (subscriber, product)
   * pair.
   *
   * `shareChainId` picks which of the two real-world file shapes the
   * writer is fed, and the difference is the whole feature:
   *
   *   true  (default) — every row names the same `original_txn_id`, the
   *     way a Play export with an original-transaction column does. The
   *     writer carries it forward and the rows form ONE chain.
   *   false — the file has no `original_txn_id` at all, the shape a
   *     RevenueCat Transactions export actually has. write.ts's NOT NULL
   *     fallback then sets each row's `originalTransactionId` to its OWN
   *     `storeTransactionId`, so N renewals become N chains of one. This
   *     is produced by the real writer's real rule, not simulated.
   *
   * `existingToken`, when given, is stamped onto every row the writer
   * created. It is a direct UPDATE, and it is the ONE thing in this
   * helper the history writer cannot do: write.ts does not set
   * `purchases.googlePurchaseToken` at all (there is no producer for that
   * column anywhere yet — writing it is precisely what Task 6 adds). The
   * rows themselves — ids, chain keys, dates, status — are still entirely
   * writer-produced; only the column under test is stamped afterwards.
   * It takes the token VALUE rather than a boolean so a test can seed
   * either a matching token (`alreadyEnriched`) or a disagreeing one
   * (`conflictingToken`).
   */
  async playChain(args: {
    projectId: string;
    renewals: number;
    existingToken?: string;
    shareChainId?: boolean;
  }): Promise<SeededChain> {
    const { projectId, renewals, existingToken } = args;
    const shareChainId = args.shareChainId ?? true;
    const suffix = createId();
    const subscriberExternalId = `rc_sub_play_${suffix}`;
    const { productId, productIdentifier } = await createPlayProduct(projectId);
    const originalTxnId = `gp_orig_${suffix}`;

    const rows: SourceRow[] = Array.from({ length: renewals }, (_, index) => ({
      subscriberId: subscriberExternalId,
      store: SOURCE_STORE_PLAY,
      productId: productIdentifier,
      storeTxnId: `gp_txn_${suffix}_${index}`,
      ...(shareChainId ? { originalTxnId } : {}),
      purchaseDate: dateAfter(FIRST_PURCHASE_DATE, index * RENEWAL_INTERVAL_DAYS),
    }));
    await writeFile(projectId, rows);

    const written = await playStorePurchasesFor(projectId, productId, subscriberExternalId);
    if (written.length !== renewals) {
      throw new Error(
        `seed-history-import: expected ${renewals} Play purchase row(s), found ${written.length}`,
      );
    }
    if (existingToken !== undefined) {
      for (const purchase of written) {
        await drizzle.purchaseRepo.updatePurchase(db, purchase.id, {
          googlePurchaseToken: existingToken,
        });
      }
    }

    // Read back from the writer's own output rather than asserted from
    // the file: if write.ts ever stops carrying `original_txn_id`
    // forward, this fixture reports the value it really landed on and the
    // tests' shape assertions fail loudly instead of drifting.
    const seededRows: SeededPurchase[] = written.map((p) => ({
      id: p.id,
      storeTransactionId: p.storeTransactionId,
      originalTransactionId: p.originalTransactionId,
    }));

    return {
      projectId,
      subscriberExternalId,
      productIdentifier,
      productId,
      rows: seededRows,
      purchaseIds: seededRows.map((r) => r.id),
      chainKeys: [...new Set(seededRows.map((r) => r.originalTransactionId))],
    };
  },

  /**
   * A SECOND chain for a (subscriber, product) pair that `playChain`
   * already seeded — a resubscribe after a lapse.
   *
   * It supplies no `original_txn_id`, so the writer's
   * `originalTransactionId ?? storeTransactionId` fallback makes this row
   * its own chain. Nothing about it is hand-built: the ambiguity the
   * resolver must fail closed on is produced by the writer's real
   * carry-forward rule.
   */
  async additionalChain(args: {
    projectId: string;
    subscriberExternalId: string;
    productIdentifier: string;
  }): Promise<{ storeTransactionId: string }> {
    const storeTransactionId = `gp_txn_second_${createId()}`;
    await writeFile(args.projectId, [
      {
        subscriberId: args.subscriberExternalId,
        store: SOURCE_STORE_PLAY,
        productId: args.productIdentifier,
        storeTxnId: storeTransactionId,
        purchaseDate: ADDITIONAL_CHAIN_PURCHASE_DATE,
      },
    ]);
    return { storeTransactionId };
  },

  /**
   * One APP_STORE chain, written the same way. Its product resolves
   * under the enrichment resolver (via `products.identifier`) but it owns
   * no PLAY_STORE purchase row, which is what separates "the resolver
   * looked and found nothing on Play" from "the resolver never looked".
   */
  async appleChain(args: { projectId: string }): Promise<SeededChain> {
    const { projectId } = args;
    const suffix = createId();
    const subscriberExternalId = `rc_sub_apple_${suffix}`;
    const { productId, productIdentifier, appleStoreId } = await createAppleProduct(projectId);
    const storeTransactionId = `apple_txn_${suffix}`;
    await writeFile(projectId, [
      {
        subscriberId: subscriberExternalId,
        store: SOURCE_STORE_APPLE,
        productId: appleStoreId,
        storeTxnId: storeTransactionId,
        purchaseDate: APPLE_PURCHASE_DATE,
      },
    ]);
    const [row] = await db
      .select()
      .from(purchases)
      .where(eq(purchases.storeTransactionId, storeTransactionId));
    if (!row) {
      throw new Error("seed-history-import: writer created no APP_STORE purchase row");
    }
    const seededRow: SeededPurchase = {
      id: row.id,
      storeTransactionId: row.storeTransactionId,
      originalTransactionId: row.originalTransactionId,
    };
    return {
      projectId,
      subscriberExternalId,
      productIdentifier,
      productId,
      rows: [seededRow],
      chainKeys: [seededRow.originalTransactionId],
      purchaseIds: [row.id],
    };
  },
};
