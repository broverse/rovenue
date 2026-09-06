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
//   6. Every candidate row already carrying this exact token ->
//      `alreadyEnriched`, so re-running the same file is a no-op.
//   7. A candidate row carrying a DIFFERENT token -> `conflictingToken`.
//      Never overwritten: a stored token that disagrees with the file is
//      a data problem to surface, not one to silently pick a winner for.
//
// -------------------------------------------------------------
// The chain rule's blind spot, and the opt-in that covers it
// -------------------------------------------------------------
//
// `purchases.originalTransactionId` is NOT NULL and RevenueCat's
// Transactions export has no such column, so write.ts's
// `originalTransactionId ?? storeTransactionId` fallback fires on EVERY
// row of the flagship input. A subscriber with four renewals therefore
// lands as four chains of one — and rule 4 above refuses all of them.
// Applied literally, the enrichment pass does nothing at all on the
// exact file it exists to serve.
//
// The fix is not to loosen rule 4, which is what protects a genuine
// resubscribe from being cross-contaminated. It is the same shape this
// pipeline already uses for "I accept a weaker guarantee": an explicit
// job option, like `importAnchorless`. `enrichUngroupedChains`
// (ImportJobOptions, packages/db schema) says: when NO candidate row has
// a real chain id — every row's `originalTransactionId` equals its own
// `storeTransactionId`, so the source file never expressed chains at all
// — and the file supplies exactly ONE token for the pair, treat those
// rows as one group.
//
// Two things that option deliberately does NOT do:
//
//   - It never applies when even one candidate row HAS a real chain id.
//     Then the export did express chains, and more than one of them is
//     the genuine ambiguity rule 4 exists for.
//   - It never overrides an ambiguity the SOURCE FILE asserts. Two
//     distinct tokens for one pair fail closed under every setting: the
//     operator's own file is saying these are two subscriptions, and no
//     opt-in can make that unambiguous.
//
// With the option OFF the situation reports as `ungroupedChains` rather
// than `ambiguousMatch`, so a dry run can tell the operator exactly what
// enabling it would change, and how many rows, before they commit.
//
// -------------------------------------------------------------
// Why this resolves a PAIR and not a row
// -------------------------------------------------------------
//
// "Exactly one distinct token for this pair" is a property of the FILE,
// not of any single row. A function handed one row cannot check it, and
// one that inferred it anyway would be claiming a check it never made.
// So the unit of resolution is an `EnrichmentPair` carrying the pair's
// whole token set, and `groupEnrichmentRowsByPair` is what builds one
// from a file's rows. The single-row entry point is gone on purpose:
// there is no way to call this and accidentally skip the file-level
// check.
import { drizzle, type Db, type ImportJobOptions, type Purchase } from "@rovenue/db";
import type { EnrichmentRow, StoreValue } from "@rovenue/shared";
import { resolveProduct } from "./plan";
import { ENRICHMENT_OUTCOMES, type EnrichmentOutcome } from "./report";

/**
 * Outcome vocabulary for one enrichment pair, mirroring the history
 * import's `HISTORY_OUTCOMES` convention — a job's counters and its
 * report speak one language.
 *
 * The list itself is DECLARED in report.ts (alongside the history
 * buckets, so the two can never drift into two lists describing one set)
 * and re-exported here, which is where callers of the resolver expect to
 * find it. See report.ts's own comment for why the declaration has to
 * sit on that side of the `enrich -> plan -> report` import edge.
 *
 * `invalidRow` is produced UPSTREAM by `normalizeEnrichmentRow`
 * (@rovenue/shared), which rejects a row missing one of the three
 * required fields — this resolver never returns it, because a row that
 * reached a pair has already passed that gate.
 */
export { ENRICHMENT_OUTCOMES, type EnrichmentOutcome };

/** Why a pair was refused. Carried on `ambiguousMatch` instead of being
 *  split into two outcomes: both are "this pair is ambiguous and nothing
 *  will be written", and a report that renders one bucket per outcome
 *  should not grow a column to say the same thing twice. The reason is
 *  what makes the operator-facing message accurate. */
