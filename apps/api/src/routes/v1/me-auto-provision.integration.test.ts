// Boots apiKeyAuth + meRoute against live Postgres (docker-compose host
// port 5433). Verifies a NEVER-SEEN rovenueId is auto-provisioned on /v1/me.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { Pool } from "pg";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import { and, eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { drizzle as drizzleNs } from "@rovenue/db";
import { apiKeyAuth } from "../../middleware/api-key-auth";
import { errorHandler } from "../../middleware/error";
import { meRoute } from "./me";

process.env.DATABASE_URL ??= "postgresql://rovenue:rovenue@localhost:5433/rovenue";
process.env.REDIS_URL ??= "redis://localhost:6380";

const schema = drizzleNs.schema;
let pool: Pool;
let testDb: ReturnType<typeof drizzleClient<typeof drizzleNs.schema>>;
let PROJECT_ID: string;
let PUBLIC_KEY: string;
const FRESH_ID = `fresh-${createId().slice(0, 8)}`; // deliberately NOT seeded

function buildApp() {
  const app = new Hono().use("*", apiKeyAuth("any")).route("/v1/me", meRoute);
  app.onError(errorHandler);
  return app;
}

function getAccess(userId: string) {
  return buildApp().request("/v1/me/access", {
    method: "GET",
    headers: { Authorization: `Bearer ${PUBLIC_KEY}`, "X-Rovenue-App-User-Id": userId },
  });
}

beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  testDb = drizzleClient(pool, { schema });
  const [project] = await testDb
    .insert(schema.projects)
    .values({ name: `me-autoprov-e2e-${createId().slice(0, 8)}` })
    .returning();
  if (!project) throw new Error("seed: project insert returned no row");
  PROJECT_ID = project.id;
  PUBLIC_KEY = `rov_pub_${createId()}`;
  await testDb.insert(schema.apiKeys).values({
    projectId: PROJECT_ID,
    label: "test-public-key",
    keyPublic: PUBLIC_KEY,
    keySecretHash: "n/a",
    environment: "PRODUCTION",
  });
}, 15_000);

afterAll(async () => {
  await testDb
    .delete(schema.subscribers)
    .where(and(eq(schema.subscribers.projectId, PROJECT_ID), eq(schema.subscribers.rovenueId, FRESH_ID)));
  await pool.end();
});

describe("GET /v1/me/access (auto-provision)", () => {
  it("creates the subscriber and returns empty access for a never-seen rovenueId", async () => {
    const res = await getAccess(FRESH_ID);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.access).toEqual({});

    const rows = await testDb
      .select()
      .from(schema.subscribers)
      .where(and(eq(schema.subscribers.projectId, PROJECT_ID), eq(schema.subscribers.rovenueId, FRESH_ID)));
    expect(rows).toHaveLength(1);
  });

  it("is idempotent — a second call does not create a duplicate", async () => {
    await getAccess(FRESH_ID);
    await getAccess(FRESH_ID);
    const rows = await testDb
      .select()
      .from(schema.subscribers)
      .where(and(eq(schema.subscribers.projectId, PROJECT_ID), eq(schema.subscribers.rovenueId, FRESH_ID)));
    expect(rows).toHaveLength(1);
  });
});
