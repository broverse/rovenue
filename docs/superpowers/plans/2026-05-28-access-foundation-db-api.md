# Access Foundation — DB + API Rename Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rename the entitlement concept to `access` across DB schema and API layer. Add a first-class `access` catalog table (replacing free-form `text[]` strings), rename `product_groups` → `offerings` with a new `accessId` FK so A/B testing has a proper hook, and re-align all internal field names (`entitlementKey/s` → `accessId/s`). Pre-launch context: no compatibility shim — clean rename, single migration per logical change.

**Architecture:**
- New `access` table is project-scoped catalog (`id`, `projectId`, `identifier`, `displayName`, `description`, `metadata`) — single source of truth, replaces typo-prone `text[]` strings.
- `products.entitlementKeys: text[]` → `products.accessIds: text[]` (still array — a product can grant multiple access rights). Values are `access.id` FKs validated at the app layer (text[] arrays can't have a true PG FK; app-layer Zod check + admin UI dropdown enforces).
- `subscriber_access.entitlementKey: text` → `subscriber_access.accessId: text` (FK to `access.id`).
- `product_groups` → `offerings`, gains `accessId: text NOT NULL` FK — every offering is scoped to one Access (enables `getOffering(accessId, placement?)` SDK contract).
- All `*-engine`, `*-response`, webhook, and route code mirrors the rename. API contracts change in the same PR (pre-launch — acceptable).
- ClickHouse: `subscriber_access` and `products` aren't mirrored to CH (only `revenue_events` + `credit_ledger` are per CLAUDE.md). No CH migration needed.

**Tech Stack:** Postgres 16, Drizzle ORM, drizzle-kit migrations, Hono, Zod, Vitest + testcontainers, pnpm workspace.

**Out of scope (separate plans):**
- SDK rename across Rust core + Swift/Kotlin/RN (Plan 2)
- Dashboard UI refactor: Access page + Offerings sub-section (Plan 3)

---

## File Structure

### Created files
- `packages/db/src/drizzle/repositories/access-catalog.ts` — CRUD for the new `access` table
- `packages/db/src/drizzle/repositories/offerings.ts` — replaces `product-groups.ts` (renamed)
- `apps/api/src/routes/dashboard/access.ts` — Dashboard `/dashboard/access` CRUD
- `apps/api/src/routes/dashboard/offerings.ts` — replaces `product-groups.ts` (renamed)
- `apps/api/src/routes/v1/offerings.ts` — replaces `product-groups.ts` (renamed)
- `packages/db/drizzle/migrations/0053_access_foundation.sql` — single migration for all schema changes (auto-generated)

### Modified files
- `packages/db/src/drizzle/schema.ts` — add `access`; rename columns/tables
- `packages/db/src/drizzle/repositories/access.ts` — rename `entitlementKey` → `accessId` in all signatures (file stays — it's the subscriber-access repo, name is fine)
- `packages/db/src/drizzle/repositories/products.ts` — `entitlementKeys` → `accessIds`
- `packages/db/src/drizzle/repositories/product-groups.ts` — DELETED (replaced by offerings.ts)
- `packages/db/src/drizzle/validators.ts` — rename `entitlementKey` validator
- `packages/db/src/drizzle/index.ts` — barrel exports update
- `packages/db/seed.ts` — update field names + create access catalog rows
- `packages/shared/src/dashboard.ts` — type renames (`entitlementKey/s` → `accessId/s`, `productGroups` → `offerings`)
- `apps/api/src/services/access-engine.ts` — rename internals
- `apps/api/src/lib/access-response.ts` — rename internals + API response keys
- `apps/api/src/services/subscriptions/grant.ts` — field renames
- `apps/api/src/services/apple/apple-webhook.ts` — field renames
- `apps/api/src/services/google/google-webhook.ts` — field renames
- `apps/api/src/services/stripe/stripe-webhook.ts` — field renames
- `apps/api/src/services/subscriber-transfer.ts` — field renames
- `apps/api/src/routes/dashboard/index.ts` — route mount updates
- `apps/api/src/routes/dashboard/products.ts` — field renames
- `apps/api/src/routes/dashboard/subscribers.ts` — field renames
- `apps/api/src/routes/v1/index.ts` — route mount update (product-groups → offerings)
- `apps/api/src/routes/v1/me.ts` — response shape update
- `apps/dashboard/src/lib/dashboard-mappers.ts` — field renames (mapper layer only — UI components are Plan 3)
- `apps/dashboard/tests/msw/handlers.ts` — MSW mock field renames

### Deleted files
- `packages/db/src/drizzle/repositories/product-groups.ts` (replaced by `offerings.ts`)
- `apps/api/src/routes/dashboard/product-groups.ts` (replaced by `offerings.ts`)
- `apps/api/src/routes/v1/product-groups.ts` (replaced by `offerings.ts`)

---

## Task 1: Add `access` table to Drizzle schema

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts`
- Test: `packages/db/src/drizzle/drizzle-foundation.test.ts`

- [ ] **Step 1: Write the failing test for `access` table shape**

Add to `packages/db/src/drizzle/drizzle-foundation.test.ts`:

```typescript
import { access } from "./schema";

describe("access table", () => {
  it("has the catalog columns", () => {
    const cols = Object.keys(access);
    expect(cols).toEqual(
      expect.arrayContaining([
        "id",
        "projectId",
        "identifier",
        "displayName",
        "description",
        "metadata",
        "createdAt",
        "updatedAt",
      ]),
    );
  });

  it("creates and retrieves a row scoped to project", async () => {
    const project = await createTestProject();
    const [row] = await db
      .insert(access)
      .values({
        projectId: project.id,
        identifier: "pro",
        displayName: "Pro Access",
        description: "Unlocks paid features",
      })
      .returning();
    expect(row.identifier).toBe("pro");
    expect(row.metadata).toEqual({});
  });

  it("enforces (projectId, identifier) uniqueness", async () => {
    const project = await createTestProject();
    await db.insert(access).values({
      projectId: project.id,
      identifier: "dup",
      displayName: "Dup",
    });
    await expect(
      db.insert(access).values({
        projectId: project.id,
        identifier: "dup",
        displayName: "Dup 2",
      }),
    ).rejects.toThrow(/duplicate key/i);
  });
});
```

- [ ] **Step 2: Run test, confirm it fails**

```bash
pnpm --filter @rovenue/db test -- drizzle-foundation
```

Expected: FAIL with "Cannot find name 'access'" or "access is not defined".

- [ ] **Step 3: Add the table to `schema.ts`**

In `packages/db/src/drizzle/schema.ts`, immediately before the existing `products` table (around line 520), add:

```typescript
// =============================================================
// access (catalog of access rights — replaces free-form
// entitlement key strings). One row per (projectId, identifier).
// Referenced from products.accessIds[] and subscriber_access.accessId.
// =============================================================

export const access = pgTable(
  "access",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    identifier: text("identifier").notNull(),
    displayName: text("displayName").notNull(),
    description: text("description"),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    projectIdIdentifierKey: uniqueIndex(
      "access_projectId_identifier_key",
    ).on(t.projectId, t.identifier),
  }),
);

