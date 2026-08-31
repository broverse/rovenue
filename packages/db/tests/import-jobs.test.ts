// =============================================================
// import_jobs repo — integration tests (real Postgres)
// =============================================================
//
// Requires: DATABASE_URL pointing at a live Postgres 16 instance
// (the docker-compose dev stack on host port 5433 satisfies this).

import { createId } from "@paralleldrive/cuid2";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import * as schema from "../src/drizzle/schema";
import {
  createImportJob,
  getImportJob,
  incrementImportJobCounters,
  listImportJobs,
  saveImportJobCheckpoint,
  setImportJobStatus,
  updateImportJobMapping,
} from "../src/drizzle/repositories/import-jobs";

// ---------------------------------------------------------------------------
// Env bootstrap (mirrors apps/api/tests/setup.ts approach)
// ---------------------------------------------------------------------------
process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

// ---------------------------------------------------------------------------
// DB connection owned by this test file
// ---------------------------------------------------------------------------

let pool: Pool;
let db: ReturnType<typeof drizzleClient<typeof schema>>;

beforeAll(() => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  db = drizzleClient(pool, { schema });
});

afterAll(async () => {
  await pool.end();
});

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

async function seedProject(name = "Test Project (import)") {
  const [project] = await db
    .insert(schema.projects)
    .values({ name })
    .returning();
  if (!project) throw new Error("seedProject: no row returned");
  return project;
}