export const AMBIGUITY_REASONS = ["MULTIPLE_CHAINS", "MULTIPLE_SOURCE_TOKENS"] as const;
export type AmbiguityReason = (typeof AMBIGUITY_REASONS)[number];

/** The only store an enrichment file can ever describe: a Google Play
 *  purchaseToken has no meaning on Apple or Stripe rows. Named because
 *  it is used twice below — once to resolve the catalog product through
 *  its Play store id, once to scope the candidate purchases — and both
 *  uses have to be the same store or the resolver would look up a
 *  product on one store and purchases on another. */
const ENRICHMENT_STORE: StoreValue = "PLAY_STORE";

/**
 * Off. The strict chain rule is the default and the safe direction;
 * relaxing it is an operator decision, taken per job.
 *
 * Mirrors write.ts's `DEFAULT_SKIP_SANDBOX` / `DEFAULT_IMPORT_ANCHORLESS`
 * — a named default read through `?? DEFAULT_…`, never an inline literal
 * at the read site, so "what happens when the option is absent" has one
 * answer in one place.
 */
const DEFAULT_ENRICH_UNGROUPED_CHAINS = false;

/**
 * One (subscriber, product) pair from an enrichment file, with EVERY
 * distinct token the file supplies for it.
 *
 * Build these with `groupEnrichmentRowsByPair`. Constructing one by hand
 * with a truncated token set defeats the file-level ambiguity check —
 * the whole reason the resolver takes a pair rather than a row.
 */
export type EnrichmentPair = {
  subscriberExternalId: string;
  productIdentifier: string;
  /** Distinct tokens, in first-seen order. Always at least one. */
  tokens: readonly string[];
  /** Source line numbers that contributed to this pair, in file order.
   *  Carried so a report row can point the operator at the actual lines
   *  when a pair is refused. */
  lineNumbers: readonly number[];
};

export type EnrichmentResolution =
  | { outcome: "enriched"; purchaseIds: string[] }
  | { outcome: "alreadyEnriched"; purchaseIds: string[] }
  | { outcome: "noMatch" }
  | {
      outcome: "ambiguousMatch";
      reason: AmbiguityReason;
      chainCount: number;
      tokenCount: number;
    }
  /** Refused ONLY because `enrichUngroupedChains` is off. Every candidate
   *  row lacks a real chain id and the file supplies one token, so
   *  `purchaseIds` is exactly what turning the option on would enrich —
   *  which is what makes this actionable in a dry-run report. */
  | { outcome: "ungroupedChains"; chainCount: number; purchaseIds: string[] }
  /** At least one candidate row already stores a DIFFERENT token.
   *  `purchaseIds` are the disagreeing rows. Nothing is written; the
   *  stored token is never overwritten. */
  | { outcome: "conflictingToken"; purchaseIds: string[] };

// =============================================================
// File-level grouping
// =============================================================

/** Pair identity, length-prefixed rather than separator-joined.
 *
 *  Both halves are operator-supplied strings out of a CSV, so no
 *  character can be assumed absent from them. A plain `a:b` join makes
 *  ("a:b", "c") and ("a", "b:c") the same key, which would merge two
 *  subscribers' token sets and manufacture a MULTIPLE_SOURCE_TOKENS
 *  refusal out of nothing. The length prefix makes the key injective for
 *  any input, with no assumption about the alphabet. */
const PAIR_KEY_SEPARATOR = ":";

function pairKey(subscriberExternalId: string, productIdentifier: string): string {
  return [subscriberExternalId.length, subscriberExternalId, productIdentifier].join(
    PAIR_KEY_SEPARATOR,
  );
}

/**
 * Collapses a file's enrichment rows into one entry per
 * (subscriber, product) pair, accumulating the distinct tokens each pair
 * was given.
 *
 * This is where "the file says two different things about this pair"
 * becomes visible at all: it is invisible from any single row.
 *
 * Pairs come back in first-seen order so a report reads in file order.
 */
