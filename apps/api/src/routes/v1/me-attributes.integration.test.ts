// =============================================================
// /v1/me/attributes — integration tests
// =============================================================
//
// Boots a minimal Hono app with apiKeyAuth + meRoute against
// live Postgres (docker-compose host port 5433).
//
// Scenarios:
//   1. Merge reserved + custom attributes → 200 flat map response
//   2. Null-delete removes a key and preserves others
//   3. Unknown reserved key ($nope) → 400 INVALID_ARGUMENT
//   4. Stores nested shape with server-set updatedAt + source
//   5. GET /me returns flat attributes map

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { Pool } from "pg";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { drizzle as drizzleNs } from "@rovenue/db";
import { apiKeyAuth } from "../../middleware/api-key-auth";
import { errorHandler } from "../../middleware/error";
import { meRoute } from "./me";

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
const APP_USER_ID = `u1-${createId().slice(0, 8)}`;

// ---------------------------------------------------------------------------
// App under test
// ---------------------------------------------------------------------------
function buildApp() {
  const app = new Hono()
    .use("*", apiKeyAuth("any"))
    .route("/v1/me", meRoute);
  app.onError(errorHandler);
  return app;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function post(attributes: Record<string, string | null>) {
  const app = buildApp();
  return app.request("/v1/me/attributes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${PUBLIC_KEY}`,
      "X-Rovenue-App-User-Id": APP_USER_ID,
    },
    body: JSON.stringify({ attributes }),
  });
}

function getMe() {
  const app = buildApp();
  return app.request("/v1/me", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${PUBLIC_KEY}`,
      "X-Rovenue-App-User-Id": APP_USER_ID,
    },
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
    .values({ name: `me-attrs-e2e-${createId().slice(0, 8)}` })
    .returning();
  if (!project) throw new Error("seed: project insert returned no row");
  PROJECT_ID = project.id;

  // 2. Seed public API key (stored plain — matched via eq)
  PUBLIC_KEY = `rov_pub_${createId()}`;
  await testDb.insert(schema.apiKeys).values({
    projectId: PROJECT_ID,
    label: "test-public-key",
    keyPublic: PUBLIC_KEY,
    keySecretHash: "n/a",
    environment: "PRODUCTION",
  });

  // 3. Seed subscriber (rovenueId = APP_USER_ID, same as device key)
  await testDb.insert(schema.subscribers).values({
    projectId: PROJECT_ID,
    rovenueId: APP_USER_ID,
  });
}, 15_000);

afterAll(async () => {
  // Clean up: delete subscriber so the next run has a fresh start
  await testDb
    .delete(schema.subscribers)
    .where(eq(schema.subscribers.rovenueId, APP_USER_ID));
  await pool.end();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /v1/me/attributes", () => {
  it("merges reserved + custom attributes and returns a flat map", async () => {
    const res = await post({ $email: "a@b.com", favoriteTeam: "GS" });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.subscriber.attributes).toMatchObject({
      $email: "a@b.com",
      favoriteTeam: "GS",
    });
  });

  it("null-delete removes a key and preserves others", async () => {
    // Ensure $email is set first
    await post({ $email: "a@b.com", favoriteTeam: "GS" });
    const res = await post({ favoriteTeam: null });
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.subscriber.attributes).toMatchObject({ $email: "a@b.com" });
    expect(body.data.subscriber.attributes.favoriteTeam).toBeUndefined();
  });

  it("rejects an unknown reserved key with 400 INVALID_ARGUMENT", async () => {
    const res = await post({ $nope: "x" });
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.error.code).toBe("INVALID_ARGUMENT");
  });

  it("stores nested shape with server-set updatedAt + source", async () => {
    await post({ $email: "a@b.com" });
    // Read the row directly from the DB
    const rows = await testDb
      .select()
      .from(schema.subscribers)
      .where(eq(schema.subscribers.rovenueId, APP_USER_ID))
      .limit(1);
    const stored = rows[0]?.attributes as any;
    expect(stored).toBeDefined();
    expect(stored.$email).toMatchObject({ value: "a@b.com", source: "sdk" });
    expect(typeof stored.$email.updatedAt).toBe("string");
  });
});

describe("GET /v1/me", () => {
  it("returns flat attributes map", async () => {
    await post({ $email: "flat@test.com" });
    const res = await getMe();
    expect(res.status).toBe(200);
    const body = await res.json() as any;
    expect(body.data.subscriber.attributes).toMatchObject({
      $email: "flat@test.com",
    });
    // Must be flat (no nested {value, updatedAt, source} objects)
    expect(typeof body.data.subscriber.attributes.$email).toBe("string");
  });
});