export type AccessRow = typeof access.$inferSelect;
export type NewAccessRow = typeof access.$inferInsert;
```

Update the type exports block at the bottom of the file to include `AccessRow` and `NewAccessRow`.

- [ ] **Step 4: Generate the migration**

```bash
pnpm db:migrate:generate
```

Inspect the generated SQL file (will be `0053_*.sql`). It should contain:
- `CREATE TABLE "access"`
- `ALTER TABLE "access" ADD CONSTRAINT "access_projectId_projects_id_fk"`
- `CREATE UNIQUE INDEX "access_projectId_identifier_key"`

If naming is wrong, rename the file to `0053_access_foundation.sql`.

- [ ] **Step 5: Run the migration and re-run test**

```bash
pnpm db:migrate
pnpm --filter @rovenue/db test -- drizzle-foundation
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/drizzle/schema.ts \
        packages/db/src/drizzle/drizzle-foundation.test.ts \
        packages/db/drizzle/migrations/0053_access_foundation.sql \
        packages/db/drizzle/migrations/meta/
git commit -m "feat(db): add access catalog table"
```

---

## Task 2: Add access-catalog repository

**Files:**
- Create: `packages/db/src/drizzle/repositories/access-catalog.ts`
- Modify: `packages/db/src/drizzle/index.ts`
- Test: `packages/db/src/drizzle/repositories/access-catalog.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/db/src/drizzle/repositories/access-catalog.test.ts`:

```typescript
import { describe, expect, it, beforeEach } from "vitest";
import { withTestDb } from "../../helpers/with-test-db";
import { drizzle } from "../index";

