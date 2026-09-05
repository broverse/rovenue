// Google purchase-token second pass — target resolution.
//
// A GOOGLE_TOKEN_ENRICHMENT file is three columns wide (user id, Google
// purchase token, Google product id). It creates nothing: it patches a
// token onto purchase rows a PREVIOUS history import already wrote, so
// Phase B can re-verify Android history that arrived with no token at
// all (`androidNoToken` in write.ts — a row written history-only, with
// `verifiedAt` left null, because there was no anchor to check it
// against).
//
// THIS MODULE RESOLVES ONLY. It performs no writes. Deciding which rows
// a token belongs to is the part that can be wrong in a way nobody
// notices, so it is separated from the write that acts on the decision.
//
// -------------------------------------------------------------
// Why the matching rule has to be written down
// -------------------------------------------------------------
//
// `(subscriberId, productId)` is NOT a unique key on `purchases`. The
// table's only unique index is (store, storeTransactionId). A subscriber
// legitimately holds many purchase rows for one product: every renewal
// is its own row, and someone who lapses and resubscribes owns two
// unrelated subscriptions to the same product. "Find the existing
// purchase" is therefore ambiguous BY CONSTRUCTION, and picking one
// silently — newest, first, highest id — would be a guess dressed as a
// lookup.
//
// So the rule is explicit, and it fails closed the same way plan.ts's
// `resolveProduct` already does for an ambiguous catalog match:
//
//   1. Candidate rows are the PLAY_STORE purchases for the pair.
//   2. Group them by `originalTransactionId` — that is the subscription
//      chain, and it is the value write.ts actually mints
//      (`normalized.originalTransactionId ?? storeTransactionId`).
//   3. Exactly ONE chain -> `enriched`, naming EVERY row in it. A Google
//      Play purchaseToken identifies a subscription across its renewals,
//      not a single transaction, so the chain is the unit of enrichment.
//   4. MORE than one chain -> `ambiguousMatch` with the count. Reported,
//      never written: stamping one subscription's token onto another's
//      renewals would make Phase B confidently re-verify the wrong
//      subscription, which is worse than leaving the rows unverifiable.
//   5. Nothing found, or the subscriber/product cannot be resolved ->
//      `noMatch`.
//   6. Every candidate row already carrying a token -> `alreadyEnriched`,
//      so re-running the same file is a no-op rather than a rewrite.
import { drizzle, type Db, type Purchase } from "@rovenue/db";
import type { EnrichmentRow, StoreValue } from "@rovenue/shared";
import { resolveProduct } from "./plan";

/**
 * Outcome vocabulary for one enrichment row, mirroring the history
 * import's `IMPORT_OUTCOMES` convention (report.ts) — a job's counters
 * and its report speak one language.
 *
 * `invalidRow` is produced UPSTREAM by `normalizeEnrichmentRow`
 * (@rovenue/shared), which is what rejects a row missing one of the
 * three required fields. It is listed here because it belongs to the
 * same bucket vocabulary a job reports on, not because this resolver
 * ever returns it — a row that reached `resolveEnrichmentTarget` has
 * already passed that gate.
 */
export const ENRICHMENT_OUTCOMES = [
  "enriched",
  "alreadyEnriched",
  "noMatch",
  "ambiguousMatch",
  "invalidRow",
] as const;

export type EnrichmentOutcome = (typeof ENRICHMENT_OUTCOMES)[number];

/** The only store an enrichment file can ever describe: a Google Play
 *  purchaseToken has no meaning on Apple or Stripe rows. Named because
 *  it is used twice below — once to resolve the catalog product through
 *  its Play store id, once to scope the candidate purchases — and both
 *  uses have to be the same store or the resolver would look up a
 *  product on one store and purchases on another. */
const ENRICHMENT_STORE: StoreValue = "PLAY_STORE";

