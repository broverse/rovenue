// =============================================================
// /v1/dsar — route-level integration tests (ROADMAP §9.1, Task 3)
// =============================================================
//
// Boots a minimal Hono app with apiKeyAuth + dsarRoute against live
// Postgres (docker-compose host port 5433) and live Redis (host port
// 6380, needed for `endpointRateLimit`) — mirrors
// subscribers-attributes.integration.test.ts's harness.
//
// `../../queues/dsar` and `../../lib/import-store` are mocked: the
// queue side is Task 4/5's job, not this route's, and object storage
// needs no real MinIO to prove the route's OWN behaviour (state
// checks, streaming, and — above all — authorisation).
//
// Every POST-hitting test mints its OWN secret API key. `dsarEndpointLimit`
// is keyed by apiKeyId, so sharing one key across tests would make an
// earlier test's calls silently eat into a later test's rate-limit
// budget — exactly the kind of cross-test coupling this file's own
// dedicated "enforces the rate limit" test needs to NOT be polluted by.

process.env.DATABASE_URL ??=
  "postgresql://rovenue:rovenue@localhost:5433/rovenue";
process.env.REDIS_URL ??= "redis://localhost:6380";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { Readable } from "node:stream";
import { Pool } from "pg";
import bcrypt from "bcryptjs";
import { drizzle as drizzleClient } from "drizzle-orm/node-postgres";
import { eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import { drizzle as rovenueDb } from "@rovenue/db";
import { apiKeyAuth } from "../../middleware/api-key-auth";
import { errorHandler } from "../../middleware/error";

vi.mock("../../queues/dsar", () => ({
  DSAR_EXPORT_JOB_NAME: "dsar:export",
  DSAR_ERASURE_JOB_NAME: "dsar:erasure",
  enqueueDsarJob: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../lib/import-store", () => ({
  objectExists: vi.fn().mockResolvedValue(false),
  getObject: vi.fn(),
  isObjectNotFoundError: vi.fn().mockReturnValue(false),
}));

import { dsarRoute, DSAR_ENDPOINT_MAX_PER_MINUTE } from "./dsar";
import { enqueueDsarJob, DSAR_EXPORT_JOB_NAME } from "../../queues/dsar";
import * as importStore from "../../lib/import-store";

// ---------------------------------------------------------------------------
// DB setup
// ---------------------------------------------------------------------------
const schema = rovenueDb.schema;

let pool: Pool;
let testDb: ReturnType<typeof drizzleClient<typeof rovenueDb.schema>>;

const RUN_ID = Date.now();
let PROJECT_ID: string;
let OTHER_PROJECT_ID: string;
let PUBLIC_KEY: string;

// ---------------------------------------------------------------------------
// App under test
// ---------------------------------------------------------------------------
function buildApp() {
  const app = new Hono().use("*", apiKeyAuth("any")).route("/v1/dsar", dsarRoute);
  app.onError(errorHandler);
  return app;
}

function post(path: string, key: string, body: unknown) {
  return buildApp().request(`/v1/dsar${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
}

function get(path: string, key: string) {
  return buildApp().request(`/v1/dsar${path}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${key}` },
  });
}

// ---------------------------------------------------------------------------
// Seeding helpers
// ---------------------------------------------------------------------------
async function seedSubscriber(
  projectId: string,
  suffix: string,
): Promise<{ id: string; rovenueId: string }> {
  const rovenueId = `rov_${RUN_ID}_${suffix}`;
  const [row] = await testDb
    .insert(schema.subscribers)
    .values({ projectId, rovenueId })
    .returning();
  if (!row) throw new Error("seed: subscriber insert returned no row");
  return { id: row.id, rovenueId };
}

/** Mints a real, working secret key row (real bcrypt hash — mirrors
 *  virtual-currencies.integration.test.ts's `SECRET_KEY` setup) so every
 *  test that needs auth ISOLATION (a fresh rate-limit bucket) can have
 *  its own. */
async function mintSecretKey(projectId: string, label: string): Promise<string> {
  const id = createId();
  const random = createId();
  const rawKey = `rov_sec_${id}_${random}`;
  const hash = await bcrypt.hash(rawKey, 10);
  await testDb.insert(schema.apiKeys).values({
    id,
    projectId,
    label: `test-secret-${label}`,
    keyPublic: `rov_pub_placeholder_${id}`,
    keySecretHash: hash,
    environment: "PRODUCTION",
  });
  return rawKey;
}

async function seedDsarRequest(
  projectId: string,
  subscriberId: string,
  type: "EXPORT" | "ERASURE" = "EXPORT",
) {
  return rovenueDb.dsarRequestRepo.createDsarRequest(rovenueDb.db, {
    projectId,
    subscriberId,
    type,
    requestedBy: "support@customer.example",
  });
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
beforeAll(async () => {
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  testDb = drizzleClient(pool, { schema });

  const [project, otherProject] = await testDb
    .insert(schema.projects)
    .values([
      { name: `dsar-e2e-${RUN_ID}` },
      { name: `dsar-e2e-other-${RUN_ID}` },
    ])
    .returning();
  if (!project || !otherProject) throw new Error("seed: project insert returned no row");
  PROJECT_ID = project.id;
  OTHER_PROJECT_ID = otherProject.id;

  PUBLIC_KEY = `rov_pub_${createId()}`;
  await testDb.insert(schema.apiKeys).values({
    projectId: PROJECT_ID,
    label: "test-public-key",
    keyPublic: PUBLIC_KEY,
    keySecretHash: "n/a",
    environment: "PRODUCTION",
  });
}, 20_000);

afterAll(async () => {
  for (const id of [PROJECT_ID, OTHER_PROJECT_ID]) {
    await testDb.delete(schema.dsarRequests).where(eq(schema.dsarRequests.projectId, id));
    await testDb.delete(schema.apiKeys).where(eq(schema.apiKeys.projectId, id));
    await testDb.delete(schema.subscribers).where(eq(schema.subscribers.projectId, id));
    await testDb.delete(schema.projects).where(eq(schema.projects.id, id));
  }
  await pool.end();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------
describe("DSAR routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(importStore.objectExists).mockResolvedValue(false);
  });

  it("creates an EXPORT request and enqueues exactly one job", async () => {
    const key = await mintSecretKey(PROJECT_ID, "create");
    const sub = await seedSubscriber(PROJECT_ID, "create");

    const res = await post("/export", key, {
      appUserId: sub.rovenueId,
      requestedBy: "support@customer.example",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.request.type).toBe("EXPORT");
    expect(body.data.request.status).toBe("PENDING");

    expect(vi.mocked(enqueueDsarJob)).toHaveBeenCalledOnce();
    expect(vi.mocked(enqueueDsarJob)).toHaveBeenCalledWith(
      DSAR_EXPORT_JOB_NAME,
      expect.objectContaining({
        dsarRequestId: body.data.request.id,
        projectId: PROJECT_ID,
        subscriberId: sub.id,
        type: "EXPORT",
      }),
    );
  });

  it("returns the SAME request when the same subject asks twice", async () => {
    // Idempotency at the route, on top of the database constraint.
    // Assert one request id AND that a second job was not enqueued.
    const key = await mintSecretKey(PROJECT_ID, "idempotent");
    const sub = await seedSubscriber(PROJECT_ID, "idempotent");

    const first = await post("/export", key, {
      appUserId: sub.rovenueId,
      requestedBy: "a@customer.example",
    });
    const second = await post("/export", key, {
      appUserId: sub.rovenueId,
      requestedBy: "b@customer.example",
    });

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = (await first.json()) as any;
    const secondBody = (await second.json()) as any;
    expect(secondBody.data.request.id).toBe(firstBody.data.request.id);
    expect(vi.mocked(enqueueDsarJob)).toHaveBeenCalledOnce();
  });

  it("refuses a subscriber belonging to another project", async () => {
    // 403/404 — decide and pin which, and say why in your report.
    // Pinned: 404. resolveSubscriber's own project-scoped lookup makes
    // a foreign-project subscriber indistinguishable from "no such
    // subscriber" — the same message either way, so a caller can't use
    // the status code to learn the subscriber exists elsewhere.
    const key = await mintSecretKey(PROJECT_ID, "foreign-post");
    const foreignSub = await seedSubscriber(OTHER_PROJECT_ID, "foreign-post");

    const res = await post("/export", key, {
      appUserId: foreignSub.rovenueId,
      requestedBy: "attacker@customer.example",
    });

    expect(res.status).toBe(404);
    expect(vi.mocked(enqueueDsarJob)).not.toHaveBeenCalled();
  });

  it("serves a subscriber belonging to the calling project", async () => {
    // The mirror. Without it the previous test passes against a route
    // that refuses everyone.
    const key = await mintSecretKey(PROJECT_ID, "own-post");
    const sub = await seedSubscriber(PROJECT_ID, "own-post");

    const res = await post("/export", key, {
      appUserId: sub.rovenueId,
      requestedBy: "support@customer.example",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.request.status).toBe("PENDING");
  });

  it("refuses a public API key", async () => {
    // These are secret-key S2S endpoints. A public key reaching them
    // would let anyone with a client bundle erase other people's data.
    const sub = await seedSubscriber(PROJECT_ID, "public-key");

    const res = await post("/export", PUBLIC_KEY, {
      appUserId: sub.rovenueId,
      requestedBy: "support@customer.example",
    });

    expect(res.status).toBe(403);
  });

  it("enforces the rate limit across export AND erasure together", async () => {
    // Alternating the two routes must not double the budget.
    const key = await mintSecretKey(PROJECT_ID, "rate-limit");
    const subs = await Promise.all(
      Array.from({ length: DSAR_ENDPOINT_MAX_PER_MINUTE + 1 }, (_, i) =>
        seedSubscriber(PROJECT_ID, `rl-${i}`),
      ),
    );

    const statuses: number[] = [];
    for (let i = 0; i < subs.length; i += 1) {
      const route = i % 2 === 0 ? "/export" : "/erasure";
      const res = await post(route, key, {
        appUserId: subs[i]!.rovenueId,
        requestedBy: "support@customer.example",
      });
      statuses.push(res.status);
    }

    expect(statuses.slice(0, DSAR_ENDPOINT_MAX_PER_MINUTE)).toEqual(
      Array(DSAR_ENDPOINT_MAX_PER_MINUTE).fill(200),
    );
    expect(statuses[DSAR_ENDPOINT_MAX_PER_MINUTE]).toBe(429);
  });

  it("refuses to download a request that is not COMPLETED", async () => {
    const key = await mintSecretKey(PROJECT_ID, "dl-not-completed");
    const sub = await seedSubscriber(PROJECT_ID, "dl-not-completed");
    const created = await seedDsarRequest(PROJECT_ID, sub.id);

    const res = await get(`/${created.id}/download`, key);

    expect(res.status).toBe(404);
    expect(vi.mocked(importStore.getObject)).not.toHaveBeenCalled();
  });

  it("refuses to download an expired request", async () => {
    const key = await mintSecretKey(PROJECT_ID, "dl-expired");
    const sub = await seedSubscriber(PROJECT_ID, "dl-expired");
    const created = await seedDsarRequest(PROJECT_ID, sub.id);
    await rovenueDb.dsarRequestRepo.claimDsarRequest(rovenueDb.db, created.id);
    await rovenueDb.dsarRequestRepo.completeDsarRequest(rovenueDb.db, {
      id: created.id,
      artifactKey: "dsar-exports/expired.json",
      expiresAt: new Date(Date.now() - 60_000),
    });

    const res = await get(`/${created.id}/download`, key);

    expect(res.status).toBe(404);
    expect(vi.mocked(importStore.getObject)).not.toHaveBeenCalled();
  });

  it("refuses to download another project's request", async () => {
    const key = await mintSecretKey(PROJECT_ID, "dl-foreign");
    const foreignSub = await seedSubscriber(OTHER_PROJECT_ID, "dl-foreign");
    const created = await seedDsarRequest(OTHER_PROJECT_ID, foreignSub.id);
    await rovenueDb.dsarRequestRepo.claimDsarRequest(rovenueDb.db, created.id);
    await rovenueDb.dsarRequestRepo.completeDsarRequest(rovenueDb.db, {
      id: created.id,
      artifactKey: "dsar-exports/foreign.json",
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const res = await get(`/${created.id}/download`, key);

    expect(res.status).toBe(404);
    expect(vi.mocked(importStore.getObject)).not.toHaveBeenCalled();
  });

  it("serves a completed download to the owning project", async () => {
    // The mirror for the download route: without this, the previous
    // three refusal tests would pass against a download route that
    // refuses every request, completed-and-owned included.
    vi.mocked(importStore.objectExists).mockResolvedValueOnce(true);
    vi.mocked(importStore.getObject).mockResolvedValueOnce(
      Readable.from(["hello dsar export"]) as never,
    );
    const key = await mintSecretKey(PROJECT_ID, "dl-own");
    const sub = await seedSubscriber(PROJECT_ID, "dl-own");
    const created = await seedDsarRequest(PROJECT_ID, sub.id);
    await rovenueDb.dsarRequestRepo.claimDsarRequest(rovenueDb.db, created.id);
    await rovenueDb.dsarRequestRepo.completeDsarRequest(rovenueDb.db, {
      id: created.id,
      artifactKey: "dsar-exports/own.json",
      expiresAt: new Date(Date.now() + 3_600_000),
    });

    const res = await get(`/${created.id}/download`, key);

    expect(res.status).toBe(200);
    expect(await res.text()).toBe("hello dsar export");
  });

  it("refuses to fetch another project's request via GET /:id", async () => {
    // Same IDOR risk the brief flags for /download applies equally to
    // the plain GET — both take the id straight from the caller.
    const key = await mintSecretKey(PROJECT_ID, "get-foreign");
    const foreignSub = await seedSubscriber(OTHER_PROJECT_ID, "get-foreign");
    const created = await seedDsarRequest(OTHER_PROJECT_ID, foreignSub.id);

    const res = await get(`/${created.id}`, key);

    expect(res.status).toBe(404);
  });

  it("serves the calling project's own request via GET /:id", async () => {
    // The mirror for GET /:id.
    const key = await mintSecretKey(PROJECT_ID, "get-own");
    const sub = await seedSubscriber(PROJECT_ID, "get-own");
    const created = await seedDsarRequest(PROJECT_ID, sub.id);

    const res = await get(`/${created.id}`, key);

    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.request.id).toBe(created.id);
  });
});
