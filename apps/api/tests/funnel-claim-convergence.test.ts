import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// POST /v1/subscribers/claim-funnel-token — claim-time convergence
// =============================================================
//
// A funnel visitor pays BEFORE they have an app install, so the purchase
// hangs off a synthetic subscriber anchored on the Stripe customer
// (`services/funnel/complete-purchase.ts` upserts `stripe:<customer>`).
// Claim is where that row has to become the installed subscriber: the
// SDK arrives with a device `anon_id`, and everything the buyer paid for
// is sitting somewhere else.
//
// Two things are under test, and they are the same fix:
//
//   1. the merge happens, onto the RIGHT subscriber, and never across a
//      project boundary; and
//   2. the entitlements the response reports are the ones the merge just
//      moved — which is a statement about WHERE and WHEN the read runs,
//      not just about call order.
//
// WHY THE DB IS SIMULATED RATHER THAN STUBBED
// -------------------------------------------
// The interesting failure is invisible to a call-order assertion. The
// merge writes through `tx`; the response reads through `drizzle.db`,
// which is a DIFFERENT CONNECTION. Read while the transaction is still
// open and it sees nothing — `entitlements` is `[]` on every claim, and
// a test that only checks `merge` came before `read` passes anyway.
//
// So `world` below models the one property that makes the difference:
// writes made through `tx` are invisible to `drizzle.db` until the
// transaction commits. Any of these regressions turns a test red here:
//
//   * response built inside the transaction  → read sees pre-merge state
//   * read handed `tx` instead of `drizzle.db` → wrong-connection assert
//   * read moved before `reassignAllAssets`  → read sees pre-merge state
//   * merge dropped entirely                 → nothing to see either way

/** Identity-checkable handles. The route must read through `db` and
 *  write through the `tx` the transaction handed it — the test can tell
 *  the two apart, which is the whole point. */
const dbHandle = vi.hoisted(() => ({ handle: "db" }) as Record<string, unknown>);
const txHandle = vi.hoisted(() => ({ handle: "tx" }) as Record<string, unknown>);

/** A two-connection world: `committed` is what `drizzle.db` can see,
 *  `pending` is what only the open transaction can see. */
const world = vi.hoisted(() => ({
  /** subscriberId -> access rows, as committed. */
  committed: new Map() as Map<
    string,
    Array<{ accessId: string; isActive: boolean; expiresDate: Date | null }>
  >,
  /** Moves made inside the open transaction, not yet committed. */
  pending: [] as Array<{ from: string; to: string }>,
  /** Marks pushed in the order they happened, for the ordering assertion. */
  timeline: [] as string[],
  /** Every findActiveAccess call: which handle, committed yet? */
  reads: [] as Array<{ handle: unknown; afterCommit: boolean }>,
  committedYet: false,
  reset() {
    world.committed = new Map();
    world.pending = [];
    world.timeline = [];
    world.reads = [];
    world.committedYet = false;
  },
  /** Apply one pending move to a table. */
  applyMove(
    table: Map<
      string,
      Array<{ accessId: string; isActive: boolean; expiresDate: Date | null }>
    >,
    move: { from: string; to: string },
  ) {
    const moved = table.get(move.from) ?? [];
    table.set(move.to, [...(table.get(move.to) ?? []), ...moved]);
    table.delete(move.from);
  },
  commit() {
    for (const move of world.pending) world.applyMove(world.committed, move);
    world.pending = [];
    world.committedYet = true;
  },
  /** What a given connection can see right now. */
  view(handle: unknown, subscriberId: string) {
    if (handle === dbHandle) {
      return world.committed.get(subscriberId) ?? [];
    }
    if (handle === txHandle) {
      // The transaction sees its own uncommitted writes on top of the
      // committed state.
      const snapshot = new Map(
        [...world.committed].map(([k, v]) => [k, [...v]] as const),
      );
      for (const move of world.pending) world.applyMove(snapshot, move);
      return snapshot.get(subscriberId) ?? [];
    }
    throw new Error(
      `findActiveAccess was handed an unknown db handle: ${JSON.stringify(handle)}`,
    );
  },
}));

/** The subscribers table, by id. `findSubscriberById` reads THIS rather
 *  than a single canned row, because the route now reads two different
 *  subscribers through it — the source and the claimer — and a test that
 *  answers the same row to both cannot tell the two reads apart. Tests
 *  that want a different shape mutate the map. */
