// =============================================================
// /dashboard/notifications — feed route integration tests
// =============================================================

import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { getDb, drizzle, projects } from "@rovenue/db";
import { auth } from "../../../lib/auth";
import { notificationsRoute } from "./index";

const RUN_ID = Date.now();
const db = getDb();
const schema = drizzle.schema;

function buildApp() {
  return new Hono().route("/notifications", notificationsRoute);
}

async function createUserAndSession(suffix: string) {
  const email = `notifroute_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!notif";
  const signUp = await auth.api.signUpEmail({
    body: { email, password, name: `n-${suffix}` },
  });
  if (!signUp?.user) throw new Error(`signUpEmail failed for ${suffix}`);
  const signIn = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const cookieHeader = signIn.headers.get("set-cookie");
  if (!cookieHeader) throw new Error(`no set-cookie for ${suffix}`);
  return { userId: signUp.user.id, cookie: cookieHeader.split(";")[0] ?? "" };
}

async function seedProject(suffix: string): Promise<string> {
  const id = `prj_notifroute_${RUN_ID}_${suffix}`;
  await db.insert(projects).values({ id, name: id });
  seededProjectIds.push(id);
  return id;
}

async function seedNotification(opts: {
  userId: string;
  projectId?: string;
  title?: string;
  eventKey?: string;
  read?: boolean;
}) {
  const [row] = await db
    .insert(schema.notifications)
    .values({
      userId: opts.userId,
      projectId: opts.projectId ?? null,
      eventKey: opts.eventKey ?? "team.member.invited",
      eventId: createId(),
      title: opts.title ?? "t",
      body: "b",
      readAt: opts.read ? new Date() : null,
    })
    .returning();
  if (!row) throw new Error("seedNotification: no row");
  return row;
}

const seededProjectIds: string[] = [];
afterAll(async () => {
  for (const id of seededProjectIds) {
    await db.delete(projects).where(eq(projects.id, id));
  }
});

describe.sequential("dashboard/notifications", () => {
  it("GET / lists the caller's notifications newest-first", async () => {
    const { userId, cookie } = await createUserAndSession("list");
    const a = await seedNotification({ userId, title: "a" });
    // Ensure b's createdAt > a's createdAt by 1ms+
    await new Promise((r) => setTimeout(r, 5));
    const b = await seedNotification({ userId, title: "b" });

    const app = buildApp();
    const res = await app.request("/notifications", {
      method: "GET",
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { items: Array<{ id: string; title: string }>; nextCursor: string | null };
    };
    const titles = body.data.items.map((i) => i.title);
    expect(titles[0]).toBe("b");
    expect(titles[1]).toBe("a");
    expect(body.data.items.find((i) => i.id === a.id)).toBeDefined();
    expect(body.data.items.find((i) => i.id === b.id)).toBeDefined();
  });

  it("GET / does not leak another user's rows", async () => {
    const alice = await createUserAndSession("alice");
    const bob = await createUserAndSession("bob");
    const bobRow = await seedNotification({ userId: bob.userId, title: "bob-only" });

    const app = buildApp();
    const res = await app.request("/notifications", {
      method: "GET",
      headers: { cookie: alice.cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { items: Array<{ id: string }> };
    };
    expect(body.data.items.find((i) => i.id === bobRow.id)).toBeUndefined();
  });

  it("cursor pagination boundary returns next page once", async () => {
    const { userId, cookie } = await createUserAndSession("cursor");
    for (let i = 0; i < 3; i++) {
      await seedNotification({ userId, title: `n${i}` });
      await new Promise((r) => setTimeout(r, 2));
    }

    const app = buildApp();
    const first = await app.request("/notifications?limit=2", {
      method: "GET",
      headers: { cookie },
    });
    const firstBody = (await first.json()) as {
      data: { items: unknown[]; nextCursor: string | null };
    };
    expect(firstBody.data.items).toHaveLength(2);
    expect(firstBody.data.nextCursor).not.toBeNull();

    const second = await app.request(
      `/notifications?limit=2&cursor=${encodeURIComponent(firstBody.data.nextCursor!)}`,
      { method: "GET", headers: { cookie } },
    );
    const secondBody = (await second.json()) as {
      data: { items: unknown[]; nextCursor: string | null };
    };
    expect(secondBody.data.items).toHaveLength(1);
    expect(secondBody.data.nextCursor).toBeNull();
  });

  it("GET /unread-count returns total + per-project map", async () => {
    const { userId, cookie } = await createUserAndSession("count");
    const pA = await seedProject("count_a");
    const pB = await seedProject("count_b");
    await seedNotification({ userId, projectId: pA });
    await seedNotification({ userId, projectId: pA });
    await seedNotification({ userId, projectId: pB });
    await seedNotification({ userId, projectId: pA, read: true }); // not counted

    const app = buildApp();
    const res = await app.request("/notifications/unread-count", {
      method: "GET",
      headers: { cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { total: number; byProject: Record<string, number> };
    };
    expect(body.data.total).toBe(3);
    expect(body.data.byProject[pA]).toBe(2);
    expect(body.data.byProject[pB]).toBe(1);
  });

  it("POST /:id/read marks the row read", async () => {
    const { userId, cookie } = await createUserAndSession("read");
    const row = await seedNotification({ userId });

    const app = buildApp();
    const res = await app.request(`/notifications/${row.id}/read`, {
      method: "POST",
      headers: { cookie },
    });
    expect(res.status).toBe(200);

    const updated = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.id, row.id));
    expect(updated[0]?.readAt).not.toBeNull();
  });

  it("POST /:id/read on another user's id returns 404 (no info leak)", async () => {
    const alice = await createUserAndSession("readaa");
    const bob = await createUserAndSession("readbb");
    const bobRow = await seedNotification({ userId: bob.userId });

    const app = buildApp();
    const res = await app.request(`/notifications/${bobRow.id}/read`, {
      method: "POST",
      headers: { cookie: alice.cookie },
    });
    expect(res.status).toBe(404);

    // Sanity: Bob's row is still unread.
    const unchanged = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.id, bobRow.id));
    expect(unchanged[0]?.readAt).toBeNull();
  });

  it("POST /read-all with projectId only flips rows in that project", async () => {
    const { userId, cookie } = await createUserAndSession("readall");
    const pA = await seedProject("readall_a");
    const pB = await seedProject("readall_b");
    const inA = await seedNotification({ userId, projectId: pA });
    const inB = await seedNotification({ userId, projectId: pB });

    const app = buildApp();
    const res = await app.request("/notifications/read-all", {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ projectId: pA }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { updated: number } };
    expect(body.data.updated).toBe(1);

    const rowA = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.id, inA.id));
    const rowB = await db
      .select()
      .from(schema.notifications)
      .where(eq(schema.notifications.id, inB.id));
    expect(rowA[0]?.readAt).not.toBeNull();
    expect(rowB[0]?.readAt).toBeNull();
  });
});