export function groupEnrichmentRowsByPair(
  rows: Iterable<{ lineNumber: number; row: EnrichmentRow }>,
): EnrichmentPair[] {
  const pairs = new Map<
    string,
    { subscriberExternalId: string; productIdentifier: string; tokens: string[]; lineNumbers: number[] }
  >();
  for (const { lineNumber, row } of rows) {
    const key = pairKey(row.subscriberExternalId, row.productIdentifier);
    const existing = pairs.get(key);
    if (existing) {
      if (!existing.tokens.includes(row.googlePurchaseToken)) {
        existing.tokens.push(row.googlePurchaseToken);
      }
      existing.lineNumbers.push(lineNumber);
      continue;
    }
    pairs.set(key, {
      subscriberExternalId: row.subscriberExternalId,
      productIdentifier: row.productIdentifier,
      tokens: [row.googlePurchaseToken],
      lineNumbers: [lineNumber],
    });
  }
  return [...pairs.values()];
}

// =============================================================
// Chain grouping
// =============================================================

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

/**
 * True when NO candidate row carries a real chain id — every one of them
 * has `originalTransactionId === storeTransactionId`, i.e. write.ts's
 * NOT NULL fallback is the only thing that populated the column.
 *
 * Deliberately `every`, not `some`: one row with a real chain id means
 * the export DID express chains, and the multi-chain refusal is then a
 * genuine finding rather than an artefact of a missing column.
 */
function hasNoRealChainIds(rows: Purchase[]): boolean {
  return rows.every((row) => row.originalTransactionId === row.storeTransactionId);
}

/** A stored token counts as present only if it is a non-empty string.
 *  `text` columns admit `''`, and an empty token would fail Phase B's
 *  store call just as surely as a null one — treating it as enriched
 *  would strand the row permanently. */
