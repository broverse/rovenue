process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

import { afterAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { getDb } from "../client";
import { auditLogs, projects } from "../schema";
import { listAuditProofRows } from "./audit-logs";

// Seeded with direct inserts, never by calling the audit writer: a proof
// read must be verified against rows whose exact field values the test
// controls, not against whatever the writer happens to produce.

const RUN_ID = Date.now();
const PROJECT_ID = `prj_alp_${RUN_ID}`;
const OTHER_PROJECT_ID = `prj_alp_other_${RUN_ID}`;
const TIE_PROJECT_ID = `prj_alp_tie_${RUN_ID}`;
const HASH0 = `hash-0-${RUN_ID}`;
const HASH1 = `hash-1-${RUN_ID}`;
const HASH2 = `hash-2-${RUN_ID}`;
const OTHER_HASH0 = `hash-other-0-${RUN_ID}`;
const TIE_HASH_A = `hash-tie-a-${RUN_ID}`;
const TIE_HASH_B = `hash-tie-b-${RUN_ID}`;
// Ids chosen so lexicographic (id ASC) order is the OPPOSITE of
// insertion order below (b is inserted first, a second) — a test
// that inserted in id order could pass on physical/insertion order
// alone and never actually exercise the tie-break.
const TIE_ID_A = `alp_tie_a_${RUN_ID}`;
const TIE_ID_B = `alp_tie_b_${RUN_ID}`;
const ALL_ROW_IDS = [
  `alp_row1_${RUN_ID}`,
  `alp_row2_${RUN_ID}`,
  `alp_row3_${RUN_ID}`,
  `alp_other_row_${RUN_ID}`,
  TIE_ID_A,
  TIE_ID_B,
];

describe("listAuditProofRows", () => {
  afterAll(async () => {
    const db = getDb();
    // `auditLogs.projectId` is ON DELETE SET NULL, not CASCADE, so
    // deleting the project would leave these rows behind (and their
    // unique rowHash values permanently squatted). Delete the rows
    // explicitly first, then the projects.
    await db.delete(auditLogs).where(inArray(auditLogs.id, ALL_ROW_IDS));
    await db.delete(projects).where(eq(projects.id, PROJECT_ID));
    await db.delete(projects).where(eq(projects.id, OTHER_PROJECT_ID));
    await db.delete(projects).where(eq(projects.id, TIE_PROJECT_ID));
  });

  it("returns exactly the hashed fields, chain-ordered", async () => {
    const db = getDb();

    // 1. Insert a project and three audit rows with known createdAt
    //    values out of insertion order, each with a prevHash pointing at
    //    its predecessor's rowHash.
    await db.insert(projects).values({ id: PROJECT_ID, name: `ALP ${RUN_ID}` });

    const t0 = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));
    const t1 = new Date(Date.UTC(2026, 0, 1, 0, 0, 1));
    const t2 = new Date(Date.UTC(2026, 0, 1, 0, 0, 2));

    await db.insert(auditLogs).values([
      {
        id: `alp_row2_${RUN_ID}`,
        projectId: PROJECT_ID,
        userId: "user_alp",
        action: "project.updated",
        resource: "project",
        resourceId: PROJECT_ID,
        before: { name: "a" },
        after: { name: "b" },
        ipAddress: "10.0.0.1",
        userAgent: "vitest/1",
        prevHash: HASH0,
        rowHash: HASH1,
        createdAt: t1,
      },
      {
        id: `alp_row1_${RUN_ID}`,
        projectId: PROJECT_ID,
        userId: "user_alp",
        action: "project.created",
        resource: "project",
        resourceId: PROJECT_ID,
        before: null,
        after: { name: "a" },
        ipAddress: "10.0.0.1",
        userAgent: "vitest/1",
        prevHash: null,
        rowHash: HASH0,
        createdAt: t0,
      },
      {
        id: `alp_row3_${RUN_ID}`,
        projectId: PROJECT_ID,
        userId: "user_alp",
        action: "project.updated",
        resource: "project",
        resourceId: PROJECT_ID,
        before: { name: "b" },
        after: { name: "c" },
        ipAddress: "10.0.0.1",
        userAgent: "vitest/1",
        prevHash: HASH1,
        rowHash: HASH2,
        createdAt: t2,
      },
    ]);

    // 2. Call listAuditProofRows for that project.
    const rows = await listAuditProofRows(db, {
      projectId: PROJECT_ID,
      limit: 100,
    });

    // 3. Assert the rows come back ordered by createdAt ascending.
    expect(rows.map((r) => r.rowHash)).toEqual([HASH0, HASH1, HASH2]);
    expect(rows.map((r) => r.createdAt)).toEqual([
      t0.toISOString(),
      t1.toISOString(),
      t2.toISOString(),
    ]);

    // 4. Assert each row object has EXACTLY these keys and no others:
    //    id, projectId, userId, action, resource, resourceId, before,
    //    after, ipAddress, userAgent, createdAt, prevHash, rowHash.
    //    Use expect(Object.keys(row).sort()).toEqual([...].sort()) — an
    //    extra field silently breaks hash reproduction, so the key set
    //    is the assertion, not a spot check.
    const expectedKeys = [
      "id",
      "projectId",
      "userId",
      "action",
      "resource",
      "resourceId",
      "before",
      "after",
      "ipAddress",
      "userAgent",
      "createdAt",
      "prevHash",
      "rowHash",
    ].sort();
    for (const row of rows) {
      expect(Object.keys(row).sort()).toEqual(expectedKeys);
    }

    // 5. Assert createdAt is an ISO string, not a Date: the encoder
    //    never sees a Date, so the read must have stringified it.
    for (const row of rows) {
      expect(typeof row.createdAt).toBe("string");
      expect(row.createdAt).not.toBeInstanceOf(Date);
    }

    expect(rows[1]?.prevHash).toBe(HASH0);
    expect(rows[0]?.projectId).toBe(PROJECT_ID);
  });

  it("scopes to one project", async () => {
    const db = getDb();

    // Insert rows under two projects; assert only the requested
    // project's rows return.
    await db
      .insert(projects)
      .values({ id: OTHER_PROJECT_ID, name: `ALP other ${RUN_ID}` });

    await db.insert(auditLogs).values({
      id: `alp_other_row_${RUN_ID}`,
      projectId: OTHER_PROJECT_ID,
      userId: "user_alp",
      action: "project.created",
      resource: "project",
      resourceId: OTHER_PROJECT_ID,
      before: null,
      after: { name: "other" },
      ipAddress: "10.0.0.2",
      userAgent: "vitest/1",
      prevHash: null,
      rowHash: OTHER_HASH0,
      createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, 0)),
    });

    const rows = await listAuditProofRows(db, {
      projectId: OTHER_PROJECT_ID,
      limit: 100,
    });

    expect(rows).toHaveLength(1);
    expect(rows.every((r) => r.projectId === OTHER_PROJECT_ID)).toBe(true);
  });

  it("breaks a createdAt tie by id, not insertion order", async () => {
    const db = getDb();

    await db
      .insert(projects)
      .values({ id: TIE_PROJECT_ID, name: `ALP tie ${RUN_ID}` });

    const tieCreatedAt = new Date(Date.UTC(2026, 0, 1, 0, 0, 0));

    // Insert id B before id A: insertion order is the reverse of id
    // order, so a read that (incorrectly) fell back on physical/
    // insertion order instead of `ORDER BY createdAt, id` would come
    // back [B, A] instead of the correct [A, B].
    await db.insert(auditLogs).values([
      {
        id: TIE_ID_B,
        projectId: TIE_PROJECT_ID,
        userId: "user_alp",
        action: "project.updated",
        resource: "project",
        resourceId: TIE_PROJECT_ID,
        before: { name: "a" },
        after: { name: "b" },
        ipAddress: "10.0.0.3",
        userAgent: "vitest/1",
        prevHash: null,
        rowHash: TIE_HASH_B,
        createdAt: tieCreatedAt,
      },
      {
        id: TIE_ID_A,
        projectId: TIE_PROJECT_ID,
        userId: "user_alp",
        action: "project.created",
        resource: "project",
        resourceId: TIE_PROJECT_ID,
        before: null,
        after: { name: "a" },
        ipAddress: "10.0.0.3",
        userAgent: "vitest/1",
        prevHash: null,
        rowHash: TIE_HASH_A,
        createdAt: tieCreatedAt,
      },
    ]);

    const rows = await listAuditProofRows(db, {
      projectId: TIE_PROJECT_ID,
      limit: 100,
    });

    expect(rows.map((r) => r.id)).toEqual([TIE_ID_A, TIE_ID_B]);
  });
});