async function seedUser() {
  const id = createId();
  const now = new Date();
  const [row] = await db
    .insert(schema.user)
    .values({
      id,
      name: `user-${id}`,
      email: `${id}@example.test`,
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (!row) throw new Error("seedUser: no row returned");
  return row;
}

async function seedImportJob(overrides: Partial<schema.NewImportJob> = {}) {
  const project = await seedProject();
  const user = await seedUser();
  const job = await createImportJob(db, {
    projectId: project.id,
    createdByUserId: user.id,
    sourceLabel: "RevenueCat",
    presetId: "revenuecat",
    storageKey: `imports/${createId()}.csv`,
    fileName: "export.csv",
    fileBytes: 1024,
    fileSha256: "a".repeat(64),
    ...overrides,
  });
  return { project, user, job };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createImportJob / getImportJob", () => {
  it("creates a row and reads it back with defaults applied", async () => {
    const { project, user, job } = await seedImportJob();

    expect(job.id).toBeTruthy();
    expect(job.projectId).toBe(project.id);
    expect(job.createdByUserId).toBe(user.id);
    expect(job.sourceLabel).toBe("RevenueCat");
    expect(job.presetId).toBe("revenuecat");
    expect(job.status).toBe("PENDING_MAPPING");
    expect(job.checkpointLine).toBe(0);
    expect(job.mapping).toEqual({});
    expect(job.options).toEqual({});
    expect(job.counters).toEqual({});
    expect(job.reportStorageKey).toBeNull();
    expect(job.errorMessage).toBeNull();

    const found = await getImportJob(db, project.id, job.id);
    expect(found).not.toBeNull();
    expect(found!.id).toBe(job.id);
  });

  it("returns null for an id that belongs to a different project", async () => {
    const { job } = await seedImportJob();
    const otherProject = await seedProject("Other project");

    const found = await getImportJob(db, otherProject.id, job.id);
    expect(found).toBeNull();
  });
});

describe("listImportJobs", () => {
  it("is project-scoped and cannot see another project's rows", async () => {
    const { project: projectA, job: jobA } = await seedImportJob();
    const { job: jobB } = await seedImportJob();

    const rowsForA = await listImportJobs(db, projectA.id);
    expect(rowsForA.map((r) => r.id)).toContain(jobA.id);
    expect(rowsForA.map((r) => r.id)).not.toContain(jobB.id);
  });

  it("orders newest first", async () => {
    const project = await seedProject();
    const user = await seedUser();
    const first = await createImportJob(db, {
      projectId: project.id,
      createdByUserId: user.id,
      sourceLabel: "RevenueCat",
      storageKey: `imports/${createId()}.csv`,
      fileName: "a.csv",
      fileBytes: 10,
      fileSha256: "a".repeat(64),
    });
    const second = await createImportJob(db, {
      projectId: project.id,
      createdByUserId: user.id,
      sourceLabel: "RevenueCat",
      storageKey: `imports/${createId()}.csv`,
      fileName: "b.csv",
      fileBytes: 10,
      fileSha256: "b".repeat(64),
    });

    const rows = await listImportJobs(db, project.id);
    const ids = rows.map((r) => r.id);
    expect(ids.indexOf(second.id)).toBeLessThan(ids.indexOf(first.id));
  });
});

describe("updateImportJobMapping", () => {
  it("persists the operator-confirmed mapping without touching sourceLabel", async () => {
    const { project, job } = await seedImportJob();

    const updated = await updateImportJobMapping(db, project.id, job.id, {
      "App User ID": "rovenueId",
      "Product ID": "productId",
    });

    expect(updated.mapping).toEqual({
      "App User ID": "rovenueId",
      "Product ID": "productId",
    });
    expect(updated.sourceLabel).toBe("RevenueCat");
  });
});

describe("setImportJobStatus", () => {
  it("transitions PENDING_MAPPING -> DRY_RUN_RUNNING -> DRY_RUN_COMPLETE -> RUNNING -> COMPLETED", async () => {
    const { project, job } = await seedImportJob();

    const s1 = await setImportJobStatus(db, project.id, job.id, {
      status: "DRY_RUN_RUNNING",
      startedAt: new Date(),
    });
    expect(s1.status).toBe("DRY_RUN_RUNNING");
    expect(s1.startedAt).not.toBeNull();

    const s2 = await setImportJobStatus(db, project.id, job.id, {
      status: "DRY_RUN_COMPLETE",
    });
    expect(s2.status).toBe("DRY_RUN_COMPLETE");

    const s3 = await setImportJobStatus(db, project.id, job.id, {
      status: "RUNNING",
    });
    expect(s3.status).toBe("RUNNING");

    const finishedAt = new Date();
    const s4 = await setImportJobStatus(db, project.id, job.id, {
      status: "COMPLETED",
      reportStorageKey: "reports/done.json",
      finishedAt,
    });
    expect(s4.status).toBe("COMPLETED");
    expect(s4.reportStorageKey).toBe("reports/done.json");
    expect(s4.finishedAt).not.toBeNull();
  });

  it("records an errorMessage on a FAILED transition", async () => {
    const { project, job } = await seedImportJob();

    const failed = await setImportJobStatus(db, project.id, job.id, {
      status: "FAILED",
      errorMessage: "storage read timed out",
    });

    expect(failed.status).toBe("FAILED");
    expect(failed.errorMessage).toBe("storage read timed out");
  });
});

describe("saveImportJobCheckpoint", () => {
  it("advances the checkpoint forward", async () => {
    const { project, job } = await seedImportJob();

    const updated = await saveImportJobCheckpoint(db, project.id, job.id, 100);
    expect(updated.checkpointLine).toBe(100);

    const advanced = await saveImportJobCheckpoint(db, project.id, job.id, 250);
    expect(advanced.checkpointLine).toBe(250);
  });

  it("never regresses a checkpoint to a lower or equal value", async () => {
    const { project, job } = await seedImportJob();

    await saveImportJobCheckpoint(db, project.id, job.id, 500);

    const regressed = await saveImportJobCheckpoint(db, project.id, job.id, 100);
    expect(regressed.checkpointLine).toBe(500);

    const equal = await saveImportJobCheckpoint(db, project.id, job.id, 500);
    expect(equal.checkpointLine).toBe(500);

    const confirmedInDb = await getImportJob(db, project.id, job.id);
    expect(confirmedInDb!.checkpointLine).toBe(500);
  });
});

describe("incrementImportJobCounters", () => {
  it("increments additively across multiple calls and keys", async () => {
    const { project, job } = await seedImportJob();

    const afterFirst = await incrementImportJobCounters(db, project.id, job.id, {
      willCreate: 3,
      invalidRow: 1,
    });
    expect(afterFirst.counters).toEqual({ willCreate: 3, invalidRow: 1 });

    const afterSecond = await incrementImportJobCounters(db, project.id, job.id, {
      willCreate: 2,
      skippedSandbox: 5,
    });
    expect(afterSecond.counters).toEqual({
      willCreate: 5,
      invalidRow: 1,
      skippedSandbox: 5,
    });
  });
});
