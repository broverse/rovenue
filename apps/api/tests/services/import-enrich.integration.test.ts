// =============================================================
// resolveEnrichmentTarget — Google purchase-token second pass
// =============================================================
//
// Runs against the real per-worker Postgres that `tests/global-setup.ts`
// provisions (the repo's convention for repository-adjacent service
// tests — see services/import-plan.test.ts and
// services/import-write.integration.test.ts). Nothing is mocked.
//
// Every fixture below is written by the REAL history-import writer
// (`src/services/import/write.ts`), never hand-inserted. That is what
// makes this file worth running: the resolver groups on
// `originalTransactionId`, a value the writer MINTS
// (`normalized.originalTransactionId ?? storeTransactionId`), and the
// whole `enrichUngroupedChains` opt-in exists because of what that
// fallback does to a file with no original-transaction column. A fixture
// that inserted purchase rows directly could satisfy the resolver with a
// shape production never emits, and the suite would be green while the
// feature matched nothing.
//
// The rule under test, stated because `(subscriberId, productId)` is NOT
// a unique key on `purchases` — every renewal is its own row, and a
// subscriber can hold several distinct chains for one product:
//
//   exactly one chain      -> enriched, EVERY row in the chain
//   several REAL chains    -> ambiguousMatch(MULTIPLE_CHAINS)
//   several chains, none
//     with a real chain id -> ungroupedChains, or enriched with the
//                             enrichUngroupedChains opt-in on
//   two tokens for a pair  -> ambiguousMatch(MULTIPLE_SOURCE_TOKENS),
//                             under EVERY option setting
//   no candidate rows      -> noMatch
//   all rows hold this
//     exact token          -> alreadyEnriched (a re-run is idempotent)
//   a row holds a
//     DIFFERENT token      -> conflictingToken, never overwritten
import { beforeAll, describe, expect, it } from "vitest";
import { db, type ImportJobOptions } from "@rovenue/db";
import {
  groupEnrichmentRowsByPair,
  resolveEnrichmentTarget,
  type EnrichmentPair,
} from "../../src/services/import/enrich";
import { seedHistoryImport } from "../helpers/seed-history-import";

/** The token the enrichment file supplies. This task RESOLVES only — it
 *  never writes one — so its value is never read back out of the
 *  database here. */
const INCOMING_TOKEN = "tok_incoming_1";
/** A second, different token for the same pair: the ambiguity the source
 *  file itself asserts, which no option may override. */
const OTHER_TOKEN = "tok_incoming_2";
/** Already stored on a purchase row and NOT equal to `INCOMING_TOKEN`. */
const STORED_CONFLICTING_TOKEN = "tok_stored_conflict";

const OPTION_ON: ImportJobOptions = { enrichUngroupedChains: true };
const OPTION_OFF: ImportJobOptions = { enrichUngroupedChains: false };

/** Builds the pair through the REAL grouping helper rather than by hand,
 *  so every case here also exercises the file-level token collapse that
 *  the multiple-source-tokens rule depends on. Line numbers start at 2
 *  because line 1 of a CSV is the header. */
function pairOf(
  subscriberExternalId: string,
  productIdentifier: string,
  tokens: string[],
): EnrichmentPair {
  const pairs = groupEnrichmentRowsByPair(
    tokens.map((googlePurchaseToken, index) => ({
      lineNumber: index + 2,
      row: { subscriberExternalId, productIdentifier, googlePurchaseToken },
    })),
  );
  expect(pairs).toHaveLength(1);
  return pairs[0]!;
}

describe("groupEnrichmentRowsByPair", () => {
  it("collapses a pair's rows and de-duplicates its tokens", () => {
    const pairs = groupEnrichmentRowsByPair([
      { lineNumber: 2, row: { subscriberExternalId: "u1", productIdentifier: "p1", googlePurchaseToken: "t1" } },
      { lineNumber: 3, row: { subscriberExternalId: "u1", productIdentifier: "p1", googlePurchaseToken: "t1" } },
      { lineNumber: 4, row: { subscriberExternalId: "u1", productIdentifier: "p1", googlePurchaseToken: "t2" } },
      { lineNumber: 5, row: { subscriberExternalId: "u1", productIdentifier: "p2", googlePurchaseToken: "t3" } },
    ]);
    expect(pairs).toHaveLength(2);
    expect(pairs[0]).toEqual({
      subscriberExternalId: "u1",
      productIdentifier: "p1",
      tokens: ["t1", "t2"],
      lineNumbers: [2, 3, 4],
    });
    expect(pairs[1]!.tokens).toEqual(["t3"]);
  });

  it("keeps pairs distinct when the separator appears inside an identifier", () => {
    // ("a:b", "c") and ("a", "b:c") join to the same string under a naive
    // `${a}:${b}` key. Merging them would fabricate a two-token pair out
    // of two unrelated single-token ones — a refusal invented by the key
    // function.
    const pairs = groupEnrichmentRowsByPair([
      { lineNumber: 2, row: { subscriberExternalId: "a:b", productIdentifier: "c", googlePurchaseToken: "t1" } },
      { lineNumber: 3, row: { subscriberExternalId: "a", productIdentifier: "b:c", googlePurchaseToken: "t2" } },
    ]);
    expect(pairs).toHaveLength(2);
    expect(pairs.map((p) => p.tokens)).toEqual([["t1"], ["t2"]]);
  });
});