const subscriberRows = vi.hoisted(
  () =>
    new Map<
      string,
      {
        id: string;
        projectId: string;
        rovenueId: string;
        appUserId?: string | null;
        deletedAt: Date | null;
        mergedInto?: string | null;
      }
    >(),
);

const transaction = vi.hoisted(() =>
  vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    const result = await fn(txHandle);
    // COMMIT — only now do the transaction's writes become visible to
    // any other connection.
    world.commit();
    world.timeline.push("commit");
    return result;
  }),
);

const findByHash = vi.hoisted(() => vi.fn());
const tryClaim = vi.hoisted(() => vi.fn());
const setSessionState = vi.hoisted(() => vi.fn());
const findSessionById = vi.hoisted(() => vi.fn());
const resolveSubscriber = vi.hoisted(() => vi.fn());
const upsertSubscriber = vi.hoisted(() => vi.fn());
const findSubscriberById = vi.hoisted(() => vi.fn());
const findPurchaseBySession = vi.hoisted(() => vi.fn());
const setPurchaseSubscriber = vi.hoisted(() => vi.fn());
const listAnswersBySession = vi.hoisted(() => vi.fn());
const findActiveAccess = vi.hoisted(() => vi.fn());
const findAccessByIds = vi.hoisted(() => vi.fn());
const outboxInsert = vi.hoisted(() => vi.fn());
const advisoryXactLock2 = vi.hoisted(() => vi.fn());

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      db: Object.assign(dbHandle, { transaction }),
      funnelClaimTokenRepo: { findByHash, tryClaim },
      funnelSessionRepo: { findById: findSessionById, setState: setSessionState },
      funnelAnswerRepo: { listBySession: listAnswersBySession },
      funnelPurchaseRepo: {
        findBySession: findPurchaseBySession,
        setSubscriber: setPurchaseSubscriber,
      },
      subscriberRepo: {
        resolveSubscriberByRovenueId: resolveSubscriber,
        upsertSubscriber,
        findSubscriberById,
        // The route reads both rows through the FOR UPDATE variant now.
        // Same spy, so the call-order assertions below still describe the
        // reads the route actually makes.
        findSubscriberByIdForUpdate: findSubscriberById,
      },
      accessRepo: { findActiveAccess },
      accessCatalogRepo: { findByIds: findAccessByIds },
      outboxRepo: { insert: outboxInsert },
      lockRepo: { advisoryXactLock2 },
    },
  };
});

// The merge itself is exercised by services/subscriber-transfer's own
// tests; here it is a spy whose effect on `world` mirrors what the real
// one does — move the source's access rows onto the target — so the
// response read has something real to be right or wrong about.
const reassignAllAssets = vi.hoisted(() => vi.fn());
const safeSyncAccessAfterMerge = vi.hoisted(() => vi.fn());
vi.mock("../src/services/subscriber-transfer", () => ({
  reassignAllAssets,
  safeSyncAccessAfterMerge,
}));

vi.mock("../src/lib/redis", () => ({ redis: { set: vi.fn(), get: vi.fn() } }));
vi.mock("../src/lib/mailer", () => ({ mailer: () => ({ send: vi.fn() }) }));

import { Hono } from "hono";
import { funnelClaimRoute } from "../src/routes/v1/funnel-claim";
// NOT mocked: the route hashes the plaintext and timing-safe-compares it
// against the stored hash. The fixture below stores a REAL hash so that
// path is exercised rather than bypassed.
import { hashToken } from "../src/services/funnel/token";

const TOKEN = "a".repeat(43);
const TOKEN_HASH = hashToken(TOKEN);

function buildApp() {
  return new Hono()
    .use("*", async (c, next) => {
      c.set("project", {
        id: "proj_1",
        name: "Test",
        slug: "test",
        keyKind: "public",
        apiKeyId: "key_1",
      } as never);
      await next();
    })
    .route("/v1", funnelClaimRoute);
}

async function claim(body: { token?: string; anon_id?: string } = {}) {
  return buildApp().request("/v1/subscribers/claim-funnel-token", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: TOKEN, anon_id: "a1", ...body }),
  });
}

