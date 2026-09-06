process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { RETENTION_POLICIES } from "@rovenue/shared/retention";
import { getDb } from "../client";
import {
  copilotMessages,
  copilotThreads,
  outgoingWebhooks,
  projects,
  subscribers,
  user,
  webhookEvents,
} from "../schema";
import { deleteRetentionRowsOlderThan } from "./retention-rows";

// Against the ambient Postgres. This is the only code in the retention
// sweep that can destroy data, and it had never once run against a real
// database before this test existed — every other test in this feature
// mocks it. The assertion that matters most here is the tenant one: a
// missing project predicate does not fail loudly, it just deletes
// everyone's rows using whichever project's window got there first.

const RUN_ID = Date.now();
const PROJECT_ID = `prj_ret_${RUN_ID}`;
const OTHER_PROJECT_ID = `prj_ret_other_${RUN_ID}`;
const USER_ID = `usr_ret_${RUN_ID}`;

const TEST_BATCH_SIZE = 100;
const TEST_MAX_BATCHES = 5;

// A fixed reference point, not "now" — keeps OLD unambiguously before
// and NEW unambiguously after the cutoff regardless of when this runs.
const CUTOFF = new Date("2026-01-01T00:00:00.000Z");
const OLD = new Date(CUTOFF.getTime() - 24 * 60 * 60 * 1000);
const NEW = new Date(CUTOFF.getTime() + 24 * 60 * 60 * 1000);

const outgoingWebhooksPolicy = RETENTION_POLICIES.find(
  (p) => p.table === "outgoing_webhooks",
)!;
const webhookEventsPolicy = RETENTION_POLICIES.find(
  (p) => p.table === "webhook_events",
)!;
const copilotMessagesPolicy = RETENTION_POLICIES.find(
  (p) => p.table === "copilot_messages",
)!;

async function cleanup(): Promise<void> {
  const db = getDb();
  await db.delete(copilotMessages);
  await db.delete(copilotThreads);
  await db.delete(outgoingWebhooks);
  await db.delete(webhookEvents);
  await db.delete(subscribers).where(eq(subscribers.projectId, PROJECT_ID));
  await db
    .delete(subscribers)
    .where(eq(subscribers.projectId, OTHER_PROJECT_ID));
}

