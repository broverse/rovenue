// =============================================================
// Experiment scheduler — integration test (real Postgres + Redis)
// =============================================================
//
// Runs against dev Postgres (docker-compose host port 5433, per-worker
// database — see apps/api/tests/setup.ts / global-setup.ts) the same way
// notification-delivery-claim.integration.test.ts does: the conditional
// UPDATE ... RETURNING claim semantics need a real database, not a mock.
//
// Proves (plan Task 9 / spec §4.5):
//   1. a scheduled start fires
//   2. two concurrent sweeps cannot both start the same experiment
//   3. a chain advances only once its predecessor reaches COMPLETED
//   4. a cycle is rejected at write time (assertNoScheduleCycle)
//   5. autoWinnerOnStop = false stops without a winner
//   6. blocked-successor surfacing (OVERDUE / PREDECESSOR_DELETED)
//
// No ClickHouse/Kafka dependency: every case here uses autoWinnerOnStop =
// false (or none at all), which never calls computeExperimentResults, so
// this file does not need CONTAINER_SUITES registration — same rationale
// as the other real-Postgres-only workers/*.integration.test.ts files.

import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import {
  ExperimentStatus,
  ExperimentType,
  drizzle,
  getDb,
  projects,
} from "@rovenue/db";
import {
  assertNoScheduleCycle,
  computeSchedulingBlocked,
} from "../services/experiment-create";
import { audit } from "../lib/audit";
import { runExperimentSchedulerSweep } from "./experiment-scheduler";

const db = getDb();
const RUN_ID = Date.now();
const createdProjectIds: string[] = [];

async function seedProject(): Promise<string> {
  const id = `prj_expsched_${RUN_ID}_${createId()}`;
  await db.insert(projects).values({ id, name: `Exp Scheduler Project ${id}` });
  createdProjectIds.push(id);
  return id;
}

async function seedAudience(projectId: string): Promise<string> {
  const audience = await drizzle.audienceRepo.createAudience(db, {
    projectId,
    name: "Everyone",
    rules: {},
  });
  return audience.id;
}

const FLAG_VARIANTS = [
  { id: "a", name: "A", value: true, weight: 0.5 },
  { id: "b", name: "B", value: false, weight: 0.5 },
];

async function seedExperiment(
  projectId: string,
  audienceId: string,
  overrides: Partial<Parameters<typeof drizzle.experimentRepo.createExperiment>[1]> = {},
) {
  const key = drizzle.experimentRepo.generateExperimentKey();
  return drizzle.experimentRepo.createExperiment(db, {
    projectId,
    name: "Scheduler test experiment",
    type: ExperimentType.FLAG,
    key,
    audienceId,
    status: ExperimentStatus.DRAFT,
    variants: FLAG_VARIANTS,
    ...overrides,
  });
}

async function readAuditActions(resourceId: string): Promise<string[]> {
  const rows = await db
    .select({ action: drizzle.schema.auditLogs.action })
    .from(drizzle.schema.auditLogs)
    .where(eq(drizzle.schema.auditLogs.resourceId, resourceId));
  return rows.map((r) => r.action);
}

afterAll(async () => {
  // Cascades: projects -> audiences / experiments; experiments -> nothing
  // else seeded here. audit_logs.projectId is ON DELETE SET NULL, so those
  // rows survive as orphans, which is fine — nothing re-reads them by
  // project after this file's projects are gone.
  for (const id of createdProjectIds) {
    await db.delete(projects).where(eq(projects.id, id));
  }
});