/** Give `subscriberId` a committed access row. */
function grant(
  subscriberId: string,
  accessId: string,
  extra: { isActive?: boolean; expiresDate?: Date | null } = {},
) {
  const rows = world.committed.get(subscriberId) ?? [];
  rows.push({
    accessId,
    isActive: extra.isActive ?? true,
    expiresDate: extra.expiresDate ?? null,
  });
  world.committed.set(subscriberId, rows);
}

describe("POST /v1/subscribers/claim-funnel-token — convergence", () => {
  beforeEach(() => {
    world.reset();
    // mockClear, not mockReset: the implementation IS the commit
    // semantics the suite depends on.
    transaction.mockClear();

    findByHash.mockReset().mockResolvedValue({
      id: "tok_1",
      tokenHash: TOKEN_HASH,
      projectId: "proj_1",
      sessionId: "sess_1",
      expiresAt: new Date(Date.now() + 60_000),
      claimedAt: null,
      claimedBySubscriberId: null,
    });
    tryClaim.mockReset().mockResolvedValue({ id: "tok_1" });
    setSessionState.mockReset().mockResolvedValue(undefined);
    findSessionById.mockReset().mockResolvedValue({
      id: "sess_1",
      projectId: "proj_1",
      funnelId: "fnl_1",
      funnelVersionId: "fnv_1",
    });
    resolveSubscriber.mockReset().mockResolvedValue({
      id: "sub_installed",
      projectId: "proj_1",
      rovenueId: "a1",
    });
    upsertSubscriber.mockReset().mockResolvedValue({
      id: "sub_installed",
      projectId: "proj_1",
      rovenueId: "a1",
    });
    advisoryXactLock2.mockReset().mockImplementation(async () => {
      world.timeline.push("lock");
    });
    setPurchaseSubscriber.mockReset().mockResolvedValue(undefined);
    subscriberRows.clear();
    subscriberRows.set("sub_synthetic", {
      id: "sub_synthetic",
      projectId: "proj_1",
      rovenueId: "stripe:cus_1",
      appUserId: "stripe:cus_1",
      deletedAt: null,
      mergedInto: null,
    });
    subscriberRows.set("sub_installed", {
      id: "sub_installed",
      projectId: "proj_1",
      rovenueId: "a1",
      appUserId: null,
      deletedAt: null,
      mergedInto: null,
    });
    findSubscriberById
      .mockReset()
      .mockImplementation(
        async (_handle: unknown, id: string) => subscriberRows.get(id) ?? null,
      );
    findPurchaseBySession.mockReset().mockResolvedValue({
      id: "pur_1",
      projectId: "proj_1",
      sessionId: "sess_1",
      subscriberId: "sub_synthetic",
    });
    listAnswersBySession.mockReset().mockResolvedValue([]);
    outboxInsert.mockReset().mockResolvedValue(undefined);
    safeSyncAccessAfterMerge.mockReset().mockResolvedValue(undefined);

    // The merge, modelled: the source's access rows land on the target,
    // but only once the transaction commits.
    reassignAllAssets
      .mockReset()
      .mockImplementation(
        async (
          _tx: unknown,
          _projectId: string,
          from: { id: string },
          to: { id: string },
        ) => {
          world.timeline.push("merge");
          world.pending.push({ from: from.id, to: to.id });
          return 0;
        },
      );

    // `findActiveAccess` filters in SQL — active AND not past expiry —
    // so the fake applies the same rule rather than handing the caller
    // every historical row.
    findActiveAccess
      .mockReset()
      .mockImplementation(
        async (handle: unknown, subscriberId: string, now: Date) => {
          world.timeline.push("read");
          world.reads.push({ handle, afterCommit: world.committedYet });
          return world
            .view(handle, subscriberId)
            .filter(
              (row) =>
                row.isActive &&
                (!row.expiresDate ||
                  row.expiresDate.getTime() > now.getTime()),
            );
        },
      );

    // Access ids are internal row ids; the entitlement surface reports
    // the catalog identifier (see lib/access-response.ts).
    findAccessByIds
      .mockReset()
      .mockImplementation(async (_db: unknown, ids: string[]) =>
        ids.map((id) => ({ id, identifier: id.replace(/^acc_/, "") })),
      );
  });

  // =============================================================
  // The merge
  // =============================================================

  it("merges the synthetic subscriber into the claiming one", async () => {
    const res = await claim();

    expect(res.status).toBe(200);
    expect(reassignAllAssets).toHaveBeenCalledWith(
      // Through the transaction handle: the merge and the claim must
      // stand or fall together.
      txHandle,
      "proj_1",
      expect.objectContaining({ id: "sub_synthetic" }),
      expect.objectContaining({ id: "sub_installed" }),
    );
  });

  it("does not merge when the purchase has no synthetic subscriber", async () => {
    // The dev-mode stub in routes/public/funnels.ts inserts a paid
    // purchase with no subscriber at all. Nothing to move — and a claim
    // against it must still succeed, not 500.
    findPurchaseBySession.mockResolvedValue({
      id: "pur_1",
      projectId: "proj_1",
      sessionId: "sess_1",
      subscriberId: null,
    });

    const res = await claim();

    expect(res.status).toBe(200);
    expect(reassignAllAssets).not.toHaveBeenCalled();
  });

  it("does not merge when the session has no purchase row at all", async () => {
    findPurchaseBySession.mockResolvedValue(null);

    const res = await claim();

    expect(res.status).toBe(200);
    expect(reassignAllAssets).not.toHaveBeenCalled();
  });

  it("does not merge a subscriber into itself", async () => {
    findPurchaseBySession.mockResolvedValue({
      id: "pur_1",
      projectId: "proj_1",
      sessionId: "sess_1",
      subscriberId: "sub_installed",
    });

    const res = await claim();

    expect(res.status).toBe(200);
    expect(reassignAllAssets).not.toHaveBeenCalled();
    // A self-merge would have soft-deleted the claimer as merged into
    // itself, so the sync must not be attempted either.
    expect(safeSyncAccessAfterMerge).not.toHaveBeenCalled();
  });

  // =============================================================
  // Wrong-subscriber / cross-project defences
  // =============================================================
  //
  // `reassignAllAssets` takes a projectId, but every statement it issues
  // is keyed on subscriber id alone (reassignPurchases, reassignRevenueEvents,
  // reassignSubscriberAccess, softDeleteSubscriberAsMerged all filter on
  // `subscriberId` / `id`) — the projectId is used only to stamp the
  // credit-ledger rows. It therefore CANNOT refuse a cross-project move;
  // the caller has to.
  //
  // Each of these describes state that cannot exist unless the data is
  // corrupt, and each one FAILS LOUDLY rather than skipping. Skipping
  // would spend the token, complete the session and answer
  // `200 { entitlements: [] }` — a buyer who paid, permanently stranded
  // with nothing, and no retry left to reach them. The 500 rolls the
  // claim back and keeps the token reclaimable.

  it("fails the claim rather than merging a subscriber from another project", async () => {
    subscriberRows.set("sub_synthetic", {
      id: "sub_synthetic",
      projectId: "proj_OTHER",
      rovenueId: "stripe:cus_1",
      deletedAt: null,
    });

    const res = await claim();

    expect(res.status).toBe(500);
    expect(reassignAllAssets).not.toHaveBeenCalled();
    // The claim never completed — the token is still reclaimable and no
    // "you're done" event went out against assets that never moved.
    expect(setSessionState).not.toHaveBeenCalled();
    expect(outboxInsert).not.toHaveBeenCalled();
  });

  it("fails the claim when the purchase row belongs to another project", async () => {
    findPurchaseBySession.mockResolvedValue({
      id: "pur_1",
      projectId: "proj_OTHER",
      sessionId: "sess_1",
      subscriberId: "sub_synthetic",
    });

    const res = await claim();

    expect(res.status).toBe(500);
    expect(reassignAllAssets).not.toHaveBeenCalled();
    expect(setSessionState).not.toHaveBeenCalled();
    expect(outboxInsert).not.toHaveBeenCalled();
  });

  it("fails the claim when the purchase points at a subscriber that is gone", async () => {
    subscriberRows.delete("sub_synthetic");

    const res = await claim();

    expect(res.status).toBe(500);
    expect(reassignAllAssets).not.toHaveBeenCalled();
    expect(setSessionState).not.toHaveBeenCalled();
  });

  it("fails the claim when the subscriber was merged into somebody else", async () => {
    // Re-merging a soft-deleted row would repoint its `mergedInto` at
    // this claimer and corrupt the chain `resolveSubscriberByRovenueId`
    // walks — while moving nothing, since its assets already left. And
    // the buyer's purchase is now on a third party's row, which is not
    // something to answer 200 to.
    subscriberRows.set("sub_synthetic", {
      id: "sub_synthetic",
      projectId: "proj_1",
      rovenueId: "stripe:cus_1",
      deletedAt: new Date(),
      mergedInto: "sub_somewhere_else",
    });

    const res = await claim();

    expect(res.status).toBe(500);
    expect(reassignAllAssets).not.toHaveBeenCalled();
    expect(setSessionState).not.toHaveBeenCalled();
  });

  it("stays silent when the subscriber was already merged into THIS claimer", async () => {
    // The one benign shape of the same check: an earlier claim already
    // put these assets exactly where this one wants them. That is
    // idempotency, and it must answer 200 with the real entitlements.
    subscriberRows.set("sub_synthetic", {
      id: "sub_synthetic",
      projectId: "proj_1",
      rovenueId: "stripe:cus_1",
      deletedAt: new Date(),
      mergedInto: "sub_installed",
    });
    grant("sub_installed", "acc_pro");

    const res = await claim();

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { entitlements: string[] } };
    expect(body.data.entitlements).toEqual(["pro"]);
    expect(reassignAllAssets).not.toHaveBeenCalled();
    expect(safeSyncAccessAfterMerge).not.toHaveBeenCalled();
  });

  it("still repoints the purchase when the subscriber was already merged into this claimer", async () => {
    // Idempotent for the assets does not mean idempotent for this
    // column: whatever merged the synthetic away — a transferSubscriber
    // or an identify — moved the access rows without touching
    // `funnel_purchases.subscriber_id`, so it is still on the row that
    // merge retired. This branch returns before the repoint below it, so
    // it has to do its own.
    subscriberRows.set("sub_synthetic", {
      id: "sub_synthetic",
      projectId: "proj_1",
      rovenueId: "stripe:cus_1",
      deletedAt: new Date(),
      mergedInto: "sub_installed",
    });

    const res = await claim();

    expect(res.status).toBe(200);
    expect(setPurchaseSubscriber).toHaveBeenCalledWith(
      txHandle,
      "pur_1",
      "sub_installed",
    );
  });

  // =============================================================
  // The claimer, judged post-lock
  // =============================================================
  //
  // The claimer is resolved at route level, on the pooled connection,
  // before the claim transaction opens. A concurrent identify or
  // transferSubscriber can merge it away inside that window.
  //
  // The advisory locks do NOT stop that on their own: transferSubscriber
  // and the receipt paths key on appUserId, and identify keys on
  // rovenueId but only ever locks the survivor, never the row it
  // soft-deletes. What holds the pair still is the `FOR UPDATE` row lock
  // on both re-reads, which blocks against the UPDATE whichever key the
  // other writer picked. Every guard below judges those re-read rows.

  it("fails the claim when the claimer was merged away before the lock", async () => {
    // The race, precisely: the route resolved a live claimer, and by the
    // time the lock is granted a concurrent merge has retired it. Using
    // the pre-lock row moves every asset onto a soft-deleted subscriber
    // and repoints the purchase at it, while
    // `resolveSubscriberByRovenueId` sends the SDK to the survivor — the
    // buyer ends up with nothing. This test passes ONLY if the claimer
    // is re-read after `advisoryXactLock2`.
    advisoryXactLock2.mockImplementation(async () => {
      world.timeline.push("lock");
      subscriberRows.set("sub_installed", {
        id: "sub_installed",
        projectId: "proj_1",
        rovenueId: "a1",
        deletedAt: new Date(),
        mergedInto: "sub_survivor",
      });
    });

    const res = await claim();

    expect(res.status).toBe(500);
    expect(reassignAllAssets).not.toHaveBeenCalled();
    expect(setPurchaseSubscriber).not.toHaveBeenCalled();
    // Nothing was spent: the token stays reclaimable, and the retry
    // resolves the survivor and merges onto that instead.
    expect(setSessionState).not.toHaveBeenCalled();
    expect(outboxInsert).not.toHaveBeenCalled();
  });

  it("fails the claim when the claimer is gone by the time the lock is held", async () => {
    advisoryXactLock2.mockImplementation(async () => {
      world.timeline.push("lock");
      subscriberRows.delete("sub_installed");
    });

    const res = await claim();

    expect(res.status).toBe(500);
    expect(reassignAllAssets).not.toHaveBeenCalled();
    expect(setSessionState).not.toHaveBeenCalled();
  });

  it("fails the claim when the claimer belongs to another project", async () => {
    // Same exposure as the source-side check: `reassignAllAssets` is
    // keyed on subscriber id alone and would happily move this project's
    // purchase onto another project's row.
    subscriberRows.set("sub_installed", {
      id: "sub_installed",
      projectId: "proj_OTHER",
      rovenueId: "a1",
      deletedAt: null,
    });

    const res = await claim();

    expect(res.status).toBe(500);
    expect(reassignAllAssets).not.toHaveBeenCalled();
    expect(setPurchaseSubscriber).not.toHaveBeenCalled();
    expect(setSessionState).not.toHaveBeenCalled();
  });

  it("reads the claimer under the lock, not before it", async () => {
    // The ordering the guards above depend on: a read taken before
    // `advisoryXactLock2` returns is a read of state a concurrent merge
    // can still change.
    await claim();

    const claimerRead = findSubscriberById.mock.calls.findIndex(
      (call) => call[1] === "sub_installed",
    );
    expect(claimerRead).toBeGreaterThanOrEqual(0);
    expect(
      findSubscriberById.mock.invocationCallOrder[claimerRead]!,
    ).toBeGreaterThan(advisoryXactLock2.mock.invocationCallOrder[0]!);
  });

  // =============================================================
  // Advisory locks
  // =============================================================

  it("holds both subscribers' advisory locks before moving anything", async () => {
    // `reassignAllAssets`'s docblock requires it: its credit block reads
    // the target balance and then INSERTs `toBal + balance` into an
    // append-only ledger, so a lost update there can never be repaired.
    // The keys are identify.ts's construction so a concurrent identify
    // queues on the same lock instead of a parallel scheme.
    await claim();

    expect(advisoryXactLock2).toHaveBeenCalledWith(
      txHandle,
      "proj_1:rov:a1",
      "proj_1:rov:stripe:cus_1",
    );
    expect(world.timeline.indexOf("lock")).toBeLessThan(
      world.timeline.indexOf("merge"),
    );
  });

  // =============================================================
  // The funnel purchase row
  // =============================================================

  it("repoints the funnel purchase at the claimer in the same transaction", async () => {
    // The merge soft-deletes the synthetic; a `funnel_purchases` row left
    // pointing at it sends every report that joins the column to a
    // retired subscriber.
    await claim();

    expect(setPurchaseSubscriber).toHaveBeenCalledWith(
      txHandle,
      "pur_1",
      "sub_installed",
    );
  });

  // =============================================================
  // The entitlements the merge moved
  // =============================================================

  it("returns the access the merge moved off the synthetic subscriber", async () => {
    // The whole point: everything the buyer paid for is on the synthetic
    // row and NOTHING is on the installed one. An empty answer here is
    // the bug.
    grant("sub_synthetic", "acc_pro");

    const body = (await (await claim()).json()) as {
      data: { entitlements: string[]; subscriber_id: string };
    };

    expect(body.data.entitlements).toEqual(["pro"]);
    expect(body.data.subscriber_id).toBe("sub_installed");
  });

  it("returns an empty array when there is no active access", async () => {
    const body = (await (await claim()).json()) as {
      data: { entitlements: string[] };
    };
    expect(body.data.entitlements).toEqual([]);
  });

  it("omits inactive and expired access rows", async () => {
    grant("sub_synthetic", "acc_pro");
    grant("sub_synthetic", "acc_legacy", { isActive: false });
    grant("sub_synthetic", "acc_lapsed", {
      expiresDate: new Date(Date.now() - 60_000),
    });
    grant("sub_synthetic", "acc_future", {
      expiresDate: new Date(Date.now() + 60_000),
    });

    const body = (await (await claim()).json()) as {
      data: { entitlements: string[] };
    };

    expect(body.data.entitlements).toEqual(["future", "pro"]);
  });

  it("reports each entitlement once when the merge leaves duplicate rows", async () => {
    // Both subscribers had access to the same thing; after the move the
    // survivor holds two rows for it until syncAccess collapses them.
    grant("sub_synthetic", "acc_pro");
    grant("sub_installed", "acc_pro");

    const body = (await (await claim()).json()) as {
      data: { entitlements: string[] };
    };

    expect(body.data.entitlements).toEqual(["pro"]);
  });

  // THE test the mocked-call-order version cannot make: this one fails
  // if the read runs on the transaction's connection, or before the
  // commit, even though the call ORDER is right in both cases.
  it("reads access on the pooled connection AFTER the transaction commits", async () => {
    grant("sub_synthetic", "acc_pro");

    const body = (await (await claim()).json()) as {
      data: { entitlements: string[] };
    };

    expect(world.timeline).toEqual(["lock", "merge", "commit", "read"]);
    expect(world.reads).toEqual([{ handle: dbHandle, afterCommit: true }]);
    // ...and the data proves it was not a read of pre-merge state.
    expect(body.data.entitlements).toEqual(["pro"]);
  });

  it("reconciles the survivor's denormalized access after the merge commits", async () => {
    await claim();

    expect(safeSyncAccessAfterMerge).toHaveBeenCalledWith("sub_installed");
    // After the commit — it opens its own transaction and would deadlock
    // against rows the claim transaction still holds.
    expect(world.timeline.indexOf("commit")).toBeLessThan(
      world.timeline.indexOf("read"),
    );
  });

  // =============================================================
  // Single use
  // =============================================================
  //
  // `tryClaim` is `UPDATE ... WHERE claimed_at IS NULL RETURNING`: exactly
  // one caller gets a row back. The merge sits after it INSIDE the same
  // transaction, so it inherits that guarantee — a replay never reaches
  // reassignAllAssets, and assets cannot be moved twice.

  it("does not move assets a second time when the token was already claimed", async () => {
    findByHash.mockResolvedValue({
      id: "tok_1",
      tokenHash: TOKEN_HASH,
      projectId: "proj_1",
      sessionId: "sess_1",
      expiresAt: new Date(Date.now() + 60_000),
      claimedAt: new Date(),
      claimedBySubscriberId: "sub_installed",
    });
    // The assets are already where the first claim put them.
    grant("sub_installed", "acc_pro");

    const res = await claim();

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { entitlements: string[] } };
    // Still answered honestly...
    expect(body.data.entitlements).toEqual(["pro"]);
    // ...without touching anything.
    expect(reassignAllAssets).not.toHaveBeenCalled();
    expect(transaction).not.toHaveBeenCalled();
  });

  it("does not merge for the caller that loses the tryClaim race", async () => {
    // Another device won the UPDATE between our read and our write.
    tryClaim.mockResolvedValue(null);

    const res = await claim();

    expect(res.status).toBe(409);
    expect(reassignAllAssets).not.toHaveBeenCalled();
    expect(safeSyncAccessAfterMerge).not.toHaveBeenCalled();
  });

  it("409s a different subscriber trying to claim an already-claimed token", async () => {
    findByHash.mockResolvedValue({
      id: "tok_1",
      tokenHash: TOKEN_HASH,
      projectId: "proj_1",
      sessionId: "sess_1",
      expiresAt: new Date(Date.now() + 60_000),
      claimedAt: new Date(),
      claimedBySubscriberId: "sub_someone_else",
    });

    const res = await claim();

    expect(res.status).toBe(409);
    expect(reassignAllAssets).not.toHaveBeenCalled();
  });

  it("aborts the claim when the merge fails, leaving the token reclaimable", async () => {
    // Inside the transaction on purpose: a merge that cannot complete
    // must not leave a claimed token whose assets never moved.
    reassignAllAssets.mockRejectedValue(new Error("deadlock detected"));

    const res = await claim();

    expect(res.status).toBe(500);
    // The claim never completed, so nothing downstream of it ran.
    expect(safeSyncAccessAfterMerge).not.toHaveBeenCalled();
    expect(findActiveAccess).not.toHaveBeenCalled();
  });

  it("rejects a token issued to a different project", async () => {
    findByHash.mockResolvedValue({
      id: "tok_1",
      tokenHash: TOKEN_HASH,
      projectId: "proj_OTHER",
      sessionId: "sess_1",
      expiresAt: new Date(Date.now() + 60_000),
      claimedAt: null,
      claimedBySubscriberId: null,
    });

    const res = await claim();

    expect(res.status).toBe(404);
    expect(reassignAllAssets).not.toHaveBeenCalled();
  });
});