function storedToken(row: Purchase): string | null {
  const value = row.googlePurchaseToken;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

// =============================================================
// resolveEnrichmentTarget
// =============================================================

/**
 * Resolves which purchase rows (if any) one pair's token belongs to.
 *
 * Writes nothing — the caller decides what to do with the answer.
 *
 * `options` is the job's own `import_jobs.options`, passed through
 * unchanged rather than pre-digested into a boolean, so the read of the
 * option and its default live next to the rule they govern.
 */
export async function resolveEnrichmentTarget(args: {
  db: Db;
  projectId: string;
  pair: EnrichmentPair;
  options?: ImportJobOptions;
}): Promise<EnrichmentResolution> {
  const { db, projectId, pair, options } = args;
  const enrichUngroupedChains =
    options?.enrichUngroupedChains ?? DEFAULT_ENRICH_UNGROUPED_CHAINS;

  if (pair.tokens.length === 0) {
    // Not a data condition: `groupEnrichmentRowsByPair` always records at
    // least one token, and `normalizeEnrichmentRow` rejects a row with an
    // empty one. Throwing rather than returning `noMatch` keeps a caller
    // that hand-built a pair from getting a plausible-looking answer.
    throw new Error(
      `resolveEnrichmentTarget: pair (${pair.subscriberExternalId}, ${pair.productIdentifier}) carries no token`,
    );
  }

  // Same identity order the history importer resolved this person with
  // (rovenueId first, legacy appUserId second, merge redirects
  // followed), so the enrichment lands on the row the import wrote
  // rather than on a second row for the same person.
  const subscriber = await drizzle.subscriberRepo.resolveSubscriberByRovenueIdOrLegacy(db, {
    projectId,
    key: pair.subscriberExternalId,
  });
  // A soft-deleted hit reaches here only through the legacy appUserId
  // leg, which does not filter `deletedAt` (the partial unique index
  // does; the finder does not). Returning nothing for one costs a caller
  // nothing and keeps a GDPR-erased identity out of the write path Task 6
  // builds on top of this — write.ts's `resolveSubscriberForImport`
  // refuses the same case for the same reason.
  if (!subscriber || subscriber.deletedAt) return { outcome: "noMatch" };

  // Reuses plan.ts's resolver rather than a second, subtly different one
  // — including its rule that a non-unique `storeIds` match is ambiguous
  // and resolves to nothing. An ambiguous product reports as `noMatch`
  // rather than `ambiguousMatch`: `ambiguousMatch`'s counts are about
  // chains and tokens, and neither could honestly describe a catalog
  // collision. Both fail closed; the report row keeps both identifiers,
  // so it stays diagnosable.
  const product = await resolveProduct(db, projectId, ENRICHMENT_STORE, pair.productIdentifier);
  if (product.kind !== "resolved") return { outcome: "noMatch" };

  const candidates = await drizzle.purchaseRepo.findPlayStorePurchasesBySubscriberAndProduct(db, {
    projectId,
    subscriberId: subscriber.id,
    productId: product.product.id,
  });
  if (candidates.length === 0) return { outcome: "noMatch" };

  const chains = groupByChain(candidates);
  const chainCount = chains.size;
  const tokenCount = pair.tokens.length;

  // The source file's own ambiguity, checked before anything this
  // pipeline could relax. No option overrides it, and the counts
  // reported alongside are both real because the lookup already ran.
  if (tokenCount > 1) {
    return {
      outcome: "ambiguousMatch",
      reason: "MULTIPLE_SOURCE_TOKENS",
      chainCount,
      tokenCount,
    };
  }
  const token = pair.tokens[0]!;

  // Nothing to do, whatever the grouping says.
  //
  // This deliberately precedes the chain decision, reversing the order an
  // earlier revision used. A re-run of a file that was already applied
  // has no write to protect, so reporting `ambiguousMatch` or
  // `ungroupedChains` for it would send the operator to investigate a
  // problem that no longer exists — and would make the answer depend on
  // an option setting that cannot change the outcome. It cannot mask a
  // real conflict: a differing stored token fails this check and falls
  // through to the `conflictingToken` branch below.
  if (candidates.every((row) => storedToken(row) === token)) {
    return { outcome: "alreadyEnriched", purchaseIds: candidates.map((row) => row.id) };
  }

  const group = resolveGroup({ candidates, chains, chainCount, enrichUngroupedChains });
  if ("outcome" in group) return group;

  // Never overwrite a stored token that disagrees with the file.
  const conflicting = group.rows.filter((row) => {
    const stored = storedToken(row);
    return stored !== null && stored !== token;
  });
  if (conflicting.length > 0) {
    return { outcome: "conflictingToken", purchaseIds: conflicting.map((row) => row.id) };
  }

  // Some rows may already carry this exact token (a partially applied
  // previous run). The chain is still reported as `enriched` and names
  // every row: the token identifies the subscription, so a renewal that
  // missed it is a gap to close, not a row to leave behind.
  return { outcome: "enriched", purchaseIds: group.rows.map((row) => row.id) };
}

/**
 * Decides which candidate rows a single token may be applied to, or
 * refuses the pair.
 *
 * Split out so the three-way chain decision reads as one thing:
 * exactly one chain is the normal case; several chains with no real
 * chain ids is the RevenueCat-shaped case the opt-in covers; several
 * chains with real ids is a genuine resubscribe and always refused.
 */
function resolveGroup(args: {
  candidates: Purchase[];
  chains: Map<string, Purchase[]>;
  chainCount: number;
  enrichUngroupedChains: boolean;
}): { rows: Purchase[] } | Extract<EnrichmentResolution, { outcome: "ambiguousMatch" | "ungroupedChains" }> {
  const { candidates, chains, chainCount, enrichUngroupedChains } = args;

  if (chainCount === 1) {
    return { rows: [...chains.values()][0]! };
  }

  if (!hasNoRealChainIds(candidates)) {
    return {
      outcome: "ambiguousMatch",
      reason: "MULTIPLE_CHAINS",
      chainCount,
      tokenCount: 1,
    };
  }

  if (!enrichUngroupedChains) {
    return {
      outcome: "ungroupedChains",
      chainCount,
      purchaseIds: candidates.map((row) => row.id),
    };
  }

  return { rows: candidates };
}
