// =============================================================
// action_paywall_editTree — persistence integration test (Task 5)
// =============================================================
//
// Real Postgres (same dev stack as the sibling
// `paywalls.concurrency.integration.test.ts` — `getDb()` against the
// docker-compose Postgres on host port 5433). The handler used to be a
// dry run: it validated the proposed op and returned it unapplied. As
// of this task it is the SOLE writer for an approved
// `action_paywall_editTree` intent — it must persist the resulting
// draft and bump `draftRevision`, with the audit row committed in the
// SAME transaction as the write.
//
// A mocked transaction (see `intent-handlers.project-scope.test.ts`) can
// assert "updatePaywallDraft was/was not called", but it cannot prove
// atomicity — a stubbed `db.transaction` just invokes its callback and
// can't demonstrate a real rollback.
//
// Two distinct failure shapes are exercised below, and it matters which
// is which:
//   - "a rejected op leaves no audit row" fails INSIDE `applyTreeOp`,
//     before the handler ever issues a write to `paywalls` — a real
//     Postgres isn't actually load-bearing for this one (a mock could
//     show it too), but it's cheap and it's the brief's original case.
//   - "a lost draftRevision CAS race leaves no audit row" is the one
//     that needs real Postgres: two concurrent `executeIntent` calls
//     race the SAME `updatePaywallDraft` UPDATE (mirrors the HTTP-level
//     race in `paywalls.concurrency.integration.test.ts`), so the
//     LOSER's write is genuinely attempted and genuinely fails its
//     `WHERE draftRevision = $expected` — a per-statement snapshot under
//     Postgres's READ COMMITTED default sees the winner's already-committed
//     bump. That failure happens AFTER `updatePaywallDraft` runs, so it's
//     the one that actually demonstrates "the write and its audit row
//     commit or roll back together" rather than "a validation error
//     short-circuits before either exists."
// =============================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle, getDb, projects } from "@rovenue/db";
import type { BuilderConfig, PaywallTreeOp } from "@rovenue/shared/paywall";
import { emptyBuilderConfig } from "@rovenue/shared/paywall";
import { executeIntent } from "./intent-executor";
import { registerAllIntentHandlers } from "./intent-handlers";
import { BUILDER_CONFIG_TREE_FORMAT_VERSION } from "../paywall-ai/validate-config";

const RUN_ID = Date.now();
let seedCounter = 0;

const INSERT_TEXT_NODE_OP: PaywallTreeOp = {
  kind: "insert",
  parentId: "root",
  index: 0,
  subtree: { type: "text", id: "new_text", key: "new_text_key", role: "body" },
};

// "root" is the only node id `emptyBuilderConfig` creates — this id is
// guaranteed absent, so `applyTreeOp` throws a `TreeOpError` before the
// handler ever reaches its write.
const OP_TARGETING_A_MISSING_NODE: PaywallTreeOp = {
  kind: "remove",
  nodeId: "does_not_exist",
};

beforeAll(() => {
  // HANDLERS is a module-level Map; registering twice (once here, once
  // if apps/api's boot path already ran) is idempotent via .set().
  registerAllIntentHandlers();
});

const seededProjectIds: string[] = [];

afterAll(async () => {
  const db = getDb();
  for (const id of seededProjectIds) {
    await db.delete(projects).where(eq(projects.id, id));
  }
});

/** A fresh project + offering + paywall with NO draft yet
 *  (`builderConfig: null`, `draftRevision` at its column default 0) —
 *  `resolvePaywallDraftConfig` falls back to `emptyBuilderConfig("en")`
 *  for it, whose root is `{ type: "stack", id: "root", children: [] }`. */
async function seedPaywallWithDraft(): Promise<{
  projectId: string;
  userId: string;
  paywallId: string;
}> {
  const suffix = `${RUN_ID}_${seedCounter++}`;
  const db = getDb();

  const projectId = `prj_edittree_${suffix}`;
  await db.insert(projects).values({
    id: projectId,
    name: `EditTree Persist Test ${suffix}`,
  });
  seededProjectIds.push(projectId);

  const [offering] = await db
    .insert(drizzle.schema.offerings)
    .values({
      projectId,
      identifier: `off_edittree_${suffix}`,
    })
    .returning();

  const [paywall] = await db
    .insert(drizzle.schema.paywalls)
    .values({
      projectId,
      identifier: `pw_edittree_${suffix}`,
      name: "EditTree Persist Test Paywall",
      offeringId: offering!.id,
      remoteConfig: { defaultLocale: "en" },
      builderConfig: null,
    })
    .returning();

  return {
    projectId,
    userId: `user_edittree_${suffix}`,
    paywallId: paywall!.id,
  };
}

async function countAuditRows(projectId: string): Promise<number> {
  const rows = await getDb()
    .select()
    .from(drizzle.schema.auditLogs)
    .where(eq(drizzle.schema.auditLogs.projectId, projectId));
  return rows.length;
}

