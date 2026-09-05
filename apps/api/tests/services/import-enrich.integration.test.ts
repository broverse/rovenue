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
// (`normalized.originalTransactionId ?? storeTransactionId`), and keys
// on the storeTransactionId the writer chose. A fixture that inserted
// purchase rows directly could satisfy the resolver with a shape
// production never emits, and the suite would be green while the feature
// matched nothing.
//
// The rule under test, stated because `(subscriberId, productId)` is NOT
// a unique key on `purchases` — every renewal is its own row, and a
// subscriber can hold several distinct chains for one product:
//
//   exactly one chain  -> enriched, EVERY row in the chain (a Play
//                         purchaseToken identifies the subscription
//                         across its renewals, so the chain is the unit)
//   more than one      -> ambiguousMatch, reported and NOT written
//   no candidate rows  -> noMatch
//   all rows tokened   -> alreadyEnriched (a re-run is idempotent)
import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@rovenue/db";
import { resolveEnrichmentTarget } from "../../src/services/import/enrich";
import { seedHistoryImport } from "../helpers/seed-history-import";

/** Any non-empty token — this task RESOLVES only, it never writes one,
 *  so its value is never read back out of the database here. */
const INCOMING_TOKEN = "tok_incoming_1";

describe("resolveEnrichmentTarget", () => {
  let projectId: string;

  // One project for the file: every fixture mints its own subscriber and
  // its own catalog product, so the cases cannot collide and no
  // per-test teardown is needed.
  beforeAll(async () => {
    ({ projectId } = await seedHistoryImport.freshProject());
  });

  it("enriches every row of a single subscription chain", async () => {
    const { subscriberExternalId, productIdentifier, purchaseIds } =
      await seedHistoryImport.playChain({ projectId, renewals: 2, withToken: false });

    const result = await resolveEnrichmentTarget({
      db,
      projectId,
      row: { subscriberExternalId, productIdentifier, googlePurchaseToken: INCOMING_TOKEN },
    });

    expect(result.outcome).toBe("enriched");
    if (result.outcome !== "enriched") return;
    // Both renewals, not just the newest row — the whole point of
    // grouping by chain rather than picking a row.
    expect(result.purchaseIds).toHaveLength(2);
    expect([...result.purchaseIds].sort()).toEqual([...purchaseIds].sort());
  });

  it("fails closed when the pair spans two chains", async () => {
    // THREE purchase rows across TWO chains, deliberately: with one row
    // per chain, "count the chains" and "count the rows" give the same
    // answer, and a resolver that never grouped at all would pass. The
    // 2-renewal first chain makes chainCount === 2 provable only by
    // grouping.
    const { subscriberExternalId, productIdentifier } = await seedHistoryImport.playChain({
      projectId,
      renewals: 2,
      withToken: false,
    });
    await seedHistoryImport.additionalChain({
      projectId,
      subscriberExternalId,
      productIdentifier,
    });

    const result = await resolveEnrichmentTarget({
      db,
      projectId,
      row: { subscriberExternalId, productIdentifier, googlePurchaseToken: INCOMING_TOKEN },
    });

    expect(result.outcome).toBe("ambiguousMatch");
    if (result.outcome !== "ambiguousMatch") return;
    expect(result.chainCount).toBe(2);
  });

  it("reports noMatch when no history row exists", async () => {
    const result = await resolveEnrichmentTarget({
      db,
      projectId,
      row: {
        subscriberExternalId: "ghost_subscriber",
        productIdentifier: "no_such_product",
        googlePurchaseToken: INCOMING_TOKEN,
      },
    });

    expect(result.outcome).toBe("noMatch");
  });

  it("reports noMatch when the subscriber exists but the product does not", async () => {
    // Separates the two halves of the resolution: a bare `noMatch` on a
    // fully-unknown row could also be produced by a resolver that never
    // ran a query at all.
    const { subscriberExternalId } = await seedHistoryImport.playChain({
      projectId,
      renewals: 1,
      withToken: false,
    });

    const result = await resolveEnrichmentTarget({
      db,
      projectId,
      row: {
        subscriberExternalId,
        productIdentifier: "no_such_product",
        googlePurchaseToken: INCOMING_TOKEN,
      },
    });

    expect(result.outcome).toBe("noMatch");
  });

  it("reports alreadyEnriched for a chain that has the token", async () => {
    const { subscriberExternalId, productIdentifier, purchaseIds } =
      await seedHistoryImport.playChain({ projectId, renewals: 1, withToken: true });

    const result = await resolveEnrichmentTarget({
      db,
      projectId,
      row: { subscriberExternalId, productIdentifier, googlePurchaseToken: INCOMING_TOKEN },
    });

    expect(result.outcome).toBe("alreadyEnriched");
    if (result.outcome !== "alreadyEnriched") return;
    expect(result.purchaseIds).toEqual(purchaseIds);
  });

  it("never matches a non-Play row", async () => {
    const { subscriberExternalId, productIdentifier } = await seedHistoryImport.appleChain({
      projectId,
    });

    const result = await resolveEnrichmentTarget({
      db,
      projectId,
      row: { subscriberExternalId, productIdentifier, googlePurchaseToken: INCOMING_TOKEN },
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
    const { subscriberExternalId, productIdentifier } = await seedHistoryImport.playChain({
      projectId,
      renewals: 1,
      withToken: false,
    });
    const { projectId: otherProjectId } = await seedHistoryImport.freshProject();

    const result = await resolveEnrichmentTarget({
      db,
      projectId: otherProjectId,
      row: { subscriberExternalId, productIdentifier, googlePurchaseToken: INCOMING_TOKEN },
    });

    expect(result.outcome).toBe("noMatch");
  });
});
