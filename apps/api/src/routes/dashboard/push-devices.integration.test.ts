// =============================================================
// /dashboard/push-devices — integration tests
// =============================================================

import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { getDb, drizzle } from "@rovenue/db";
import { auth } from "../../lib/auth";
import { errorHandler } from "../../middleware/error";
import { pushDevicesRoute } from "./push-devices";

const RUN_ID = Date.now();
const db = getDb();
const schema = drizzle.schema;

function buildApp() {
  const app = new Hono();
  app.route("/push-devices", pushDevicesRoute);
  app.onError(errorHandler);
  return app;
}

async function createUserAndSession(suffix: string) {
  const email = `pushroute_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!push";
  const signUp = await auth.api.signUpEmail({
    body: { email, password, name: `pd-${suffix}` },
  });
  if (!signUp?.user) throw new Error("signUp failed");
  const signIn = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const cookieHeader = signIn.headers.get("set-cookie");
  if (!cookieHeader) throw new Error("no set-cookie");
  return { userId: signUp.user.id, cookie: cookieHeader.split(";")[0] ?? "" };
}

afterAll(async () => {
  // No persistent state seeded by these tests outside push_devices,
  // which is per-user and tracked by createUserAndSession's
  // cascade-on-user-delete (Better Auth cleanup elsewhere).
});

describe.sequential("dashboard/push-devices", () => {
  it("POST upserts a new device + GET lists it", async () => {
    const { userId, cookie } = await createUserAndSession("upsert");
    const token = `tok-${createId()}`;
    const app = buildApp();

    const postRes = await app.request("/push-devices", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        platform: "ios",
        token,
        appBundleId: "io.rovenue.test",
        locale: "en",
        timezone: "UTC",
      }),
    });
    expect(postRes.status).toBe(200);

    const listRes = await app.request("/push-devices", {
      method: "GET",
      headers: { cookie },
    });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as {
      data: { items: Array<{ platform: string; appBundleId: string }> };
    };
    expect(list.data.items).toHaveLength(1);
    expect(list.data.items[0]?.platform).toBe("ios");

    // Direct row check
    const rows = await db
      .select()
      .from(schema.pushDevices)
      .where(eq(schema.pushDevices.userId, userId));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revokedAt).toBeNull();
  });

  it("POST on a token belonging to user A transfers ownership to user B", async () => {
    const a = await createUserAndSession("transfer_a");
    const b = await createUserAndSession("transfer_b");
    const sharedToken = `tok-shared-${createId()}`;
    const app = buildApp();

    // A registers first.
    let res = await app.request("/push-devices", {
      method: "POST",
      headers: { cookie: a.cookie, "content-type": "application/json" },
      body: JSON.stringify({
        platform: "android",
        token: sharedToken,
        appBundleId: "io.rovenue.test",
      }),
    });
    expect(res.status).toBe(200);

    // B re-registers the same (platform, token) — the conflict
    // target transfers userId to B.
    res = await app.request("/push-devices", {
      method: "POST",
      headers: { cookie: b.cookie, "content-type": "application/json" },
      body: JSON.stringify({
        platform: "android",
        token: sharedToken,
        appBundleId: "io.rovenue.test",
      }),
    });
    expect(res.status).toBe(200);

    const rows = await db
      .select()
      .from(schema.pushDevices)
      .where(eq(schema.pushDevices.token, sharedToken));
    expect(rows).toHaveLength(1);
    expect(rows[0]?.userId).toBe(b.userId);
  });

  it("DELETE :id revokes the row (soft delete)", async () => {
    const { cookie } = await createUserAndSession("del");
    const token = `tok-${createId()}`;
    const app = buildApp();

    const post = await app.request("/push-devices", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        platform: "ios",
        token,
        appBundleId: "io.rovenue.test",
      }),
    });
    const created = (await post.json()) as { data: { id: string } };
    const id = created.data.id;

    const del = await app.request(`/push-devices/${id}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(del.status).toBe(204);

    const rows = await db
      .select()
      .from(schema.pushDevices)
      .where(eq(schema.pushDevices.id, id));
    expect(rows[0]?.revokedAt).not.toBeNull();

    // Active-list excludes the revoked row.
    const list = await app.request("/push-devices", {
      method: "GET",
      headers: { cookie },
    });
    const body = (await list.json()) as { data: { items: unknown[] } };
    expect(body.data.items).toHaveLength(0);
  });

  it("DELETE another user's :id is a silent no-op (no row mutated)", async () => {
    const a = await createUserAndSession("delcross_a");
    const b = await createUserAndSession("delcross_b");
    const token = `tok-${createId()}`;
    const app = buildApp();

    const post = await app.request("/push-devices", {
      method: "POST",
      headers: { cookie: a.cookie, "content-type": "application/json" },
      body: JSON.stringify({
        platform: "ios",
        token,
        appBundleId: "io.rovenue.test",
      }),
    });
    const created = (await post.json()) as { data: { id: string } };
    const id = created.data.id;

    // B attempts to revoke A's row.
    const del = await app.request(`/push-devices/${id}`, {
      method: "DELETE",
      headers: { cookie: b.cookie },
    });
    expect(del.status).toBe(204);

    // A's row is still active.
    const rows = await db
      .select()
      .from(schema.pushDevices)
      .where(eq(schema.pushDevices.id, id));
    expect(rows[0]?.revokedAt).toBeNull();
    expect(rows[0]?.userId).toBe(a.userId);
  });
});