describe("runExperimentSchedulerSweep", () => {
  it("(1) a scheduled start fires", async () => {
    const projectId = await seedProject();
    const audienceId = await seedAudience(projectId);
    const past = new Date(Date.now() - 60_000);
    const exp = await seedExperiment(projectId, audienceId, {
      scheduledStartAt: past,
    });

    const result = await runExperimentSchedulerSweep(new Date());
    expect(result.started).toBeGreaterThanOrEqual(1);

    const after = await drizzle.experimentRepo.findExperimentById(db, exp.id);
    expect(after?.status).toBe("RUNNING");
    expect(after?.startedAt).not.toBeNull();

    const actions = await readAuditActions(exp.id);
    expect(actions).toContain("experiment.started");

    const auditRow = await db
      .select({ userId: drizzle.schema.auditLogs.userId })
      .from(drizzle.schema.auditLogs)
      .where(eq(drizzle.schema.auditLogs.resourceId, exp.id));
    expect(auditRow.some((r) => r.userId === "system")).toBe(true);
  });

  it("(2) two concurrent sweeps cannot both start the same experiment", async () => {
    const projectId = await seedProject();
    const audienceId = await seedAudience(projectId);
    const past = new Date(Date.now() - 60_000);
    const exp = await seedExperiment(projectId, audienceId, {
      scheduledStartAt: past,
    });
    const now = new Date();

    const [r1, r2] = await Promise.all([
      runExperimentSchedulerSweep(now),
      runExperimentSchedulerSweep(now),
    ]);

    // Exactly one of the two overlapping sweeps won the claim for THIS
    // experiment — assert on the durable result (one "experiment.started"
    // audit row), not on which of r1/r2 happened to report the start,
    // since either sweep could also be picking up unrelated candidates
    // from other tests running in the same worker database.
    const actions = await readAuditActions(exp.id);
    expect(actions.filter((a) => a === "experiment.started")).toHaveLength(1);

    const after = await drizzle.experimentRepo.findExperimentById(db, exp.id);
    expect(after?.status).toBe("RUNNING");
    expect(r1.started + r2.started).toBeGreaterThanOrEqual(1);
  });

  it("(3) a chain advances only once the predecessor reaches COMPLETED", async () => {
    const projectId = await seedProject();
    const audienceId = await seedAudience(projectId);
    const past = new Date(Date.now() - 60_000);

    const predecessor = await seedExperiment(projectId, audienceId, {
      status: ExperimentStatus.RUNNING,
    });
    const successor = await seedExperiment(projectId, audienceId, {
      scheduledStartAt: past,
      startAfterExperimentId: predecessor.id,
    });

    // Predecessor still RUNNING — successor must NOT start even though its
    // own scheduledStartAt is due.
    await runExperimentSchedulerSweep(new Date());
    let after = await drizzle.experimentRepo.findExperimentById(db, successor.id);
    expect(after?.status).toBe("DRAFT");

    // Predecessor completes.
    await drizzle.experimentRepo.updateExperiment(db, predecessor.id, {
      status: ExperimentStatus.COMPLETED,
      completedAt: new Date(),
    });

    await runExperimentSchedulerSweep(new Date());
    after = await drizzle.experimentRepo.findExperimentById(db, successor.id);
    expect(after?.status).toBe("RUNNING");
  });

  it("(4) a cycle is rejected at write time", async () => {
    const projectId = await seedProject();
    const audienceId = await seedAudience(projectId);

    const a = await seedExperiment(projectId, audienceId);
    const b = await seedExperiment(projectId, audienceId, {
      startAfterExperimentId: a.id, // B after A
    });

    // Proposing "A after B" would close the loop A -> B -> A.
    await expect(
      assertNoScheduleCycle(db, projectId, a.id, b.id),
    ).rejects.toMatchObject({ status: 400 });

    // Self-reference is rejected too, independent of any existing chain.
    await expect(
      assertNoScheduleCycle(db, projectId, a.id, a.id),
    ).rejects.toMatchObject({ status: 400 });

    // A genuinely acyclic assignment is accepted (no throw).
    const c = await seedExperiment(projectId, audienceId);
    await expect(
      assertNoScheduleCycle(db, projectId, c.id, b.id), // C after B after A — fine
    ).resolves.toBeUndefined();
  });

  it("(5) autoWinnerOnStop = false stops without a winner", async () => {
    const projectId = await seedProject();
    const audienceId = await seedAudience(projectId);
    const past = new Date(Date.now() - 60_000);
    const exp = await seedExperiment(projectId, audienceId, {
      status: ExperimentStatus.RUNNING,
      scheduledEndAt: past,
      autoWinnerOnStop: false,
    });

    const result = await runExperimentSchedulerSweep(new Date());
    expect(result.stopped).toBeGreaterThanOrEqual(1);

    const after = await drizzle.experimentRepo.findExperimentById(db, exp.id);
    expect(after?.status).toBe("COMPLETED");
    expect(after?.winnerVariantId).toBeNull();

    const actions = await readAuditActions(exp.id);
    expect(actions).toContain("experiment.stopped");
  });

  it("(6a) blocked: OVERDUE — waited past scheduledStartAt beyond the grace period", async () => {
    const projectId = await seedProject();
    const audienceId = await seedAudience(projectId);
    const wayPast = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000);
    const exp = await seedExperiment(projectId, audienceId, {
      scheduledStartAt: wayPast,
      // Chained after a predecessor that never completes, so the
      // scheduler's claim never fires for it despite being "due".
      startAfterExperimentId: (
        await seedExperiment(projectId, audienceId, { status: ExperimentStatus.RUNNING })
      ).id,
    });

    const { blocked, reason } = await computeSchedulingBlocked(db, exp);
    expect(blocked).toBe(true);
    expect(reason).toBe("OVERDUE");
  });

  it("(6b) blocked: PREDECESSOR_DELETED — durable marker survives the FK's SET NULL", async () => {
    const projectId = await seedProject();
    const audienceId = await seedAudience(projectId);
    const successor = await seedExperiment(projectId, audienceId);

    // Simulate what the DELETE route does before removing the predecessor:
    // write the durable marker (the FK itself would null the column at
    // delete time with no application hook, so this is the only record).
    await audit({
      projectId,
      userId: "u_deleter",
      action: "experiment.predecessor_deleted",
      resource: "experiment",
      resourceId: successor.id,
      before: { startAfterExperimentId: "some-deleted-id" },
      after: { startAfterExperimentId: null },
    });

    const after = await drizzle.experimentRepo.findExperimentById(db, successor.id);
    expect(after).not.toBeNull();
    const { blocked, reason } = await computeSchedulingBlocked(db, after!);
    expect(blocked).toBe(true);
    expect(reason).toBe("PREDECESSOR_DELETED");
  });
});