describe("resolveEnrichmentTarget", () => {
  let projectId: string;

  // One project for the file: every fixture mints its own subscriber and
  // its own catalog product, so the cases cannot collide and no
  // per-test teardown is needed.
  beforeAll(async () => {
    ({ projectId } = await seedHistoryImport.freshProject());
  });

  // -----------------------------------------------------------
  // The chain rule
  // -----------------------------------------------------------

  it("enriches every row of a single subscription chain", async () => {
    const chain = await seedHistoryImport.playChain({ projectId, renewals: 2 });
    // The fixture really is ONE chain, per the writer's own output.
    expect(chain.chainKeys).toHaveLength(1);

    const result = await resolveEnrichmentTarget({
      db,
      projectId,
      pair: pairOf(chain.subscriberExternalId, chain.productIdentifier, [INCOMING_TOKEN]),
    });

    expect(result.outcome).toBe("enriched");
    if (result.outcome !== "enriched") return;
    // Both renewals, not just the newest row — the whole point of
    // grouping by chain rather than picking a row.
    expect(result.purchaseIds).toHaveLength(2);
    expect([...result.purchaseIds].sort()).toEqual([...chain.purchaseIds].sort());
  });

  it("fails closed when the pair spans two real chains", async () => {
    // THREE purchase rows across TWO chains, deliberately: with one row
    // per chain, "count the chains" and "count the rows" give the same
    // answer, and a resolver that never grouped at all would pass. The
    // 2-renewal first chain makes chainCount === 2 provable only by
    // grouping.
    const chain = await seedHistoryImport.playChain({ projectId, renewals: 2 });
    await seedHistoryImport.additionalChain({
      projectId,
      subscriberExternalId: chain.subscriberExternalId,
      productIdentifier: chain.productIdentifier,
    });

    const result = await resolveEnrichmentTarget({
      db,
      projectId,
      pair: pairOf(chain.subscriberExternalId, chain.productIdentifier, [INCOMING_TOKEN]),
    });

    expect(result.outcome).toBe("ambiguousMatch");
    if (result.outcome !== "ambiguousMatch") return;
    expect(result.reason).toBe("MULTIPLE_CHAINS");
    expect(result.chainCount).toBe(2);
  });

  it("still fails closed on real chains when enrichUngroupedChains is on", async () => {
    // The opt-in covers ONLY the case where no row has a real chain id.
    // A genuine resubscribe must stay refused however the job is
    // configured — otherwise the option would silently cross-contaminate
    // two subscriptions.
    const chain = await seedHistoryImport.playChain({ projectId, renewals: 2 });
    await seedHistoryImport.additionalChain({
      projectId,
      subscriberExternalId: chain.subscriberExternalId,
      productIdentifier: chain.productIdentifier,
    });

    const result = await resolveEnrichmentTarget({
      db,
      projectId,
      pair: pairOf(chain.subscriberExternalId, chain.productIdentifier, [INCOMING_TOKEN]),
      options: OPTION_ON,
    });

    expect(result.outcome).toBe("ambiguousMatch");
    if (result.outcome !== "ambiguousMatch") return;
    expect(result.reason).toBe("MULTIPLE_CHAINS");
  });

  // -----------------------------------------------------------
  // The RevenueCat-shaped file, and the opt-in that covers it
  // -----------------------------------------------------------

  it("reports ungroupedChains by default when no row carries a real chain id", async () => {
    const chain = await seedHistoryImport.playChain({
      projectId,
      renewals: 3,
      shareChainId: false,
    });
    // Proof that the WRITER produced the shape this branch is about: the
    // NOT NULL fallback fired, so each row's chain key is its own
    // transaction id and three renewals read as three chains.
    expect(chain.chainKeys).toHaveLength(3);
    for (const row of chain.rows) {
      expect(row.originalTransactionId).toBe(row.storeTransactionId);
    }

    const result = await resolveEnrichmentTarget({
      db,
      projectId,
      pair: pairOf(chain.subscriberExternalId, chain.productIdentifier, [INCOMING_TOKEN]),
    });

    expect(result.outcome).toBe("ungroupedChains");
    if (result.outcome !== "ungroupedChains") return;
    expect(result.chainCount).toBe(3);
    // What turning the option on would enrich — the number the dry-run
    // report shows the operator before they commit.
    expect([...result.purchaseIds].sort()).toEqual([...chain.purchaseIds].sort());
  });

  it("enriches the whole ungrouped set when enrichUngroupedChains is on", async () => {
    const chain = await seedHistoryImport.playChain({
      projectId,
      renewals: 3,
      shareChainId: false,
    });

    const result = await resolveEnrichmentTarget({
      db,
      projectId,
      pair: pairOf(chain.subscriberExternalId, chain.productIdentifier, [INCOMING_TOKEN]),
      options: OPTION_ON,
    });

    expect(result.outcome).toBe("enriched");
    if (result.outcome !== "enriched") return;
    expect([...result.purchaseIds].sort()).toEqual([...chain.purchaseIds].sort());
  });

  it("treats an explicit false the same as an absent option", async () => {
    const chain = await seedHistoryImport.playChain({
      projectId,
      renewals: 2,
      shareChainId: false,
    });

    const result = await resolveEnrichmentTarget({
      db,
      projectId,
      pair: pairOf(chain.subscriberExternalId, chain.productIdentifier, [INCOMING_TOKEN]),
      options: OPTION_OFF,
    });

    expect(result.outcome).toBe("ungroupedChains");
  });

  // -----------------------------------------------------------
  // Ambiguity the source file itself asserts
  // -----------------------------------------------------------

  it("fails closed on two tokens for one pair, with the option OFF", async () => {
    const chain = await seedHistoryImport.playChain({ projectId, renewals: 2 });

    const result = await resolveEnrichmentTarget({
      db,
      projectId,
      pair: pairOf(chain.subscriberExternalId, chain.productIdentifier, [
        INCOMING_TOKEN,
        OTHER_TOKEN,
      ]),
    });

    expect(result.outcome).toBe("ambiguousMatch");
    if (result.outcome !== "ambiguousMatch") return;
    expect(result.reason).toBe("MULTIPLE_SOURCE_TOKENS");
    expect(result.tokenCount).toBe(2);
    // One unambiguous chain, and it is STILL refused: the refusal comes
    // from the file, not from the purchase rows.
    expect(result.chainCount).toBe(1);
  });

  it("fails closed on two tokens for one pair, with the option ON", async () => {
    // Same file-level ambiguity over the ungrouped shape the option is
    // meant to relax. The option must not reach this case.
    const chain = await seedHistoryImport.playChain({
      projectId,
      renewals: 2,
      shareChainId: false,
    });

    const result = await resolveEnrichmentTarget({
      db,
      projectId,
      pair: pairOf(chain.subscriberExternalId, chain.productIdentifier, [
        INCOMING_TOKEN,
        OTHER_TOKEN,
      ]),
      options: OPTION_ON,
    });

    expect(result.outcome).toBe("ambiguousMatch");
    if (result.outcome !== "ambiguousMatch") return;
    expect(result.reason).toBe("MULTIPLE_SOURCE_TOKENS");
    expect(result.chainCount).toBe(2);
  });

  // -----------------------------------------------------------
  // Stored-token states
  // -----------------------------------------------------------

  it("reports alreadyEnriched for a chain that holds this exact token", async () => {
    const chain = await seedHistoryImport.playChain({
      projectId,
      renewals: 1,
      existingToken: INCOMING_TOKEN,
    });

    const result = await resolveEnrichmentTarget({
      db,
      projectId,
      pair: pairOf(chain.subscriberExternalId, chain.productIdentifier, [INCOMING_TOKEN]),
    });

    expect(result.outcome).toBe("alreadyEnriched");
    if (result.outcome !== "alreadyEnriched") return;
    expect(result.purchaseIds).toEqual(chain.purchaseIds);
  });

  it("reports alreadyEnriched for an ungrouped set under EITHER option setting", async () => {
    // A file already applied with the opt-in on has no write left to
    // protect, so turning the option back off must not resurrect a
    // `ungroupedChains` finding the operator would go investigate.
    const chain = await seedHistoryImport.playChain({
      projectId,
      renewals: 3,
      shareChainId: false,
      existingToken: INCOMING_TOKEN,
    });
    const pair = pairOf(chain.subscriberExternalId, chain.productIdentifier, [INCOMING_TOKEN]);

    for (const options of [OPTION_OFF, OPTION_ON]) {
      const result = await resolveEnrichmentTarget({ db, projectId, pair, options });
      expect(result.outcome).toBe("alreadyEnriched");
    }
  });

  it("reports conflictingToken and never picks a winner", async () => {
    const chain = await seedHistoryImport.playChain({
      projectId,
      renewals: 2,
      existingToken: STORED_CONFLICTING_TOKEN,
    });

    const result = await resolveEnrichmentTarget({
      db,
      projectId,
      pair: pairOf(chain.subscriberExternalId, chain.productIdentifier, [INCOMING_TOKEN]),
    });

    expect(result.outcome).toBe("conflictingToken");
    if (result.outcome !== "conflictingToken") return;
    // Both disagreeing rows are named, so the operator can see the whole
    // extent of the disagreement rather than the first row of it.
    expect([...result.purchaseIds].sort()).toEqual([...chain.purchaseIds].sort());
  });

  it("reports conflictingToken for an ungrouped set even with the option ON", async () => {
    // The opt-in relaxes GROUPING. It must not become a licence to
    // overwrite a stored token that disagrees with the file.
    const chain = await seedHistoryImport.playChain({
      projectId,
      renewals: 2,
      shareChainId: false,
      existingToken: STORED_CONFLICTING_TOKEN,
    });

    const result = await resolveEnrichmentTarget({
      db,
      projectId,
      pair: pairOf(chain.subscriberExternalId, chain.productIdentifier, [INCOMING_TOKEN]),
      options: OPTION_ON,
    });

    expect(result.outcome).toBe("conflictingToken");
  });

  // -----------------------------------------------------------
  // Nothing to match
  // -----------------------------------------------------------

  it("reports noMatch when no history row exists", async () => {
    const result = await resolveEnrichmentTarget({
      db,
      projectId,
      pair: pairOf("ghost_subscriber", "no_such_product", [INCOMING_TOKEN]),
    });

    expect(result.outcome).toBe("noMatch");
  });

  it("reports noMatch when the subscriber exists but the product does not", async () => {
    // Separates the two halves of the resolution: a bare `noMatch` on a
    // fully-unknown row could also be produced by a resolver that never
    // ran a query at all.
    const chain = await seedHistoryImport.playChain({ projectId, renewals: 1 });

    const result = await resolveEnrichmentTarget({
      db,
      projectId,
      pair: pairOf(chain.subscriberExternalId, "no_such_product", [INCOMING_TOKEN]),
    });

    expect(result.outcome).toBe("noMatch");
  });

  it("never matches a non-Play row", async () => {
    const chain = await seedHistoryImport.appleChain({ projectId });

    const result = await resolveEnrichmentTarget({
      db,
      projectId,
      pair: pairOf(chain.subscriberExternalId, chain.productIdentifier, [INCOMING_TOKEN]),
    });

    // The APP_STORE purchase is real and its product resolves — the row
    // is excluded because its store is not PLAY_STORE, not because the
    // resolver failed to find anything at all.
    expect(result.outcome).toBe("noMatch");
  });

  it("scopes the match to the project", async () => {
    // The (subscriber, product) identifiers of one project must never
    // reach another's purchases: `resolveEnrichmentTarget` takes a
    // projectId and every lookup inside it has to honour it.
    const chain = await seedHistoryImport.playChain({ projectId, renewals: 1 });
    const { projectId: otherProjectId } = await seedHistoryImport.freshProject();

    const result = await resolveEnrichmentTarget({
      db,
      projectId: otherProjectId,
      pair: pairOf(chain.subscriberExternalId, chain.productIdentifier, [INCOMING_TOKEN]),
    });

    expect(result.outcome).toBe("noMatch");
  });

  it("refuses a pair carrying no token at all", async () => {
    // `groupEnrichmentRowsByPair` can never build one, so this is a
    // caller bug. It must not come back as a plausible `noMatch`.
    await expect(
      resolveEnrichmentTarget({
        db,
        projectId,
        pair: {
          subscriberExternalId: "u1",
          productIdentifier: "p1",
          tokens: [],
          lineNumbers: [2],
        },
      }),
    ).rejects.toThrow(/carries no token/);
  });
});