describe("deleteRetentionRowsOlderThan", () => {
  beforeAll(async () => {
    const db = getDb();
    await db.insert(projects).values([
      { id: PROJECT_ID, name: `RET ${RUN_ID}` },
      { id: OTHER_PROJECT_ID, name: `RET other ${RUN_ID}` },
    ]);
    await db.insert(user).values({
      id: USER_ID,
      name: "Retention Test",
      email: `ret-${RUN_ID}@example.test`,
      emailVerified: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  });

  afterAll(async () => {
    const db = getDb();
    await cleanup();
    await db.delete(projects).where(eq(projects.id, PROJECT_ID));
    await db.delete(projects).where(eq(projects.id, OTHER_PROJECT_ID));
    await db.delete(user).where(eq(user.id, USER_ID));
  });

  it("deletes only terminal rows past the cutoff, and only for the given project", async () => {
    await cleanup();
    const db = getDb();

    const mySub = `sub_ret_mine_${RUN_ID}`;
    const otherSub = `sub_ret_other_${RUN_ID}`;
    await db.insert(subscribers).values([
      { id: mySub, projectId: PROJECT_ID, rovenueId: mySub },
      { id: otherSub, projectId: OTHER_PROJECT_ID, rovenueId: otherSub },
    ]);

    const oldTerminalMine = `whk_old_terminal_mine_${RUN_ID}`;
    const newTerminalMine = `whk_new_terminal_mine_${RUN_ID}`;
    const oldNonTerminalMine = `whk_old_nonterminal_mine_${RUN_ID}`;
    const oldTerminalOther = `whk_old_terminal_other_${RUN_ID}`;

    await db.insert(outgoingWebhooks).values([
      {
        id: oldTerminalMine,
        projectId: PROJECT_ID,
        eventType: "test",
        subscriberId: mySub,
        payload: {},
        url: "https://example.test/hook",
        status: "SENT",
        createdAt: OLD,
      },
      {
        id: newTerminalMine,
        projectId: PROJECT_ID,
        eventType: "test",
        subscriberId: mySub,
        payload: {},
        url: "https://example.test/hook",
        status: "SENT",
        createdAt: NEW,
      },
      {
        // Non-terminal (PENDING) and old: the terminalStatuses
        // restriction must protect this row however old it is — an
        // age-only delete would destroy a webhook still owed a
        // delivery attempt.
        id: oldNonTerminalMine,
        projectId: PROJECT_ID,
        eventType: "test",
        subscriberId: mySub,
        payload: {},
        url: "https://example.test/hook",
        status: "PENDING",
        createdAt: OLD,
      },
      {
        // Same age and status as the row that SHOULD be deleted, but a
        // different project. This is the assertion that would have
        // caught a missing tenant predicate.
        id: oldTerminalOther,
        projectId: OTHER_PROJECT_ID,
        eventType: "test",
        subscriberId: otherSub,
        payload: {},
        url: "https://example.test/hook",
        status: "SENT",
        createdAt: OLD,
      },
    ]);

    const result = await deleteRetentionRowsOlderThan(
      db,
      "outgoing_webhooks",
      outgoingWebhooksPolicy.timestampColumn,
      PROJECT_ID,
      CUTOFF,
      outgoingWebhooksPolicy.terminalStatuses,
      TEST_BATCH_SIZE,
      TEST_MAX_BATCHES,
    );

    expect(result).toEqual({ deleted: 1, hitBatchCap: false });

    const remainingIds = (
      await db
        .select({ id: outgoingWebhooks.id })
        .from(outgoingWebhooks)
    ).map((r) => r.id);

    expect(remainingIds).not.toContain(oldTerminalMine);
    expect(remainingIds).toContain(newTerminalMine);
    expect(remainingIds).toContain(oldNonTerminalMine);
    expect(remainingIds).toContain(oldTerminalOther);
  });

  it("scopes webhook_events (a table with no terminalStatuses) to the given project", async () => {
    await cleanup();
    const db = getDb();

    const oldMine = `evt_old_mine_${RUN_ID}`;
    const newMine = `evt_new_mine_${RUN_ID}`;
    const oldOther = `evt_old_other_${RUN_ID}`;

    await db.insert(webhookEvents).values([
      {
        id: oldMine,
        projectId: PROJECT_ID,
        source: "APPLE",
        eventType: "TEST",
        storeEventId: `store_${oldMine}`,
        payload: {},
        createdAt: OLD,
      },
      {
        id: newMine,
        projectId: PROJECT_ID,
        source: "APPLE",
        eventType: "TEST",
        storeEventId: `store_${newMine}`,
        payload: {},
        createdAt: NEW,
      },
      {
        id: oldOther,
        projectId: OTHER_PROJECT_ID,
        source: "APPLE",
        eventType: "TEST",
        storeEventId: `store_${oldOther}`,
        payload: {},
        createdAt: OLD,
      },
    ]);

    const result = await deleteRetentionRowsOlderThan(
      db,
      "webhook_events",
      webhookEventsPolicy.timestampColumn,
      PROJECT_ID,
      CUTOFF,
      webhookEventsPolicy.terminalStatuses,
      TEST_BATCH_SIZE,
      TEST_MAX_BATCHES,
    );

    expect(result).toEqual({ deleted: 1, hitBatchCap: false });

    const remainingIds = (
      await db.select({ id: webhookEvents.id }).from(webhookEvents)
    ).map((r) => r.id);

    expect(remainingIds).not.toContain(oldMine);
    expect(remainingIds).toContain(newMine);
    expect(remainingIds).toContain(oldOther);
  });

  it("scopes copilot_messages to the given project through copilot_threads (no projectId column of its own)", async () => {
    await cleanup();
    const db = getDb();

    const myThread = `thr_mine_${RUN_ID}`;
    const otherThread = `thr_other_${RUN_ID}`;
    await db.insert(copilotThreads).values([
      {
        id: myThread,
        projectId: PROJECT_ID,
        userId: USER_ID,
        title: "mine",
        provider: "anthropic",
        model: "test-model",
      },
      {
        id: otherThread,
        projectId: OTHER_PROJECT_ID,
        userId: USER_ID,
        title: "other",
        provider: "anthropic",
        model: "test-model",
      },
    ]);

    const oldMine = `msg_old_mine_${RUN_ID}`;
    const newMine = `msg_new_mine_${RUN_ID}`;
    const oldOther = `msg_old_other_${RUN_ID}`;

    await db.insert(copilotMessages).values([
      {
        id: oldMine,
        threadId: myThread,
        role: "user",
        parts: [],
        createdAt: OLD,
      },
      {
        id: newMine,
        threadId: myThread,
        role: "user",
        parts: [],
        createdAt: NEW,
      },
      {
        // Same age, but its thread belongs to the OTHER project. This
        // is the join-based tenant scoping this table needs, since it
        // has no projectId column of its own.
        id: oldOther,
        threadId: otherThread,
        role: "user",
        parts: [],
        createdAt: OLD,
      },
    ]);

    const result = await deleteRetentionRowsOlderThan(
      db,
      "copilot_messages",
      copilotMessagesPolicy.timestampColumn,
      PROJECT_ID,
      CUTOFF,
      copilotMessagesPolicy.terminalStatuses,
      TEST_BATCH_SIZE,
      TEST_MAX_BATCHES,
    );

    expect(result).toEqual({ deleted: 1, hitBatchCap: false });

    const remainingIds = (
      await db.select({ id: copilotMessages.id }).from(copilotMessages)
    ).map((r) => r.id);

    expect(remainingIds).not.toContain(oldMine);
    expect(remainingIds).toContain(newMine);
    expect(remainingIds).toContain(oldOther);
  });
});
