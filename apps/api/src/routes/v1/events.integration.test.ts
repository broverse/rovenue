// =============================================================
// /v1/events — integration tests (M7.5)
// =============================================================
//
// Boots a minimal Hono app with apiKeyAuth + eventsRoute against
// live Postgres (docker-compose host port 5433).
//
// Scenarios:
//   1. Accept identityContext with subset of fields → 202 + outbox row
//   2. Reject unknown identityContext sub-field → 400 (strict Zod)
//   3. Accept body without identityContext → 202 (backwards-compat)

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { Pool } from "pg";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import { eq, desc } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { drizzle as drizzleNs, getDb } from "@rovenue/db";
import { apiKeyAuth } from "../../middleware/api-key-auth";
import { eventsRoute } from "./events";

// ---------------------------------------------------------------------------
// Env defaults (same pattern as integrations-deliver.integration.test.ts)
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
let PUBLIC_KEY: string; // raw rov_pub_ token (stored plain in keyPublic)

// ---------------------------------------------------------------------------
// App under test
// ---------------------------------------------------------------------------
function buildApp() {
  return new Hono()
    .use("*", apiKeyAuth("any"))
    .route("/v1/events", eventsRoute);
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
    .values({ name: `events-ingest-e2e-${createId().slice(0, 8)}` })
    .returning();
  if (!project) throw new Error("seed: project insert returned no row");
  PROJECT_ID = project.id;

  // 2. Seed public API key
  // keyPublic is stored plain (matched via eq); keySecretHash is used
  // only for SECRET keys — for PUBLIC keys the lookup is by keyPublic value.
  PUBLIC_KEY = `rov_pub_${createId()}`;
  await testDb.insert(schema.apiKeys).values({
    projectId: PROJECT_ID,
    label: "test-public-key",
    keyPublic: PUBLIC_KEY,
    keySecretHash: "n/a",  // not used for public key auth path
    environment: "PRODUCTION",
  });
}, 15_000);

afterAll(async () => {
  await pool.end();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("POST /v1/events", () => {
  it("accepts identityContext with subset of fields → 202 + outbox row", async () => {
    const app = buildApp();
    const occurredAt = new Date().toISOString();
    const body = {
      eventType: "revenue.event.recorded",
      occurredAt,
      subscriberId: "sub_test_1",
      identityContext: {
        email: "test@example.com",
        externalId: "uid_abc123",
      },
    };

    const res = await app.request("/v1/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PUBLIC_KEY}`,
      },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(202);

    // Assert outbox row was written with correct payload
    const rows = await testDb
      .select()
      .from(schema.outboxEvents)
      .where(eq(schema.outboxEvents.aggregateId, PROJECT_ID))
      .orderBy(desc(schema.outboxEvents.createdAt))
      .limit(5);

    const row = rows.find(
      (r) =>
        r.eventType === "revenue.event.recorded" &&
        (r.payload as Record<string, unknown>).subscriberId === "sub_test_1",
    );
    expect(row).toBeDefined();
    expect(row!.aggregateType).toBe("REVENUE_EVENT");

    const payload = row!.payload as Record<string, unknown>;
    const ic = payload.identityContext as Record<string, unknown>;
    expect(ic).toBeDefined();
    expect(ic.email).toBe("test@example.com");
    expect(ic.externalId).toBe("uid_abc123");
  });

  it("rejects unknown identityContext sub-field → 400 (strict Zod)", async () => {
    const app = buildApp();
    const body = {
      eventType: "revenue.event.recorded",
      occurredAt: new Date().toISOString(),
      identityContext: {
        email: "test@example.com",
        unknownField: "should-fail",
      },
    };

    const res = await app.request("/v1/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PUBLIC_KEY}`,
      },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(400);
  });

  it("accepts body without identityContext → 202 (backwards-compat)", async () => {
    const app = buildApp();
    const body = {
      eventType: "subscription.expired",
      occurredAt: new Date().toISOString(),
      subscriberId: "sub_no_ic",
    };

    const res = await app.request("/v1/events", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${PUBLIC_KEY}`,
      },
      body: JSON.stringify(body),
    });

    expect(res.status).toBe(202);
  });
});