describe("action_paywall_editTree — persistence (Task 5)", () => {
  it("executing a paywall edit intent persists the new draft — the inserted node, at the right position, with the format version bumped", async () => {
    const { projectId, userId, paywallId } = await seedPaywallWithDraft();

    const result = await executeIntent({
      ctx: { projectId, userId, role: "OWNER" },
      intent: {
        id: "i1",
        toolName: "action_paywall_editTree",
        payload: { paywallId, op: INSERT_TEXT_NODE_OP },
      },
    });

    expect(result).toEqual({ paywallId, draftRevision: 1 });

    const after = await drizzle.paywallRepo.findPaywallById(
      drizzle.db,
      projectId,
      paywallId,
    );
    expect(after?.draftRevision).toBe(1);
    // A tree op always yields a tree, never the legacy empty shape — this
    // paywall started with `builderConfig: null` / format version 1.
    expect(after?.configFormatVersion).toBe(BUILDER_CONFIG_TREE_FORMAT_VERSION);
    // The real assertion: the exact node landed under "root" at index 0,
    // not just "the draft differs from EMPTY_DRAFT somehow" (which would
    // pass for ANY differing value, including a corrupted one).
    const builderConfig = after?.builderConfig as BuilderConfig;
    expect(builderConfig.root.type).toBe("stack");
    expect(builderConfig.root.children[0]).toEqual({
      type: "text",
      id: "new_text",
      key: "new_text_key",
      role: "body",
    });
    expect(builderConfig.root.children).toHaveLength(1);
  });

  it("a rejected op (fails before any write is attempted) leaves no audit row", async () => {
    // `OP_TARGETING_A_MISSING_NODE` throws inside `applyTreeOp`, before
    // `updatePaywallDraft` or `audit()` are ever reached — this shows a
    // rejected OP writes nothing, not that a rejected WRITE rolls back
    // atomically with its audit row (see the CAS-race test below for that).
    const { projectId, userId, paywallId } = await seedPaywallWithDraft();
    const before = await countAuditRows(projectId);

    await expect(
      executeIntent({
        ctx: { projectId, userId, role: "OWNER" },
        intent: {
          id: "i2",
          toolName: "action_paywall_editTree",
          payload: { paywallId, op: OP_TARGETING_A_MISSING_NODE },
        },
      }),
    ).rejects.toThrow();

    expect(await countAuditRows(projectId)).toBe(before);
    const after = await drizzle.paywallRepo.findPaywallById(drizzle.db, projectId, paywallId);
    expect(after?.draftRevision).toBe(0);
  });

  it("a paywall edit that loses the draftRevision CAS race leaves no audit row, even though its write was genuinely attempted", async () => {
    // A racing connection holds a REAL, uncommitted write to the same row
    // open — via `updatePaywallDraft`, the exact function under test —
    // so the handler's own `findPaywallById` still reads draftRevision=0
    // (Postgres readers don't block on a pending writer under READ
    // COMMITTED), but its later `updatePaywallDraft` UPDATE has to queue
    // behind the racer's row lock. Releasing the racer AFTER the handler
    // has started (so its read is guaranteed stale) and letting it COMMIT
    // makes the handler's queued UPDATE re-evaluate `WHERE draftRevision =
    // 0` against the now-actual value (1) the moment it is finally allowed
    // to run — matching zero rows for a REAL reason (an actual concurrent
    // committed write), not a stub. `updatePaywallDraft` returns null, the
    // handler throws before ever calling `audit()`, and the whole
    // transaction (including the failed UPDATE) rolls back.
    //
    // This is a real-Postgres-only proof: a mocked `db.transaction` can
    // return `null` from a stubbed `updatePaywallDraft`, but it cannot
    // demonstrate that the null came from an ACTUAL row-level conflict, or
    // that the surrounding transaction genuinely rolled back rather than
    // the mock merely being told to.
    const { projectId, userId, paywallId } = await seedPaywallWithDraft();
    const before = await countAuditRows(projectId);

    let releaseRacer!: () => void;
    const holdRacerOpen = new Promise<void>((resolve) => {
      releaseRacer = resolve;
    });

    const racerPromise = getDb().transaction(async (racerTx) => {
      const racerWrite = await drizzle.paywallRepo.updatePaywallDraft(
        racerTx,
        projectId,
        paywallId,
        0,
        {
          builderConfig: emptyBuilderConfig("en"),
          configFormatVersion: BUILDER_CONFIG_TREE_FORMAT_VERSION,
        },
      );
      // Sanity: the racer's own write must land (revision 0 → 1) for the
      // rest of this test to mean anything.
      if (!racerWrite) throw new Error("racer setup failed: draftRevision was not 0");
      // Hold the row lock — do NOT commit — until the test releases it.
      await holdRacerOpen;
    });

    // The handler's `findPaywallById` runs against the CURRENT committed
    // value regardless of the racer's still-open transaction (a read never
    // blocks on a pending writer), so it is guaranteed to see
    // draftRevision=0 as long as it starts before the racer COMMITS —
    // which is guaranteed here, since we only release the racer below,
    // strictly after starting the handler.
    const handlerPromise = executeIntent({
      ctx: { projectId, userId, role: "OWNER" },
      intent: {
        id: "i3",
        toolName: "action_paywall_editTree",
        payload: { paywallId, op: INSERT_TEXT_NODE_OP },
      },
    });

    // Give the handler real wall-clock time to finish its (lock-free)
    // SELECT and validation and reach its own UPDATE, which then queues
    // behind the racer's row lock. This bound is generous for a local
    // Postgres round trip; it does not need to be exact — Postgres's row
    // lock is what actually enforces the ordering that matters (the
    // handler's UPDATE cannot complete before the racer's commits), this
    // delay only protects the PRECONDITION that the handler's SELECT ran
    // before that commit.
    await new Promise((resolve) => setTimeout(resolve, 100));
    releaseRacer();
    await racerPromise;

    await expect(handlerPromise).rejects.toThrow(/draft changed during approval/);

    // Only the racer's write landed: draftRevision moved by exactly 1,
    // not 2 — a double-write would mean the handler didn't actually lose.
    const after = await drizzle.paywallRepo.findPaywallById(drizzle.db, projectId, paywallId);
    expect(after?.draftRevision).toBe(1);

    // No audit row for the handler's failed, but genuinely ATTEMPTED,
    // write — only the racer's own direct `updatePaywallDraft` call ran
    // here, and that call never goes through the intent handler's audit
    // step at all, so the count must be completely unchanged.
    expect(await countAuditRows(projectId)).toBe(before);
  });
});
