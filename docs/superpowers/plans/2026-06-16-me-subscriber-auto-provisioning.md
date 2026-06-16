# /v1/me Subscriber Auto-Provisioning Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A brand-new SDK user can read entitlements/credits/access (empty, `200`) instead of getting a `404 "Subscriber not found"` surfaced as `InternalError`.

**Architecture:** Server-only. The `/v1/me/*` middleware (`app-user-context`) resolves-or-creates the subscriber (lazy idempotent upsert, mirroring `/v1/config`). Add the missing `GET /v1/me/entitlements` route returning the SDK's expected `{ data: { entitlements: {…} } }` shape. The secret-key `/v1/subscribers/:appUserId/*` family is left untouched (still `404`s for unknown users — that path addresses a *specific* user).

**Tech Stack:** Hono, Drizzle, Vitest (unit + testcontainers/Postgres integration). No SDK/Rust change.

**Spec:** `docs/superpowers/specs/2026-06-16-me-subscriber-auto-provisioning-design.md`

---

## File Structure

- **Create** `apps/api/src/lib/resolve-or-create-subscriber.ts` — resolve-by-rovenueId-or-upsert helper for the `/v1/me/*` path.
- **Create** `apps/api/src/lib/resolve-or-create-subscriber.test.ts` — unit test (mocked repo).
- **Modify** `apps/api/src/middleware/app-user-context.ts` — use the new helper.
- **Modify** `apps/api/src/routes/v1/me.ts` — add `GET /entitlements`.
- **Create** `apps/api/src/routes/v1/me-auto-provision.integration.test.ts` — DB-backed: fresh user → empty 200 + row created; entitlements shape.
- **Create** `apps/api/src/lib/resolve-subscriber.test.ts` — guard: `resolveSubscriber` still 404s for unknown (Req #2 regression).

Verified facts this plan relies on:
- `drizzle.subscriberRepo.resolveSubscriberByRovenueId(db, { projectId, rovenueId })` → `Subscriber | null` (follows `mergedInto`).
- `drizzle.subscriberRepo.upsertSubscriber(db, { projectId, rovenueId, createAttributes? })` → `Subscriber` (idempotent on `(projectId, rovenueId)`).
- `buildAccessResponse(subscriberId)` → `Record<string, { isActive, expiresDate, store, productIdentifier }>` — **identical** to the SDK's `EntitlementWire` (serde `isActive`/`expiresDate`/`store`/`productIdentifier`). Empty subscriber → `{}`.
- `ok(x)` wraps as `{ data: x }`. `errorHandler` maps `HTTPException(404)` → `{ error: { code: "NOT_FOUND", message } }`.

---

### Task 1: `resolveOrCreateSubscriber` helper

**Files:**
- Create: `apps/api/src/lib/resolve-or-create-subscriber.ts`
- Test: `apps/api/src/lib/resolve-or-create-subscriber.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/api/src/lib/resolve-or-create-subscriber.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";

const { resolveByRovenueId, upsert } = vi.hoisted(() => ({
  resolveByRovenueId: vi.fn(),
  upsert: vi.fn(),
}));

vi.mock("@rovenue/db", () => ({
  drizzle: {
    db: {},
    subscriberRepo: {
      resolveSubscriberByRovenueId: resolveByRovenueId,
      upsertSubscriber: upsert,
    },
  },
}));

import { resolveOrCreateSubscriber } from "./resolve-or-create-subscriber";

describe("resolveOrCreateSubscriber", () => {
  beforeEach(() => {
    resolveByRovenueId.mockReset();
    upsert.mockReset();
  });

  it("returns the existing subscriber without creating", async () => {
    resolveByRovenueId.mockResolvedValue({ id: "s1", rovenueId: "r1" });
    const sub = await resolveOrCreateSubscriber("p1", "r1");
    expect(sub).toEqual({ id: "s1", rovenueId: "r1" });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("creates a minimal anonymous subscriber when none exists", async () => {
    resolveByRovenueId.mockResolvedValue(null);
    upsert.mockResolvedValue({ id: "s2", rovenueId: "r2" });
    const sub = await resolveOrCreateSubscriber("p1", "r2");
    expect(sub).toEqual({ id: "s2", rovenueId: "r2" });
    expect(upsert).toHaveBeenCalledWith({}, {
      projectId: "p1",
      rovenueId: "r2",
      createAttributes: {},
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api exec vitest run src/lib/resolve-or-create-subscriber.test.ts`
Expected: FAIL — `Failed to resolve import "./resolve-or-create-subscriber"` / module not found.

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/api/src/lib/resolve-or-create-subscriber.ts
import { drizzle, type Subscriber } from "@rovenue/db";

/**
 * Resolves the subscriber for an inbound public-key /v1/me request by
 * rovenueId (following mergedInto redirects). When none exists yet, creates
 * a minimal anonymous subscriber and returns it, so a brand-new SDK user can
 * read entitlements/credits/access (empty) without a 404. Mirrors the upsert
 * /v1/config already performs. Idempotent: upsertSubscriber is a no-op on
 * (projectId, rovenueId) conflict, so concurrent first-calls converge.
 */
export async function resolveOrCreateSubscriber(
  projectId: string,
  key: string,
): Promise<Subscriber> {
  const existing =
    await drizzle.subscriberRepo.resolveSubscriberByRovenueId(drizzle.db, {
      projectId,
      rovenueId: key,
    });
  if (existing) return existing as Subscriber;
  return drizzle.subscriberRepo.upsertSubscriber(drizzle.db, {
    projectId,
    rovenueId: key,
    createAttributes: {},
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api exec vitest run src/lib/resolve-or-create-subscriber.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/resolve-or-create-subscriber.ts apps/api/src/lib/resolve-or-create-subscriber.test.ts
git commit -m "feat(api): add resolveOrCreateSubscriber for /v1/me auto-provisioning"
```

---

### Task 2: Wire auto-provisioning into the `/v1/me/*` middleware

**Files:**
- Modify: `apps/api/src/middleware/app-user-context.ts`
- Test: `apps/api/src/routes/v1/me-auto-provision.integration.test.ts`

- [ ] **Step 1: Write the failing integration test**

```ts
// apps/api/src/routes/v1/me-auto-provision.integration.test.ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api exec vitest run src/routes/v1/me-auto-provision.integration.test.ts`
Expected: FAIL — first test gets `404` (current `resolveSubscriber` throws "Subscriber not found"), so `res.status` is `404`, not `200`. (Requires Postgres on `localhost:5433`.)

- [ ] **Step 3: Switch the middleware to resolve-or-create**

Replace the resolver in `apps/api/src/middleware/app-user-context.ts`. Change the import:

```ts
// remove:  import { resolveSubscriber } from "../lib/resolve-subscriber";
import { resolveOrCreateSubscriber } from "../lib/resolve-or-create-subscriber";
```

And the call inside the handler:

```ts
  const subscriber = await resolveOrCreateSubscriber(project.id, key);
  c.set("subscriber", subscriber);
  await next();
```

Leave the missing-header `400` check above it unchanged.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api exec vitest run src/routes/v1/me-auto-provision.integration.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/middleware/app-user-context.ts apps/api/src/routes/v1/me-auto-provision.integration.test.ts
git commit -m "feat(api): auto-provision subscriber on /v1/me/* (anonymous reads return empty)"
```

---

### Task 3: Add `GET /v1/me/entitlements`

**Files:**
- Modify: `apps/api/src/routes/v1/me.ts`
- Test: `apps/api/src/routes/v1/me-auto-provision.integration.test.ts` (extend)

- [ ] **Step 1: Add the failing test (append a describe block to the Task 2 file)**

```ts
function getEntitlements(userId: string) {
  return buildApp().request("/v1/me/entitlements", {
    method: "GET",
    headers: { Authorization: `Bearer ${PUBLIC_KEY}`, "X-Rovenue-App-User-Id": userId },
  });
}

describe("GET /v1/me/entitlements", () => {
  it("returns { data: { entitlements: {} } } for a fresh user (SDK contract shape)", async () => {
    const res = await getEntitlements(`ent-${createId().slice(0, 8)}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data).toHaveProperty("entitlements");
    expect(body.data.entitlements).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api exec vitest run src/routes/v1/me-auto-provision.integration.test.ts -t "entitlements"`
Expected: FAIL — `404` (route does not exist yet; after the middleware runs, no `/entitlements` handler matches → 404).

- [ ] **Step 3: Add the route to `me.ts`**

Insert directly after the `.get("/access", …)` block:

```ts
  // -------------------------------------------------------------
  // GET /me/entitlements — SDK entitlements contract
  // -------------------------------------------------------------
  // Same data as /me/access; reshaped to { data: { entitlements } } so the
  // SDK core (entitlements/reader.rs) deserializes it. AccessResponseEntry
  // is byte-identical to the SDK's EntitlementWire.
  .get("/entitlements", async (c) => {
    const subscriber = c.get("subscriber");
    const entitlements = await buildAccessResponse(subscriber.id);
    return c.json(ok({ entitlements }));
  })
```

(`buildAccessResponse` and `ok` are already imported in `me.ts`.)

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @rovenue/api exec vitest run src/routes/v1/me-auto-provision.integration.test.ts`
Expected: PASS (all tests, including entitlements).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/v1/me.ts apps/api/src/routes/v1/me-auto-provision.integration.test.ts
git commit -m "feat(api): add GET /v1/me/entitlements matching the SDK contract"
```

---

### Task 4: Guard — `resolveSubscriber` still 404s for unknown users (Req #2 regression)

**Files:**
- Test: `apps/api/src/lib/resolve-subscriber.test.ts`

This proves the secret-key `/v1/subscribers/:appUserId/*` family (which uses `resolveSubscriber`) was NOT changed to auto-create.

- [ ] **Step 1: Write the test**

```ts
// apps/api/src/lib/resolve-subscriber.test.ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HTTPException } from "hono/http-exception";

const { resolveByRovenueId } = vi.hoisted(() => ({ resolveByRovenueId: vi.fn() }));
vi.mock("@rovenue/db", () => ({
  drizzle: {
    db: {},
    subscriberRepo: { resolveSubscriberByRovenueId: resolveByRovenueId },
  },
}));

import { resolveSubscriber } from "./resolve-subscriber";

describe("resolveSubscriber (explicit/secret-key family)", () => {
  beforeEach(() => resolveByRovenueId.mockReset());

  it("throws a 404 HTTPException with a clear message for an unknown user", async () => {
    resolveByRovenueId.mockResolvedValue(null);
    await expect(resolveSubscriber("p1", "ghost")).rejects.toMatchObject({
      status: 404,
    });
    // message clarity
    try {
      await resolveSubscriber("p1", "ghost");
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(HTTPException);
      expect((err as HTTPException).message).toBe("Subscriber ghost not found");
    }
  });

  it("returns the subscriber when found (no creation)", async () => {
    resolveByRovenueId.mockResolvedValue({ id: "s1", rovenueId: "ghost" });
    const sub = await resolveSubscriber("p1", "ghost");
    expect(sub).toEqual({ id: "s1", rovenueId: "ghost" });
  });
});
```

- [ ] **Step 2: Run test to verify it passes immediately (guard, no prod change)**

Run: `pnpm --filter @rovenue/api exec vitest run src/lib/resolve-subscriber.test.ts`
Expected: PASS (2 tests). If it FAILS, someone changed `resolveSubscriber` — revert that; only `app-user-context` should resolve-or-create.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/lib/resolve-subscriber.test.ts
git commit -m "test(api): guard resolveSubscriber still 404s unknown users"
```

---

### Task 5: Full type + suite check

- [ ] **Step 1: Typecheck the api package**

Run: `pnpm --filter @rovenue/api build`
Expected: exit 0 (tsc clean).

- [ ] **Step 2: Run the new unit tests together**

Run: `pnpm --filter @rovenue/api exec vitest run src/lib/resolve-or-create-subscriber.test.ts src/lib/resolve-subscriber.test.ts`
Expected: PASS.

- [ ] **Step 3: Run the integration test (requires Postgres on :5433)**

Run: `pnpm --filter @rovenue/api exec vitest run src/routes/v1/me-auto-provision.integration.test.ts`
Expected: PASS. (Skip if no DB available in this environment; note it in the report.)

- [ ] **Step 4: Manual verification against the running API + sample app**

With the local API on `:3000` and a real public key, the SDK's `refreshEntitlements` (`GET /v1/me/entitlements`) now returns `200 { data: { entitlements: {} } }` for a fresh user instead of the `InternalError` shown in the app log. Reload the sample app and confirm the "Access" panel shows "No active entitlements" with no error in the log.

---

## Self-Review

**Spec coverage:**
- §1 auto-provision on `/v1/me/*` → Task 1 (helper) + Task 2 (wire-in + integration).
- §2 add `GET /v1/me/entitlements` (SDK shape) → Task 3.
- §3 unknown user → clear 404 on explicit family (don't change `resolveSubscriber`) → Task 4 guard.
- Out-of-scope SDK error mapping → intentionally not a task (documented in spec).

**Placeholder scan:** none — every step has full code/commands.

**Type consistency:** `resolveOrCreateSubscriber(projectId, key)` used identically in Task 1 and Task 2; `upsertSubscriber(db, { projectId, rovenueId, createAttributes })` matches the verified repo signature; `buildAccessResponse` → entitlements map matches the SDK `EntitlementWire` shape; `ok()` envelope assertions match `errorHandler`.
