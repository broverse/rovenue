// =============================================================
// /v1/subscribers/:appUserId/attributes — integration tests
// =============================================================
//
// Boots a minimal Hono app with apiKeyAuth + subscribersRoute
// against live Postgres (docker-compose host port 5433).
//
// Scenarios:
//   1. Merge reserved + custom attributes → 200 flat map response
//   2. Null-delete removes a key and preserves others
//   3. Unknown reserved key ($nope) → 400 INVALID_ARGUMENT
//   4. Stores nested shape with server-set updatedAt + source

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { Pool } from "pg";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { drizzle as drizzleNs } from "@rovenue/db";
import { apiKeyAuth } from "../../middleware/api-key-auth";
import { errorHandler } from "../../middleware/error";
import { subscribersRoute } from "./subscribers";

// ---------------------------------------------------------------------------
// Env defaults
// ---------------------------------------------------------------------------
process.env.DATABASE_URL ??= "postgresql://rovenue:rovenue@localhost:5433/rovenue";
process.env.REDIS_URL ??= "redis://localhost:6380";

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------
const schema = drizzleNs.schema;

let pool: Pool;
let testDb: ReturnType<typeof drizzleClient<typeof drizzleNs.schema>>;

let PROJECT_ID: string;
let PUBLIC_KEY: string;
const DEVICE_ID = `dev-${createId().slice(0, 8)}`;

// ---------------------------------------------------------------------------
// App under test
// ---------------------------------------------------------------------------
function buildApp() {
  const app = new Hono()
    .use("*", apiKeyAuth("any"))
    .route("/v1/subscribers", subscribersRoute);
  app.onError(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------
function post(attributes: Record<string, string | null>) {
  const app = buildApp();
  return app.request(`/v1/subscribers/${DEVICE_ID}/attributes`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${PUBLIC_KEY}`,
    },
    body: JSON.stringify({ attributes }),
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  testDb = drizzleClient(pool, { schema });

  // 1. Seed project
  const [project] = await testDb
    .insert(schema.projects)
    .values({ name: `sub-attrs-e2e-${createId().slice(0, 8)}` })
    .returning();
  if (!project) throw new Error("seed: project insert returned no row");
  PROJECT_ID = project.id;

  // 2. Seed public API key
  PUBLIC_KEY = `rov_pub_${createId()}`;
  await testDb.insert(schema.apiKeys).values({
    projectId: PROJECT_ID,
    label: "test-public-key",
    keyPublic: PUBLIC_KEY,
    keySecretHash: "n/a",
    environment: "PRODUCTION",
  });

  // 3. Seed subscriber (rovenueId = DEVICE_ID — same as the path param)
  await testDb.insert(schema.subscribers).values({
    projectId: PROJECT_ID,
    rovenueId: DEVICE_ID,
  });
}, 15_000);

afterAll(async () => {
  await testDb
    .delete(schema.subscribers)
    .where(eq(schema.subscribers.rovenueId, DEVICE_ID));
  await pool.end();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /v1/subscribers/:appUserId/attributes", () => {
  it("merges reserved + custom attributes and returns a flat map", async () => {
    const res = await post({ $email: "s@b.com", teamName: "Bulls" });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.subscriber.attributes).toMatchObject({
      $email: "s@b.com",
      teamName: "Bulls",
    });
  });

  it("null-delete removes a key and preserves others", async () => {
    await post({ $email: "s@b.com", teamName: "Bulls" });
    const res = await post({ teamName: null });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.subscriber.attributes).toMatchObject({ $email: "s@b.com" });
    expect(body.data.subscriber.attributes.teamName).toBeUndefined();
  });

  it("rejects an unknown reserved key with 400 INVALID_ARGUMENT", async () => {
    const res = await post({ $nope: "x" });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe("INVALID_ARGUMENT");
  });

  it("stores nested shape with server-set updatedAt + source", async () => {
    await post({ $email: "s@b.com" });
    const rows = await testDb
      .select()
      .from(schema.subscribers)
      .where(eq(schema.subscribers.rovenueId, DEVICE_ID))
      .limit(1);
    const stored = rows[0]?.attributes as any;
    expect(stored).toBeDefined();
    expect(stored.$email).toMatchObject({ value: "s@b.com", source: "sdk" });
    expect(typeof stored.$email.updatedAt).toBe("string");
  });
});
