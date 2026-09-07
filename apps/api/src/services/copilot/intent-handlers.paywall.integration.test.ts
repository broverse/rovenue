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
// A mocked transaction (see `intent-handlers.project-scope.test.ts`)
// can assert "updatePaywall was/was not called", but it cannot prove
// atomicity — a stubbed `db.transaction` just invokes its callback and
// can't demonstrate a real rollback. Only real Postgres can show that a
// rejected write leaves the audit table untouched.
// =============================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle, getDb, projects } from "@rovenue/db";
import type { PaywallTreeOp } from "@rovenue/shared/paywall";
import { emptyBuilderConfig } from "@rovenue/shared/paywall";
import { executeIntent } from "./intent-executor";
import { registerAllIntentHandlers } from "./intent-handlers";

const RUN_ID = Date.now();
let seedCounter = 0;

// The draft `resolvePaywallDraftConfig` falls back to when
// `paywalls.builderConfig` is null — the pre-edit baseline every
// seeded paywall in this file starts from.
const EMPTY_DRAFT = emptyBuilderConfig("en");

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
 *  for it, matching `EMPTY_DRAFT` above. */
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
  it("executing a paywall edit intent persists the new draft", async () => {
    const { projectId, userId, paywallId } = await seedPaywallWithDraft();

    await executeIntent({
      ctx: { projectId, userId },
      intent: {
        id: "i1",
        toolName: "action_paywall_editTree",
        payload: { paywallId, op: INSERT_TEXT_NODE_OP },
      },
    });

    const after = await drizzle.paywallRepo.findPaywallById(
      drizzle.db,
      projectId,
      paywallId,
    );
    // The dry-run handler left the draft untouched; this must not.
    expect(after?.builderConfig).not.toEqual(EMPTY_DRAFT);
    expect(after?.draftRevision).toBe(1);
  });

  it("a failed paywall edit leaves no audit row", async () => {
    // audit() runs inside the handler's transaction, so a rejected write
    // must roll the audit row back with it. A mocked transaction cannot
    // demonstrate this — hence real Postgres.
    const { projectId, userId, paywallId } = await seedPaywallWithDraft();
    const before = await countAuditRows(projectId);

    await expect(
      executeIntent({
        ctx: { projectId, userId },
        intent: {
          id: "i2",
          toolName: "action_paywall_editTree",
          payload: { paywallId, op: OP_TARGETING_A_MISSING_NODE },
        },
      }),
    ).rejects.toThrow();

    expect(await countAuditRows(projectId)).toBe(before);
  });
});
