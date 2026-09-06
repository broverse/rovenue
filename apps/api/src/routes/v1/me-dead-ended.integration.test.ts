// =============================================================
// /v1/me/attributes on an ERASED subscriber — integration tests
// =============================================================
//
// The hole this closes: `resolveOrCreateSubscriber` discarded the
// `deadEnded` flag its own resolver computes, so every route behind
// `appUserContext` wrote onto soft-deleted rows. A subject could be
// erased and their app's very next attribute write silently un-erased
// them — while the user had been told the erasure succeeded.
//
// `routes/v1/subscribers.ts` already guarded exactly this case and
// documented why; these tests hold `/v1/me/attributes` to the same
// contract: skip the write, return 200 with the row UNTOUCHED.
//
// Erasure here runs through the real `anonymizeSubscriber` service, not
// a hand-crafted soft delete — a test that fakes the erasure proves
// nothing about the path that matters.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { Pool } from "pg";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { drizzle as drizzleNs } from "@rovenue/db";
import { apiKeyAuth } from "../../middleware/api-key-auth";
import { errorHandler } from "../../middleware/error";
import { anonymizeSubscriber } from "../../services/gdpr/anonymize-subscriber";
import { meRoute } from "./me";

process.env.DATABASE_URL ??= "postgresql://rovenue:rovenue@localhost:5433/rovenue";
process.env.REDIS_URL ??= "redis://localhost:6380";
// anonymizeSubscriber derives its anonymous id by HMAC with the master
// key, so the service refuses to run without one.
process.env.ENCRYPTION_KEY ??= "0".repeat(64);

const schema = drizzleNs.schema;

let pool: Pool;
let testDb: ReturnType<typeof drizzleClient<typeof drizzleNs.schema>>;

let PROJECT_ID: string;
let PUBLIC_KEY: string;
let ACTOR_USER_ID: string;

const RUN = createId().slice(0, 8);
const ERASED_USER_ID = `erased-${RUN}`;
const LIVE_USER_ID = `live-${RUN}`;

function buildApp() {
  const app = new Hono()
    .use("*", apiKeyAuth("any"))
    .route("/v1/me", meRoute);
  app.onError(errorHandler);
  return app;
}

function postAttributes(appUserId: string, attributes: Record<string, string>) {
  return buildApp().request("/v1/me/attributes", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${PUBLIC_KEY}`,
      "X-Rovenue-App-User-Id": appUserId,
    },
    body: JSON.stringify({ attributes }),
  });
}

async function storedAttributesOf(appUserId: string) {
  const [row] = await testDb
    .select()
    .from(schema.subscribers)
    .where(eq(schema.subscribers.rovenueId, appUserId));
  return row?.attributes as Record<string, unknown> | null | undefined;
}

beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  testDb = drizzleClient(pool, { schema });

  const [project] = await testDb
    .insert(schema.projects)
    .values({ name: `me-dead-ended-${RUN}` })
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

  // anonymizeSubscriber writes an audit row, whose projectId is a real
  // FK and whose actor is a real user id.
  const [user] = await testDb
    .insert(schema.user)
    .values({
      id: createId(),
      name: "dsar actor",
      email: `dsar-${RUN}@example.test`,
      emailVerified: true,
      // `user` is a Better Auth table: its timestamps carry no database
      // default, so a seed must supply them explicitly.
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .returning();
  if (!user) throw new Error("seed: user insert returned no row");
  ACTOR_USER_ID = user.id;

  const [erased] = await testDb
    .insert(schema.subscribers)
    .values({
      projectId: PROJECT_ID,
      rovenueId: ERASED_USER_ID,
      attributes: { $email: { value: "before@example.test", source: "sdk" } },
    })
    .returning();
  if (!erased) throw new Error("seed: erased subscriber insert returned no row");

  await testDb.insert(schema.subscribers).values({
    projectId: PROJECT_ID,
    rovenueId: LIVE_USER_ID,
  });

  // Erase through the REAL service.
  await anonymizeSubscriber({
    subscriberId: erased.id,
    projectId: PROJECT_ID,
    actorUserId: ACTOR_USER_ID,
    reason: "gdpr_request",
  });
}, 30_000);

afterAll(async () => {
  await testDb
    .delete(schema.auditLogs)
    .where(eq(schema.auditLogs.projectId, PROJECT_ID));
  await testDb
    .delete(schema.subscribers)
    .where(eq(schema.subscribers.projectId, PROJECT_ID));
  await testDb.delete(schema.projects).where(eq(schema.projects.id, PROJECT_ID));
  await testDb.delete(schema.user).where(eq(schema.user.id, ACTOR_USER_ID));
  await pool.end();
});

describe("POST /v1/me/attributes on an erased subscriber", () => {
  it("does not re-populate a dead-ended subscriber's attributes", async () => {
    const before = await storedAttributesOf(ERASED_USER_ID);

    const res = await postAttributes(ERASED_USER_ID, {
      $email: "after@example.test",
    });
    expect(res.status).toBe(200);

    const after = await storedAttributesOf(ERASED_USER_ID);
    // The row must be byte-identical to what erasure left behind. This
    // is the assertion the whole sub-project rests on: without it,
    // self-service erasure is a lie.
    expect(after).toEqual(before);
    expect(JSON.stringify(after)).not.toContain("after@example.test");
  });

  it("still writes attributes for a live subscriber", async () => {
    // The mirror. Without it the test above passes against a route that
    // refuses every write.
    const res = await postAttributes(LIVE_USER_ID, {
      $email: "live@example.test",
    });
    expect(res.status).toBe(200);

    const after = await storedAttributesOf(LIVE_USER_ID);
    expect(JSON.stringify(after)).toContain("live@example.test");
  });

  it("reports success rather than disclosing the erasure to the device", async () => {
    // Matching routes/v1/subscribers.ts, which skips the write and
    // returns the untouched row. A 4xx would tell a device-side SDK that
    // this subject was erased — a disclosure to a party that is not
    // necessarily entitled to it, and one the subject did not ask for.
    const res = await postAttributes(ERASED_USER_ID, { $email: "x@example.test" });
    expect(res.status).toBe(200);

    const body = (await res.json()) as {
      data: { subscriber: { attributes: Record<string, unknown> } };
    };
    expect(JSON.stringify(body.data.subscriber.attributes)).not.toContain(
      "x@example.test",
    );
  });
});