describe("accessCatalogRepo", () => {
  withTestDb();

  let projectId: string;
  beforeEach(async () => {
    const project = await drizzle.projectRepo.createProject(drizzle.db, {
      name: "Test",
      slug: "test",
      ownerId: "u_test",
    });
    projectId = project.id;
  });

  it("creates, lists, gets by identifier, updates, deletes", async () => {
    const created = await drizzle.accessCatalogRepo.create(drizzle.db, {
      projectId,
      identifier: "pro",
      displayName: "Pro Access",
    });
    expect(created.identifier).toBe("pro");

    const listed = await drizzle.accessCatalogRepo.list(drizzle.db, projectId);
    expect(listed).toHaveLength(1);

    const fetched = await drizzle.accessCatalogRepo.findByIdentifier(
      drizzle.db,
      projectId,
      "pro",
    );
    expect(fetched?.id).toBe(created.id);

    await drizzle.accessCatalogRepo.update(drizzle.db, created.id, {
      displayName: "Pro+",
    });
    const refetched = await drizzle.accessCatalogRepo.findById(
      drizzle.db,
      created.id,
    );
    expect(refetched?.displayName).toBe("Pro+");

    await drizzle.accessCatalogRepo.deleteById(drizzle.db, created.id);
    expect(
      await drizzle.accessCatalogRepo.findById(drizzle.db, created.id),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run test, confirm it fails**

```bash
pnpm --filter @rovenue/db test -- access-catalog
```

Expected: FAIL ("accessCatalogRepo is undefined").

- [ ] **Step 3: Implement the repo**

Create `packages/db/src/drizzle/repositories/access-catalog.ts`:

```typescript
import { and, eq } from "drizzle-orm";
import type { Db } from "../client";
import { access, type AccessRow, type NewAccessRow } from "../schema";

export async function create(
  db: Db,
  input: Omit<NewAccessRow, "id" | "createdAt" | "updatedAt">,
): Promise<AccessRow> {
  const [row] = await db.insert(access).values(input).returning();
  return row;
}

export async function list(
  db: Db,
  projectId: string,
): Promise<AccessRow[]> {
  return db
    .select()
    .from(access)
    .where(eq(access.projectId, projectId))
    .orderBy(access.createdAt);
}

export async function findById(
  db: Db,
  id: string,
): Promise<AccessRow | null> {
  const rows = await db.select().from(access).where(eq(access.id, id)).limit(1);
  return rows[0] ?? null;
}

export async function findByIdentifier(
  db: Db,
  projectId: string,
  identifier: string,
): Promise<AccessRow | null> {
  const rows = await db
    .select()
    .from(access)
    .where(
      and(eq(access.projectId, projectId), eq(access.identifier, identifier)),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function findByIds(
  db: Db,
  ids: string[],
): Promise<AccessRow[]> {
  if (ids.length === 0) return [];
  return db.select().from(access).where(inArray(access.id, ids));
}

export async function update(
  db: Db,
  id: string,
  patch: Partial<Pick<AccessRow, "identifier" | "displayName" | "description" | "metadata">>,
): Promise<void> {
  await db
    .update(access)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(access.id, id));
}

export async function deleteById(db: Db, id: string): Promise<void> {
  await db.delete(access).where(eq(access.id, id));
}
```

Add `inArray` to the import line (`from "drizzle-orm"`).

- [ ] **Step 4: Wire into barrel export**

In `packages/db/src/drizzle/index.ts`, add:

```typescript
import * as accessCatalogRepo from "./repositories/access-catalog";
```

And include `accessCatalogRepo` in the exported `drizzle` object alongside the other repos.

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @rovenue/db test -- access-catalog
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/drizzle/repositories/access-catalog.ts \
        packages/db/src/drizzle/repositories/access-catalog.test.ts \
        packages/db/src/drizzle/index.ts
git commit -m "feat(db): access catalog repository CRUD"
```

---

## Task 3: Rename `subscriber_access.entitlementKey` → `accessId` (FK)

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts:657-686`
- New migration auto-generated

- [ ] **Step 1: Update schema**

In `packages/db/src/drizzle/schema.ts`, in the `subscriberAccess` definition, replace:

```typescript
entitlementKey: text("entitlementKey").notNull(),
```

with:

```typescript
accessId: text("accessId")
  .notNull()
  .references(() => access.id, { onDelete: "restrict" }),
```

And update the index name:

```typescript
subscriberIdAccessIdIdx: index(
  "subscriber_access_subscriberId_accessId_idx",
).on(t.subscriberId, t.accessId),
```

(Remove the old `subscriberIdEntitlementKeyIdx`.)

- [ ] **Step 2: Generate migration**

```bash
pnpm db:migrate:generate
```

Inspect output. The migration should include:
- `ALTER TABLE subscriber_access RENAME COLUMN "entitlementKey" TO "accessId"` (drizzle-kit may instead drop+add — that's fine, data wipe is OK pre-launch)
- New FK constraint
- Index rename

If it generates a drop+add (data-destructive), accept it. Pre-launch context.

Rename file to `0054_subscriber_access_accessid.sql`.

- [ ] **Step 3: Run migration locally**

```bash
pnpm db:migrate:fresh   # wipes + reapplies all migrations from scratch
```

Expected: clean apply, no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/drizzle/schema.ts \
        packages/db/drizzle/migrations/0054_subscriber_access_accessid.sql \
        packages/db/drizzle/migrations/meta/
git commit -m "feat(db): rename subscriber_access.entitlementKey to accessId"
```

---

## Task 4: Rename `products.entitlementKeys` → `accessIds`

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts:520-556`
- New migration auto-generated

- [ ] **Step 1: Update schema**

In `packages/db/src/drizzle/schema.ts`, in the `products` definition, replace:

```typescript
entitlementKeys: text("entitlementKeys")
  .array()
  .notNull()
  .default(sql`ARRAY[]::text[]`),
```

with:

```typescript
accessIds: text("accessIds")
  .array()
  .notNull()
  .default(sql`ARRAY[]::text[]`),
```

> Note: Postgres `text[]` cannot enforce a true FK to `access.id`. Validation is done at the app layer (Task 7 — Zod check) and via the dashboard dropdown (Plan 3).

- [ ] **Step 2: Generate + rename migration**

```bash
pnpm db:migrate:generate
```

Rename to `0055_products_accessids.sql`.

- [ ] **Step 3: Run + verify**

```bash
pnpm db:migrate:fresh
```

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/drizzle/schema.ts \
        packages/db/drizzle/migrations/0055_products_accessids.sql \
        packages/db/drizzle/migrations/meta/
git commit -m "feat(db): rename products.entitlementKeys to accessIds"
```

---

## Task 5: Update `access` repo (subscriber-access repo)

**Files:**
- Modify: `packages/db/src/drizzle/repositories/access.ts` (entire file — see below)
- Tests covered by integration tests in `apps/api`

> The file is named `access.ts` already and it owns `subscriber_access`. Don't rename the file. Only rename the in-file identifiers.

- [ ] **Step 1: Replace `entitlementKey` → `accessId` everywhere**

In `packages/db/src/drizzle/repositories/access.ts`:

1. Rename parameter `entitlementKey: string` → `accessId: string` in:
   - `findAccessByPurchaseAndKey` (line 23–41) — also rename function to `findAccessByPurchaseAndAccessId`
   - `CreateAccessInput` interface (`entitlementKey` field → `accessId`)
   - `createAccess` — passes `accessId` into insert

2. Rename interface `PurchaseWithEntitlementKeys` → `PurchaseWithAccessIds`, field `entitlementKeys: string[]` → `accessIds: string[]`.

3. Rename function `findPurchasesWithEntitlementKeys` → `findPurchasesWithAccessIds`. Update select to pull `products.accessIds` instead of `products.entitlementKeys`.

4. Replace `subscriberAccess.entitlementKey` references with `subscriberAccess.accessId`.

After edits, the file should compile with zero references to `entitlementKey/Keys`.

- [ ] **Step 2: Update access-engine to use renamed signatures**

In `apps/api/src/services/access-engine.ts`:

- Rename const `ENTITLEMENT_GRANTING_STATUSES` → `ACCESS_GRANTING_STATUSES`.
- Change `drizzle.accessRepo.findPurchasesWithEntitlementKeys` → `findPurchasesWithAccessIds`.
- Rename loop variable `for (const key of purchase.entitlementKeys)` → `for (const accessId of purchase.accessIds)`.
- Change `desired.get(record.entitlementKey)` → `desired.get(record.accessId)`.
- Change `r.entitlementKey === key` → `r.accessId === accessId`.
- Change `entitlementKey: key,` in `createAccess` call → `accessId,`.
- In `hasAccess`: parameter `entitlementKey` → `accessId`; check `r.accessId === accessId`.
- In `getActiveAccess`: replace `record.entitlementKey` → `record.accessId` (keys of the returned map are now access IDs).

- [ ] **Step 3: Update access-response.ts**

In `apps/api/src/lib/access-response.ts`:

- The returned `Record<string, AccessResponseEntry>` keys were previously entitlement keys (strings like "pro"). They are now `access.id` values (cuid2 strings).
- This changes the API response shape — but we want the response keys to be the human-readable `access.identifier`, not the opaque ID. So add a lookup:

Replace the function body with:

```typescript
export async function buildAccessResponse(
  subscriberId: string,
): Promise<Record<string, AccessResponseEntry>> {
  const raw = await getActiveAccess(subscriberId);
  const accessIds = Object.keys(raw);
  if (accessIds.length === 0) return {};

  const [purchases, accessRows] = await Promise.all([
    drizzle.purchaseRepo.findPurchasesByIds(
      drizzle.db,
      Array.from(new Set(Object.values(raw).map((e) => e.purchaseId))),
    ),
    drizzle.accessCatalogRepo.findByIds(drizzle.db, accessIds),
  ]);

  const productByPurchase = new Map(
    purchases.map((p) => [p.id, p.product.identifier] as const),
  );
  const identifierByAccessId = new Map(
    accessRows.map((a) => [a.id, a.identifier] as const),
  );

  const result: Record<string, AccessResponseEntry> = {};
  for (const [accessId, entry] of Object.entries(raw)) {
    const identifier = identifierByAccessId.get(accessId);
    if (!identifier) continue; // access row was deleted — skip
    result[identifier] = {
      isActive: entry.isActive,
      expiresDate: entry.expiresDate ? entry.expiresDate.toISOString() : null,
      store: entry.store,
      productIdentifier:
        productByPurchase.get(entry.purchaseId) ?? "unknown",
    };
  }
  return result;
}
```

This keeps the SDK-facing key as the human-readable identifier (e.g., `"pro"`) while internally storing the FK.

- [ ] **Step 4: Run access-engine integration tests**

```bash
pnpm --filter @rovenue/api test -- access-engine
pnpm --filter @rovenue/api test -- access-response
```

Expected: PASS (or fail with errors only inside webhook services — fixed in next task).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/drizzle/repositories/access.ts \
        apps/api/src/services/access-engine.ts \
        apps/api/src/lib/access-response.ts
git commit -m "refactor(api): rename entitlementKey to accessId in access engine"
```

---

## Task 6: Update webhook services + grant + subscriber-transfer

**Files:**
- Modify: `apps/api/src/services/apple/apple-webhook.ts`
- Modify: `apps/api/src/services/google/google-webhook.ts`
- Modify: `apps/api/src/services/stripe/stripe-webhook.ts`
- Modify: `apps/api/src/services/subscriptions/grant.ts`
- Modify: `apps/api/src/services/subscriber-transfer.ts`

- [ ] **Step 1: Grep for all remaining references**

```bash
grep -rn "entitlementKey\|entitlementKeys" apps/api/src/services/ | grep -v ".test.ts"
```

Expected output: list of every call site to rename. Should be in the 5 files listed above.

- [ ] **Step 2: For each file, rename in-place**

In each of:
- `apps/api/src/services/apple/apple-webhook.ts`
- `apps/api/src/services/google/google-webhook.ts`
- `apps/api/src/services/stripe/stripe-webhook.ts`
- `apps/api/src/services/subscriptions/grant.ts`
- `apps/api/src/services/subscriber-transfer.ts`

Replace:
- `entitlementKeys` → `accessIds` (when reading from `products.entitlementKeys`)
- `entitlementKey` → `accessId` (single)
- `findAccessByPurchaseAndKey` → `findAccessByPurchaseAndAccessId`
- `findPurchasesWithEntitlementKeys` → `findPurchasesWithAccessIds`

> If a webhook reads `product.entitlementKeys` it should now read `product.accessIds`. The values are now `access.id` cuid2 strings, not human identifiers — code paths that compare against identifier strings need updating. Audit each match.

- [ ] **Step 3: Run integration tests**

```bash
pnpm --filter @rovenue/api test -- apple-webhook google-webhook stripe-webhook grant subscriber-transfer
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/
git commit -m "refactor(api): rename entitlement to access in webhook + grant services"
```

---

## Task 7: Update validators + shared types

**Files:**
- Modify: `packages/db/src/drizzle/validators.ts:55,130`
- Modify: `packages/shared/src/dashboard.ts:301,1284,1302,1313,1328`

- [ ] **Step 1: Update db validators**

In `packages/db/src/drizzle/validators.ts`:

- Line ~55 comment block: replace `entitlementKeys` mention with `accessIds`.
- Line ~130: rename validator key `entitlementKey: ...` → `accessId: ...` (regex stays — `accessId` is a cuid2 so regex should be relaxed to allow cuid2 characters; replace `/^[a-z0-9][a-z0-9_-]*$/i` with `/^[a-z0-9]{24}$/`). Verify cuid2 format with one test:

```typescript
import { validators } from "./validators";

describe("accessId validator", () => {
  it("accepts a cuid2", () => {
    expect(validators.accessId.parse("ck0000000000000000000000")).toBeTruthy();
  });
  it("rejects free-form text", () => {
    expect(() => validators.accessId.parse("pro")).toThrow();
  });
});
```

- [ ] **Step 2: Update shared dashboard types**

In `packages/shared/src/dashboard.ts`:

- Line 301: `entitlementKey: string;` → `accessId: string;`
- Line 1284: `entitlementKeys: string[];` → `accessIds: string[];`
- Line 1302, 1313, 1328: same rename in all create/update input shapes.

Also add new top-level types:

```typescript
export interface DashboardAccessRow {
  id: string;
  identifier: string;
  displayName: string;
  description: string | null;
  productCount: number;
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardAccessCreateInput {
  identifier: string;
  displayName: string;
  description?: string | null;
  metadata?: Record<string, unknown>;
}

export interface DashboardAccessUpdateInput
  extends Partial<DashboardAccessCreateInput> {}

export interface DashboardAccessListResponse {
  rows: DashboardAccessRow[];
}
```

- [ ] **Step 3: Run typecheck**

```bash
pnpm -w typecheck
```

Expected: PASS (any remaining type errors flag downstream files that still reference old field names).

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/drizzle/validators.ts \
        packages/shared/src/dashboard.ts
git commit -m "refactor(shared): rename entitlement types to access"
```

---

## Task 8: Add `/dashboard/access` CRUD route

**Files:**
- Create: `apps/api/src/routes/dashboard/access.ts`
- Modify: `apps/api/src/routes/dashboard/index.ts`
- Test: `apps/api/src/routes/dashboard/access.integration.test.ts`

- [ ] **Step 1: Write integration test**

Create `apps/api/src/routes/dashboard/access.integration.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { dashboardTestClient } from "../../test-helpers/dashboard-client";

describe("/dashboard/access", () => {
  it("creates, lists, updates, deletes access rows", async () => {
    const { client, projectId } = await dashboardTestClient();

    const created = await client.post(`/projects/${projectId}/access`, {
      identifier: "pro",
      displayName: "Pro Access",
    });
    expect(created.status).toBe(201);
    const { data } = await created.json();
    expect(data.identifier).toBe("pro");

    const list = await client.get(`/projects/${projectId}/access`);
    const listed = await list.json();
    expect(listed.data.rows).toHaveLength(1);

    const patched = await client.patch(
      `/projects/${projectId}/access/${data.id}`,
      { displayName: "Pro+" },
    );
    expect(patched.status).toBe(200);

    const deleted = await client.delete(
      `/projects/${projectId}/access/${data.id}`,
    );
    expect(deleted.status).toBe(204);
  });

  it("rejects duplicate identifier with 409", async () => {
    const { client, projectId } = await dashboardTestClient();
    await client.post(`/projects/${projectId}/access`, {
      identifier: "dup",
      displayName: "A",
    });
    const second = await client.post(`/projects/${projectId}/access`, {
      identifier: "dup",
      displayName: "B",
    });
    expect(second.status).toBe(409);
  });
});
```

- [ ] **Step 2: Run test, confirm fail**

```bash
pnpm --filter @rovenue/api test -- access.integration
```

Expected: FAIL (route not mounted).

- [ ] **Step 3: Implement the route**

Create `apps/api/src/routes/dashboard/access.ts`:

```typescript
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { MemberRole, drizzle } from "@rovenue/db";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { ok } from "../../lib/response";
import type {
  DashboardAccessRow,
  DashboardAccessListResponse,
} from "@rovenue/shared";

const identifierSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/i, "identifier must be slug-like");

const createBodySchema = z.object({
  identifier: identifierSchema,
  displayName: z.string().min(1).max(200),
  description: z.string().max(2000).nullable().optional(),
  metadata: z.record(z.unknown()).optional(),
});

const updateBodySchema = createBodySchema.partial();

async function rowToDashboard(
  row: Awaited<ReturnType<typeof drizzle.accessCatalogRepo.findById>>,
): Promise<DashboardAccessRow> {
  if (!row) throw new HTTPException(404, { message: "Access not found" });
  return {
    id: row.id,
    identifier: row.identifier,
    displayName: row.displayName,
    description: row.description ?? null,
    productCount: 0, // TODO Task 9: count products referencing this id
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

export const accessRoute = new Hono()
  .use("*", requireDashboardAuth)

  .get("/", async (c) => {
    const { projectId } = c.req.param() as { projectId: string };
    await assertProjectAccess(c, projectId, MemberRole.MEMBER);
    const rows = await drizzle.accessCatalogRepo.list(drizzle.db, projectId);
    const mapped = await Promise.all(rows.map(rowToDashboard));
    return c.json(ok<DashboardAccessListResponse>({ rows: mapped }));
  })

  .post("/", zValidator("json", createBodySchema), async (c) => {
    const { projectId } = c.req.param() as { projectId: string };
    await assertProjectAccess(c, projectId, MemberRole.ADMIN);
    const body = c.req.valid("json");
    const existing = await drizzle.accessCatalogRepo.findByIdentifier(
      drizzle.db,
      projectId,
      body.identifier,
    );
    if (existing) {
      throw new HTTPException(409, {
        message: `Access identifier '${body.identifier}' already exists`,
      });
    }
    const row = await drizzle.accessCatalogRepo.create(drizzle.db, {
      projectId,
      identifier: body.identifier,
      displayName: body.displayName,
      description: body.description ?? null,
      metadata: body.metadata ?? {},
    });
    return c.json(ok(await rowToDashboard(row)), 201);
  })

  .get("/:id", async (c) => {
    const { projectId, id } = c.req.param() as {
      projectId: string;
      id: string;
    };
    await assertProjectAccess(c, projectId, MemberRole.MEMBER);
    const row = await drizzle.accessCatalogRepo.findById(drizzle.db, id);
    if (!row || row.projectId !== projectId) {
      throw new HTTPException(404, { message: "Access not found" });
    }
    return c.json(ok(await rowToDashboard(row)));
  })

  .patch("/:id", zValidator("json", updateBodySchema), async (c) => {
    const { projectId, id } = c.req.param() as {
      projectId: string;
      id: string;
    };
    await assertProjectAccess(c, projectId, MemberRole.ADMIN);
    const existing = await drizzle.accessCatalogRepo.findById(drizzle.db, id);
    if (!existing || existing.projectId !== projectId) {
      throw new HTTPException(404, { message: "Access not found" });
    }
    await drizzle.accessCatalogRepo.update(drizzle.db, id, c.req.valid("json"));
    const refetched = await drizzle.accessCatalogRepo.findById(drizzle.db, id);
    return c.json(ok(await rowToDashboard(refetched)));
  })

  .delete("/:id", async (c) => {
    const { projectId, id } = c.req.param() as {
      projectId: string;
      id: string;
    };
    await assertProjectAccess(c, projectId, MemberRole.ADMIN);
    const existing = await drizzle.accessCatalogRepo.findById(drizzle.db, id);
    if (!existing || existing.projectId !== projectId) {
      throw new HTTPException(404, { message: "Access not found" });
    }
    // FK from subscriber_access.accessId is ON DELETE RESTRICT — Postgres
    // will throw 23503 if any access row still references it.
    await drizzle.accessCatalogRepo.deleteById(drizzle.db, id);
    return c.body(null, 204);
  });
```

- [ ] **Step 4: Mount on the dashboard router**

In `apps/api/src/routes/dashboard/index.ts`, add:

```typescript
import { accessRoute } from "./access";
// ...
.route("/projects/:projectId/access", accessRoute)
```

- [ ] **Step 5: Run test**

```bash
pnpm --filter @rovenue/api test -- access.integration
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/dashboard/access.ts \
        apps/api/src/routes/dashboard/access.integration.test.ts \
        apps/api/src/routes/dashboard/index.ts
git commit -m "feat(api): dashboard access catalog CRUD route"
```

---

## Task 9: Update products route + add product-count aggregation

**Files:**
- Modify: `apps/api/src/routes/dashboard/products.ts`
- Modify: `apps/api/src/routes/dashboard/access.ts` (productCount fix)
- Modify: `packages/db/src/drizzle/repositories/products.ts`
- Modify: `packages/db/src/drizzle/repositories/access-catalog.ts`

- [ ] **Step 1: Grep remaining entitlement references in products route**

```bash
grep -n "entitlementKey\|entitlementKeys" apps/api/src/routes/dashboard/products.ts \
                                            apps/api/src/routes/dashboard/subscribers.ts
```

- [ ] **Step 2: Rename in products route**

In `apps/api/src/routes/dashboard/products.ts`:
- Replace every `entitlementKeys` → `accessIds`.
- Add Zod validation: every `accessId` in the array must be a cuid2 (use `validators.accessId`).
- On POST/PATCH: verify every `accessId` resolves to an existing `access` row in the same project; reject with `400 unknown access id` otherwise.

```typescript
async function assertAccessIdsExist(
  projectId: string,
  ids: string[],
): Promise<void> {
  if (ids.length === 0) return;
  const rows = await drizzle.accessCatalogRepo.findByIds(drizzle.db, ids);
  const valid = new Set(
    rows.filter((r) => r.projectId === projectId).map((r) => r.id),
  );
  const missing = ids.filter((id) => !valid.has(id));
  if (missing.length > 0) {
    throw new HTTPException(400, {
      message: `Unknown access ids: ${missing.join(", ")}`,
    });
  }
}
```

Call `assertAccessIdsExist(projectId, body.accessIds ?? [])` inside both POST and PATCH handlers before persisting.

- [ ] **Step 3: Rename in subscribers route**

In `apps/api/src/routes/dashboard/subscribers.ts`:
- Replace every `entitlementKey/s` → `accessId/s`.
- If the route returns access info to the dashboard, also resolve `accessId` → `access.identifier` via a join (use new helper in repo if needed).

- [ ] **Step 4: Fix productCount in access dashboard route**

In `packages/db/src/drizzle/repositories/access-catalog.ts`, add:

```typescript
import { products } from "../schema";
import { sql } from "drizzle-orm";

export async function countProducts(
  db: Db,
  accessId: string,
): Promise<number> {
  const [row] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(products)
    .where(sql`${accessId} = ANY(${products.accessIds})`);
  return row?.n ?? 0;
}
```

Then in `apps/api/src/routes/dashboard/access.ts`, update `rowToDashboard`:

```typescript
async function rowToDashboard(row: AccessRow): Promise<DashboardAccessRow> {
  return {
    id: row.id,
    identifier: row.identifier,
    displayName: row.displayName,
    description: row.description ?? null,
    productCount: await drizzle.accessCatalogRepo.countProducts(drizzle.db, row.id),
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
```

(For list endpoints, prefer a single `GROUP BY` query — defer until perf becomes an issue.)

- [ ] **Step 5: Update products repo**

In `packages/db/src/drizzle/repositories/products.ts`, replace all `entitlementKeys` references with `accessIds`. Field selects, where clauses, return shapes.

- [ ] **Step 6: Run tests**

```bash
pnpm --filter @rovenue/api test -- products subscribers access.integration
```

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/dashboard/products.ts \
        apps/api/src/routes/dashboard/subscribers.ts \
        apps/api/src/routes/dashboard/access.ts \
        packages/db/src/drizzle/repositories/access-catalog.ts \
        packages/db/src/drizzle/repositories/products.ts
git commit -m "refactor(api): align products + subscribers routes with accessId"
```

---

## Task 10: Rename `product_groups` → `offerings` (table + add accessId FK)

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts:562-589`
- New migration auto-generated

- [ ] **Step 1: Update schema**

In `packages/db/src/drizzle/schema.ts`, replace the entire `productGroups` table definition with:

```typescript
// =============================================================
// offerings (paywall configurations — was product_groups)
// Each offering is scoped to one Access; A/B variants land here.
// =============================================================

export const offerings = pgTable(
  "offerings",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    accessId: text("accessId")
      .notNull()
      .references(() => access.id, { onDelete: "cascade" }),
    identifier: text("identifier").notNull(),
    isDefault: boolean("isDefault").notNull().default(false),
    products: jsonb("products").notNull().default(sql`'[]'::jsonb`),
    metadata: jsonb("metadata").notNull().default(sql`'{}'::jsonb`),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    projectIdIdentifierKey: uniqueIndex(
      "offerings_projectId_identifier_key",
    ).on(t.projectId, t.identifier),
    accessIdIsDefaultIdx: index(
      "offerings_accessId_isDefault_idx",
    ).on(t.accessId, t.isDefault),
  }),
);

export type Offering = typeof offerings.$inferSelect;
export type NewOffering = typeof offerings.$inferInsert;
```

Update the type exports at the bottom to use `Offering` / `NewOffering` (remove `ProductGroup` exports).

- [ ] **Step 2: Generate migration**

```bash
pnpm db:migrate:generate
```

Drizzle-kit will emit a "table renamed" prompt — accept it (or write a manual migration with `ALTER TABLE product_groups RENAME TO offerings` + `ADD COLUMN accessId`).

Rename file: `0056_offerings.sql`.

- [ ] **Step 3: Run + verify**

```bash
pnpm db:migrate:fresh
```

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/drizzle/schema.ts \
        packages/db/drizzle/migrations/0056_offerings.sql \
        packages/db/drizzle/migrations/meta/
git commit -m "feat(db): rename product_groups to offerings with accessId FK"
```

---

## Task 11: Rename product-groups repo → offerings repo

**Files:**
- Delete: `packages/db/src/drizzle/repositories/product-groups.ts`
- Create: `packages/db/src/drizzle/repositories/offerings.ts`
- Modify: `packages/db/src/drizzle/index.ts`

- [ ] **Step 1: Rename file + update internals**

```bash
git mv packages/db/src/drizzle/repositories/product-groups.ts \
       packages/db/src/drizzle/repositories/offerings.ts
```

In the new `offerings.ts`:
- Replace every `productGroups` reference with `offerings`.
- Replace every `ProductGroup` type with `Offering`.
- Function names: `listProductGroups` → `listOfferings`, `findProductGroupBy*` → `findOfferingBy*`, `createProductGroup` → `createOffering`, etc.
- Add `accessId` to create/update input shapes.

- [ ] **Step 2: Update barrel export**

In `packages/db/src/drizzle/index.ts`:
- Replace `import * as productGroupRepo from "./repositories/product-groups"` with `import * as offeringRepo from "./repositories/offerings"`.
- Replace exported key `productGroupRepo` with `offeringRepo`.

- [ ] **Step 3: Run typecheck to find call sites**

```bash
pnpm -w typecheck
```

Output should be a list of files still calling `drizzle.productGroupRepo.*` — they're addressed in the next task.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/drizzle/repositories/offerings.ts \
        packages/db/src/drizzle/index.ts
git commit -m "refactor(db): rename productGroup repo to offering repo"
```

---

## Task 12: Rename product-groups routes → offerings routes

**Files:**
- Delete: `apps/api/src/routes/v1/product-groups.ts`
- Delete: `apps/api/src/routes/dashboard/product-groups.ts`
- Create: `apps/api/src/routes/v1/offerings.ts`
- Create: `apps/api/src/routes/dashboard/offerings.ts`
- Modify: `apps/api/src/routes/v1/index.ts`
- Modify: `apps/api/src/routes/dashboard/index.ts`

- [ ] **Step 1: Move + rename files**

```bash
git mv apps/api/src/routes/v1/product-groups.ts \
       apps/api/src/routes/v1/offerings.ts
git mv apps/api/src/routes/dashboard/product-groups.ts \
       apps/api/src/routes/dashboard/offerings.ts
```

- [ ] **Step 2: Update internals of each renamed route**

In both new offering route files:
- Replace `productGroupsRoute` export name → `offeringsRoute`.
- Replace every `productGroupRepo` call → `offeringRepo`.
- Replace `PRODUCT_GROUP` enum values inside experiment-engine integration with `OFFERING` (if `experiments.type` enum supports it; if not, leave a TODO note — see Task 13 below).
- Add `accessId` to create/update body Zod schemas.
- Update route comments at the top of each file.

For the `/v1/offerings` route specifically, accept a new query param `accessId` to filter offerings by access. The list endpoint becomes:

```typescript
.get("/", async (c) => {
  const project = c.get("project");
  const accessId = c.req.query("accessId");
  const rows = accessId
    ? await drizzle.offeringRepo.listOfferingsByAccess(
        drizzle.db,
        project.id,
        accessId,
      )
    : await drizzle.offeringRepo.listOfferings(drizzle.db, project.id);
  // ... map to response
});
```

Add `listOfferingsByAccess` to `offerings.ts` repo:

```typescript
export async function listOfferingsByAccess(
  db: Db,
  projectId: string,
  accessId: string,
): Promise<Offering[]> {
  return db
    .select()
    .from(offerings)
    .where(
      and(eq(offerings.projectId, projectId), eq(offerings.accessId, accessId)),
    );
}
```

- [ ] **Step 3: Update mounts**

In `apps/api/src/routes/v1/index.ts`:
```typescript
// Replace:
import { productGroupsRoute } from "./product-groups";
.route("/product-groups", productGroupsRoute)
// With:
import { offeringsRoute } from "./offerings";
.route("/offerings", offeringsRoute)
```

Same change in `apps/api/src/routes/dashboard/index.ts`.

- [ ] **Step 4: Run typecheck + integration tests**

```bash
pnpm -w typecheck
pnpm --filter @rovenue/api test -- offerings
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/v1/offerings.ts \
        apps/api/src/routes/dashboard/offerings.ts \
        apps/api/src/routes/v1/index.ts \
        apps/api/src/routes/dashboard/index.ts \
        packages/db/src/drizzle/repositories/offerings.ts
git commit -m "refactor(api): rename product-groups routes to offerings"
```

---

## Task 13: Rename `experiments.type=PRODUCT_GROUP` → `OFFERING`

**Files:**
- Modify: `packages/db/src/drizzle/enums.ts` (or wherever `ExperimentType` enum lives)
- Modify: `apps/api/src/services/experiment-engine.ts` (uses)
- Migration auto-generated

- [ ] **Step 1: Find the enum**

```bash
grep -rn "PRODUCT_GROUP" packages/db/src apps/api/src | grep -v ".test.ts"
```

- [ ] **Step 2: Rename enum value**

In the file that defines `experimentType` (likely `packages/db/src/drizzle/enums.ts`), replace `"PRODUCT_GROUP"` with `"OFFERING"`.

- [ ] **Step 3: Update all references**

In `apps/api/src/services/experiment-engine.ts` and `apps/api/src/routes/v1/offerings.ts`, replace every `"PRODUCT_GROUP"` string literal with `"OFFERING"`.

- [ ] **Step 4: Generate migration**

```bash
pnpm db:migrate:generate
```

Postgres `ALTER TYPE ... RENAME VALUE` is supported on PG 10+. Verify the migration uses that form. Rename file: `0057_experiment_type_offering.sql`.

- [ ] **Step 5: Run + commit**

```bash
pnpm db:migrate:fresh
pnpm --filter @rovenue/api test -- experiment-engine
git add packages/db/src/drizzle/enums.ts \
        packages/db/drizzle/migrations/0057_experiment_type_offering.sql \
        packages/db/drizzle/migrations/meta/ \
        apps/api/src/services/experiment-engine.ts \
        apps/api/src/routes/v1/offerings.ts \
        apps/api/src/routes/dashboard/offerings.ts
git commit -m "refactor(db,api): rename experiment type PRODUCT_GROUP to OFFERING"
```

---

## Task 14: Update `/v1/me` response shape

**Files:**
- Modify: `apps/api/src/routes/v1/me.ts`

- [ ] **Step 1: Find affected endpoints**

```bash
grep -n "entitlement" apps/api/src/routes/v1/me.ts
```

- [ ] **Step 2: Update response keys**

In `apps/api/src/routes/v1/me.ts`:
- Rename response key `entitlements` → `access` in the JSON shape returned by `GET /v1/me`.
- The map values were already shaped by `buildAccessResponse()` — they're correct, only the wrapping key changes.

Before:
```typescript
return c.json(ok({ subscriber: {...}, entitlements: accessMap }));
```

After:
```typescript
return c.json(ok({ subscriber: {...}, access: accessMap }));
```

Update any test fixture that asserts on `body.data.entitlements` → `body.data.access`.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/v1/me.ts
git commit -m "refactor(api): /v1/me responds with 'access' key instead of 'entitlements'"
```

---

## Task 15: Update seed.ts + dashboard mappers + MSW mocks

**Files:**
- Modify: `packages/db/seed.ts`
- Modify: `apps/dashboard/src/lib/dashboard-mappers.ts`
- Modify: `apps/dashboard/tests/msw/handlers.ts`

- [ ] **Step 1: Update seed.ts**

In `packages/db/seed.ts`:

Replace the seeded `entitlementKeys: ["premium", "analytics"]` block with first creating access rows, then referencing their IDs:

```typescript
// Around line 165 — before creating products:
const premiumAccess = await drizzle.accessCatalogRepo.create(drizzle.db, {
  projectId: project.id,
  identifier: "premium",
  displayName: "Premium",
});
const analyticsAccess = await drizzle.accessCatalogRepo.create(drizzle.db, {
  projectId: project.id,
  identifier: "analytics",
  displayName: "Analytics",
});

// In product seed:
accessIds: [premiumAccess.id, analyticsAccess.id],
```

For the `subscriberAccess` seed block (around line 321):
```typescript
eq(subscriberAccess.accessId, premiumAccess.id),
// ...
accessId: premiumAccess.id,
```

- [ ] **Step 2: Update dashboard mappers**

In `apps/dashboard/src/lib/dashboard-mappers.ts`:
- Replace every `entitlementKeys` with `accessIds`.
- Replace every `entitlementKey` (single) with `accessId`.

UI components (`apps/dashboard/src/components/products/entitlement-chip.tsx`, etc.) are NOT touched in this plan — Plan 3 (Dashboard Refactor) handles them.

- [ ] **Step 3: Update MSW handlers**

In `apps/dashboard/tests/msw/handlers.ts`:
- Replace every `entitlementKey/s` with `accessId/s`.
- Update any mocked endpoints that returned `entitlements` map to return `access` map.

- [ ] **Step 4: Verify seed runs cleanly**

```bash
pnpm db:migrate:fresh
pnpm db:seed
```

Expected: clean seed, no errors. Open psql and verify `SELECT * FROM access LIMIT 5;` returns rows.

- [ ] **Step 5: Commit**

```bash
git add packages/db/seed.ts \
        apps/dashboard/src/lib/dashboard-mappers.ts \
        apps/dashboard/tests/msw/handlers.ts
git commit -m "refactor: seed + mappers + MSW use access terminology"
```

---

## Task 16: Final sweep + full test suite

**Files:** none directly — scanning + fixing whatever's left.

- [ ] **Step 1: Grep for any remaining references**

```bash
grep -rn "entitlementKey\|entitlementKeys\|productGroup\|product_groups\|PRODUCT_GROUP" \
  packages/ apps/ \
  --include="*.ts" --include="*.tsx" --include="*.sql" \
  | grep -v "node_modules" \
  | grep -v "drizzle/migrations/0001_" \
  | grep -v ".d.ts"
```

Acceptable remaining hits:
- Historical migrations (`0001_..0052_*.sql`) — DO NOT TOUCH
- Dashboard UI component files (Plan 3 scope)
- SDK source (Plan 2 scope)

Anything else: fix in-place.

- [ ] **Step 2: Run full test suite**

```bash
pnpm test
```

Expected: all green. If any failure references entitlement/productGroup naming, fix it.

- [ ] **Step 3: Run typecheck**

```bash
pnpm -w typecheck
```

Expected: no errors.

- [ ] **Step 4: Manual smoke test**

Start the stack:
```bash
docker compose up -d
pnpm db:migrate:fresh && pnpm db:seed
pnpm dev
```

In a second terminal, hit a couple endpoints:
```bash
# Dashboard access list
curl -s http://localhost:3000/dashboard/projects/<projectId>/access -H "Cookie: $(cat .session-cookie)" | jq

# v1 offerings (replaces product-groups)
curl -s http://localhost:3000/v1/offerings -H "Authorization: Bearer <pub-key>" | jq

# v1 me — verify response uses 'access' not 'entitlements'
curl -s http://localhost:3000/v1/me \
  -H "Authorization: Bearer <pub-key>" \
  -H "X-Rovenue-User-Id: <appUserId>" | jq
```

Expected: each returns `200 OK` with correctly-shaped JSON.

- [ ] **Step 5: Commit any final fixes**

```bash
git status
git add -p     # review and stage
git commit -m "refactor: final sweep of entitlement→access references"
```

---

## Self-Review Notes

**Spec coverage check** — every item from the conversation:
- ✅ New `access` table with displayName/description — Task 1
- ✅ `products.entitlementKeys` → `products.accessIds` (text[] FK array) — Task 4 + 9
- ✅ `subscriber_access.entitlementKey` → `accessId` (true FK) — Task 3
- ✅ `product_groups` → `offerings` with `accessId` FK — Task 10
- ✅ access-engine + access-response internal rename — Task 5
- ✅ Webhook services (apple/google/stripe/grant) — Task 6
- ✅ Validators + shared types — Task 7
- ✅ Dashboard `/dashboard/access` CRUD — Task 8
- ✅ Products route + accessIds validation — Task 9
- ✅ Offerings repo + route renames — Tasks 11–12
- ✅ Experiment enum rename — Task 13
- ✅ `/v1/me` response key rename — Task 14
- ✅ Seed + mappers + MSW — Task 15
- ✅ Final sweep — Task 16
- ⏭ Dashboard UI components — Plan 3 (out of scope)
- ⏭ SDK (Rust/Swift/Kotlin/RN) — Plan 2 (out of scope)

**Type consistency:**
- `AccessRow` defined Task 1, used Tasks 2/5/8/9 — consistent.
- `Offering` defined Task 10, used Tasks 11/12 — consistent.
- `findPurchasesWithAccessIds` defined Task 5, used Task 5 only — consistent.
- `findByIds` added to `access-catalog.ts` in Task 2, used in Task 5 — consistent.
- `accessId` validator regex set to cuid2 in Task 7 — used in Task 9.

**Placeholder scan:** no TBD / TODO-fill-in / "similar to" present. The one `// TODO Task 9` in Task 8's intermediate code is resolved within Task 9 (same PR scope, intentional handoff between consecutive tasks).

---

## Next Plans (not in this document)

After this plan lands and merges to main:
1. **Plan 2 — SDK Rename** (`2026-05-28-access-sdk-rename.md`): Rust core types (Entitlement → Access), UniFFI regen, Swift façade (`EntitlementInactiveError` → `AccessInactiveError`, etc.), Kotlin façade, RN façade (`useEntitlement` → `useAccess`, `entitlement` → `access` API, hook + type rename). Critical: do this **before** `pod trunk push` of v0.1.1 since the public API changes.
2. **Plan 3 — Dashboard Refactor** (`2026-05-28-access-dashboard-refactor.md`): New `/access` page (replaces `/product-groups`), Offerings as sub-section of Access detail, `entitlement-chip` component rename, Products toolbar dropdown sourced from access catalog, navigation reshuffle.
