// =============================================================
// notifications repo — integration tests (real Postgres)
// =============================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { Pool } from "pg";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import * as schema from "../schema";
import {
  insertNotificationIdempotent,
  listNotificationsForUser,
  markAllNotificationsRead,
  markNotificationRead,
  unreadNotificationCount,
} from "./notifications";

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";

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

async function seedProject() {
  const [row] = await db
    .insert(schema.projects)
    .values({ name: `proj-${createId()}` })
    .returning();
  if (!row) throw new Error("seedProject: no row returned");
  return row;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("notifications repo", () => {
  it("insertNotificationIdempotent: second call with same (userId, eventId) returns null", async () => {
    const user = await seedUser();
    const project = await seedProject();
    const eventId = createId();

    const first = await insertNotificationIdempotent(db, {
      userId: user.id,
      projectId: project.id,
      eventKey: "team.invited",
      eventId,
      title: "Invited",
      body: "You were invited",
      data: { role: "ADMIN" },
    });
    expect(first).not.toBeNull();

    const second = await insertNotificationIdempotent(db, {
      userId: user.id,
      projectId: project.id,
      eventKey: "team.invited",
      eventId,
      title: "Invited (duplicate)",
      body: "should not insert",
      data: {},
    });
    expect(second).toBeNull();

    const rows = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.userId, user.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.title).toBe("Invited");
  });

  it("markNotificationRead: sets readAt and is idempotent", async () => {
    const user = await seedUser();
    const inserted = await insertNotificationIdempotent(db, {
      userId: user.id,
      projectId: null,
      eventKey: "ping",
      eventId: createId(),
      title: "Hi",
      body: "Hello",
      data: {},
    });
    expect(inserted).not.toBeNull();

    await markNotificationRead(db, user.id, inserted!.id);
    const afterFirst = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.id, inserted!.id));
    expect(afterFirst[0]!.readAt).not.toBeNull();
    const firstReadAt = afterFirst[0]!.readAt!;

    // Second call should not throw.
    await expect(
      markNotificationRead(db, user.id, inserted!.id),
    ).resolves.toBeUndefined();
    // Still read.
    const afterSecond = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.id, inserted!.id));
    expect(afterSecond[0]!.readAt).not.toBeNull();
    // The readAt may have been updated (the repo always sets to now()).
    expect(afterSecond[0]!.readAt!.getTime()).toBeGreaterThanOrEqual(
      firstReadAt.getTime(),
    );
  });

  it("unreadNotificationCount: returns total + byProject after seeding two projects", async () => {
    const user = await seedUser();
    const projA = await seedProject();
    const projB = await seedProject();

    await insertNotificationIdempotent(db, {
      userId: user.id,
      projectId: projA.id,
      eventKey: "a1",
      eventId: createId(),
      title: "a1",
      body: "a1",
      data: {},
    });
    await insertNotificationIdempotent(db, {
      userId: user.id,
      projectId: projA.id,
      eventKey: "a2",
      eventId: createId(),
      title: "a2",
      body: "a2",
      data: {},
    });
    await insertNotificationIdempotent(db, {
      userId: user.id,
      projectId: projB.id,
      eventKey: "b1",
      eventId: createId(),
      title: "b1",
      body: "b1",
      data: {},
    });

    const counts = await unreadNotificationCount(db, user.id);
    expect(counts.total).toBe(3);
    expect(counts.byProject[projA.id]).toBe(2);
    expect(counts.byProject[projB.id]).toBe(1);

    // markAllNotificationsRead returns the affected count.
    const affected = await markAllNotificationsRead(db, user.id, projA.id);
    expect(affected).toBe(2);

    const after = await unreadNotificationCount(db, user.id);
    expect(after.total).toBe(1);
    expect(after.byProject[projA.id]).toBeUndefined();
    expect(after.byProject[projB.id]).toBe(1);
  });

  it("listNotificationsForUser: honours unreadOnly + projectId filters and paginates by cursor", async () => {
    const user = await seedUser();
    const projA = await seedProject();
    const projB = await seedProject();

    // Seed 3 in projA, 1 in projB. Stagger createdAt explicitly so
    // cursor ordering is deterministic.
    const inserts: Array<{
      projectId: string;
      eventKey: string;
      createdAt: Date;
    }> = [
      { projectId: projA.id, eventKey: "a1", createdAt: new Date(Date.now() - 4000) },
      { projectId: projA.id, eventKey: "a2", createdAt: new Date(Date.now() - 3000) },
      { projectId: projA.id, eventKey: "a3", createdAt: new Date(Date.now() - 2000) },
      { projectId: projB.id, eventKey: "b1", createdAt: new Date(Date.now() - 1000) },
    ];
    for (const ins of inserts) {
      await db.insert(schema.notifications).values({
        userId: user.id,
        projectId: ins.projectId,
        eventKey: ins.eventKey,
        eventId: createId(),
        title: ins.eventKey,
        body: ins.eventKey,
        createdAt: ins.createdAt,
      });
    }

    // unreadOnly + filter to projA → 3 rows.
    const projAUnread = await listNotificationsForUser(db, user.id, {
      limit: 50,
      projectId: projA.id,
      unreadOnly: true,
    });
    expect(projAUnread).toHaveLength(3);
    expect(projAUnread.every((r) => r.projectId === projA.id)).toBe(true);

    // Mark one read, then unreadOnly should drop to 2.
    await markNotificationRead(db, user.id, projAUnread[0]!.id);
    const projAAfter = await listNotificationsForUser(db, user.id, {
      limit: 50,
      projectId: projA.id,
      unreadOnly: true,
    });
    expect(projAAfter).toHaveLength(2);

    // Cursor pagination: limit 2 → first page returns 2, cursor to next page.
    const page1 = await listNotificationsForUser(db, user.id, { limit: 2 });
    expect(page1).toHaveLength(2);
    const last1 = page1[page1.length - 1]!;
    const page2 = await listNotificationsForUser(db, user.id, {
      limit: 10,
      cursor: { createdAt: last1.createdAt, id: last1.id },
    });
    expect(page2.length).toBeGreaterThan(0);
    // No overlap between pages.
    const page1Ids = new Set(page1.map((r) => r.id));
    expect(page2.every((r) => !page1Ids.has(r.id))).toBe(true);
  });
});