export type EnrichmentResolution =
  | { outcome: "enriched"; purchaseIds: string[] }
  | { outcome: "alreadyEnriched"; purchaseIds: string[] }
  | { outcome: "noMatch" }
  | { outcome: "ambiguousMatch"; chainCount: number };

/** A chain key is `originalTransactionId`, which is NOT NULL on
 *  `purchases` — write.ts substitutes the row's own storeTransactionId
 *  when the source file has no original-transaction column, exactly as
 *  grant.ts does for a MANUAL grant. So a row with no stated chain is
 *  its own chain of one, and never collapses into a shared null bucket. */
function groupByChain(rows: Purchase[]): Map<string, Purchase[]> {
  const chains = new Map<string, Purchase[]>();
  for (const row of rows) {
    const existing = chains.get(row.originalTransactionId);
    if (existing) {
      existing.push(row);
    } else {
      chains.set(row.originalTransactionId, [row]);
    }
  }
  return chains;
}

/** A token is "present" only if it is a non-empty string. `text` columns
 *  admit `''`, and an empty token would fail Phase B's store call just
 *  as surely as a null one — treating it as enriched would strand the
 *  row permanently. */
function hasToken(row: Purchase): boolean {
  return typeof row.googlePurchaseToken === "string" && row.googlePurchaseToken.trim() !== "";
}

/**
 * Resolves which purchase rows (if any) a single enrichment row's token
 * belongs to.
 *
 * Writes nothing — the caller decides what to do with the answer.
 */
export async function resolveEnrichmentTarget(args: {
  db: Db;
  projectId: string;
  row: EnrichmentRow;
}): Promise<EnrichmentResolution> {
  const { db, projectId, row } = args;

  // Same identity order the history importer resolved this person with
  // (rovenueId first, legacy appUserId second, merge redirects
  // followed), so the enrichment lands on the row the import wrote
  // rather than on a second row for the same person.
  const subscriber = await drizzle.subscriberRepo.resolveSubscriberByRovenueIdOrLegacy(db, {
    projectId,
    key: row.subscriberExternalId,
  });
  if (!subscriber) return { outcome: "noMatch" };

  // Reuses plan.ts's resolver rather than a second, subtly different one
  // — including its rule that a non-unique `storeIds` match is ambiguous
  // and resolves to nothing. An ambiguous product is reported as
  // `noMatch` rather than `ambiguousMatch`: `ambiguousMatch` carries a
  // CHAIN count and means "the subscription is ambiguous", a different
  // claim from "the catalog product is". Both fail closed; only the
  // reason differs, and the report row keeps the identifiers that were
  // looked up.
  const product = await resolveProduct(db, projectId, ENRICHMENT_STORE, row.productIdentifier);
  if (product.kind !== "resolved") return { outcome: "noMatch" };

  const candidates = await drizzle.purchaseRepo.findPlayStorePurchasesBySubscriberAndProduct(db, {
    projectId,
    subscriberId: subscriber.id,
    productId: product.product.id,
  });
  if (candidates.length === 0) return { outcome: "noMatch" };

  const chains = groupByChain(candidates);
  // Ambiguity is checked BEFORE the already-enriched short-circuit: an
  // operator whose file cannot be applied needs to be told so, and a
  // multi-chain pair is never something this pipeline itself produced
  // in an enriched state, so nothing is masked by ordering it first.
  if (chains.size > 1) {
    return { outcome: "ambiguousMatch", chainCount: chains.size };
  }

  const chain = [...chains.values()][0]!;
  const purchaseIds = chain.map((purchase) => purchase.id);

  // Every row already tokened -> nothing to do. A PARTIALLY tokened
  // chain still reports `enriched` and names the whole chain: the token
  // identifies the subscription, so a renewal that missed it is a gap to
  // close, not a row to leave behind.
  if (chain.every(hasToken)) {
    return { outcome: "alreadyEnriched", purchaseIds };
  }

  return { outcome: "enriched", purchaseIds };
}
