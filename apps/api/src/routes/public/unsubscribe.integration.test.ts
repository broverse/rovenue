// =============================================================
// /unsubscribe — integration tests
// =============================================================

import { describe, expect, it, beforeAll } from "vitest";
import { createId } from "@paralleldrive/cuid2";
import { eq, and } from "drizzle-orm";
import { Hono } from "hono";
import { drizzle, getDb } from "@rovenue/db";
import {
  signUnsubscribeToken,
  type UnsubscribePayload,
} from "../../lib/unsubscribe-token";
import { errorHandler } from "../../middleware/error";
import { publicUnsubscribeRoute } from "./unsubscribe";

// Matches the test default seeded in tests/setup.ts so token
// signatures verify against the same key the route reads.
const SIGNING_KEY = process.env.UNSUB_SIGNING_KEY ?? "0".repeat(64);

const db = getDb();
const schema = drizzle.schema;

function buildApp() {
  const app = new Hono();
  app.route("/unsubscribe", publicUnsubscribeRoute);
  app.onError(errorHandler);
  return app;
}

async function seedUser() {
  const id = createId();
  const now = new Date();
  await db.insert(schema.user).values({
    id,
    name: `u-${id}`,
    email: `${id}@example.test`,
    emailVerified: true,
    createdAt: now,
    updatedAt: now,
  });
  return id;
}

async function seedProject() {
  const [row] = await db
    .insert(schema.projects)
    .values({ name: `unsub-${createId()}` })
    .returning();
  if (!row) throw new Error("seedProject: no row");
  return row.id;
}

function mintToken(payload: UnsubscribePayload) {
  return signUnsubscribeToken(payload, SIGNING_KEY);
}

const futureExp = () => Math.floor(Date.now() / 1000) + 3600;
const pastExp = () => Math.floor(Date.now() / 1000) - 60;

describe.sequential("/unsubscribe", () => {
  let app: ReturnType<typeof buildApp>;
  beforeAll(() => {
    app = buildApp();
  });

  it("channel:email token → 204 + flips user channel master", async () => {
    const userId = await seedUser();
    const token = mintToken({
      userId,
      scope: "channel:email",
      exp: futureExp(),
    });
    const res = await app.request("/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(204);
    const channels =
      await drizzle.notificationPreferencesRepo.getUserChannels(db, userId);
    expect(channels?.email).toBe(false);
  });

  it("event:<key> token with projectId → 204 + flips override map", async () => {
    const userId = await seedUser();
    const projectId = await seedProject();
    // revenue.digest.daily has forcedChannels=[] so it's
    // opt-out-able. team.* and security.* events are mostly
    // forced; revenue/billing-info events are the unsub-eligible
    // category in v1.
    const eventKey = "revenue.digest.daily";
    const token = mintToken({
      userId,
      scope: `event:${eventKey}`,
      projectId,
      exp: futureExp(),
    });
    const res = await app.request("/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(204);

    const overrides =
      await drizzle.notificationPreferencesRepo.getUserProjectOverrides(
        db,
        userId,
        projectId,
      );
    expect(overrides[eventKey]).toBe(false);

    // Channel master switch untouched — either the row doesn't
    // exist (null) or its email flag is still true.
    const channels =
      await drizzle.notificationPreferencesRepo.getUserChannels(db, userId);
    if (channels) expect(channels.email).toBe(true);
  });

  it("event token missing projectId → 400", async () => {
    const userId = await seedUser();
    const token = mintToken({
      userId,
      scope: "event:revenue.digest.daily",
      exp: futureExp(),
    });
    const res = await app.request("/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(400);
  });

  it("forced-channel event token → 400 (cannot unsubscribe)", async () => {
    const userId = await seedUser();
    const projectId = await seedProject();
    // security.signin.new_device is a forced-channels event per
    // the catalog — it cannot be opted out of.
    const token = mintToken({
      userId,
      scope: "event:security.signin.new_device",
      projectId,
      exp: futureExp(),
    });
    const res = await app.request("/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(400);
  });

  it("unknown event key → 400", async () => {
    const userId = await seedUser();
    const projectId = await seedProject();
    const token = mintToken({
      userId,
      scope: "event:not.a.real.event",
      projectId,
      exp: futureExp(),
    });
    const res = await app.request("/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(400);
  });

  it("expired token → 401", async () => {
    const userId = await seedUser();
    const token = mintToken({
      userId,
      scope: "channel:email",
      exp: pastExp(),
    });
    const res = await app.request("/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(res.status).toBe(401);
  });

  it("tampered token → 400 (invalid signature)", async () => {
    const userId = await seedUser();
    const good = mintToken({
      userId,
      scope: "channel:email",
      exp: futureExp(),
    });
    const tampered = good.replace(/.$/, (c) => (c === "A" ? "B" : "A"));
    const res = await app.request("/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: tampered }),
    });
    expect(res.status).toBe(400);
  });

  it("missing token in body → 400", async () => {
    const res = await app.request("/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("malformed JSON body → 400", async () => {
    const res = await app.request("/unsubscribe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect(res.status).toBe(400);
  });
});

// Touch unused imports for tsc strictness suppression in environments
// where these helpers stay available but aren't called by every case.
void and;
void eq;
