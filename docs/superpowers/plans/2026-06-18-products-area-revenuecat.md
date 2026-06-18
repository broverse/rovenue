# Products Area (RevenueCat-aligned, decoupled model) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Decouple offerings from access levels (RevenueCat model), make offering slots first-class packages with standard identifiers, and present Products / Offerings / Access Levels as a single "Products" sidebar group with three routes.

**Architecture:** The `access` table stays the entitlement catalog and `products.accessIds[]` stays the product→entitlement map. We remove the mandatory `offerings.accessId` link, rename the offering `products` JSONB to `packages` and add a per-slot `identifier`, and surface a project-wide single default ("current") offering. API (dashboard CRUD + public `/v1/offerings`), shared types, the SDK hydration, and the dashboard SPA are updated to match. The change is a layered dependency chain (DB → shared → repo → API → SDK → dashboard), implemented in that order.

**Tech Stack:** Hono + TypeScript (API), Drizzle ORM + PostgreSQL 16 (DB), Zod (validation), Vitest + testcontainers (tests), React + TanStack Router/Query + Tailwind (dashboard), React Native + Swift (SDK).

## Global Constraints

- TypeScript strict mode everywhere; barrel exports (`index.ts`) per package.
- All API responses follow `{ data: T }` (via `ok(...)`) or `{ error: { code, message } }`.
- Drizzle for all Postgres access; raw SQL only via the `sql` template.
- Conventional commit messages (`feat:`, `fix:`, `chore:`, `docs:`, `test:`).
- Commit trailer on every commit: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- Stay on the current branch (`main`); do not create or switch branches. Commit only files this plan changes.
- Standard package-identifier values: `$rov_weekly`, `$rov_monthly`, `$rov_annual`, `$rov_lifetime`, or a custom slug (`^[a-z0-9][a-z0-9_-]*$` or the `$rov_` prefixed standards). Max length 160.
- Integration tests live in `*.integration.test.ts` and use testcontainers (real Postgres). Run with the repo's existing test command.

## Deviations from the approved spec (discovered while reading code — all reduce scope)

1. **Dashboard offerings CRUD already exists** at `apps/api/src/routes/dashboard/offerings.ts` (registered as `offeringsDashboardRoute` in `apps/api/src/routes/dashboard/index.ts:86`). We **edit** it, not create it.
2. **Default is already project-scoped and atomic.** `createOffering`/`updateOffering` in `repositories/offerings.ts` already clear any prior `isDefault=true` for the whole project inside a tx. So "set current" stays as `PATCH /:id { isDefault: true }` — **no dedicated `/:id/default` endpoint** (YAGNI; the spec's rationale about "accidental flips" does not apply because the clear only runs when `isDefault:true` is explicitly sent).
3. **`identifier` is already unique per `(projectId)`** (`offerings_projectId_identifier_key`). We add a **partial unique index** to also enforce single-default at the DB level (hardening the existing app-level logic).
4. The offering JSONB field is renamed `products` → `packages` and each entry gains a required `identifier`. This ripples through shared types, both API routes, the repo, and the SDK — every site is enumerated below.

---

### Task 1: DB — decouple offerings + rename `products` JSONB to `packages` with per-slot identifier

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts:623-653` (offerings table)
- Create: `packages/db/drizzle/migrations/0074_offerings_decouple_packages.sql` (hand-authored; generated then replaced)
- Modify: `packages/db/drizzle/migrations/meta/_journal.json` (drizzle-kit writes this when generating)
- Test: `packages/db/src/drizzle/repositories/offerings.integration.test.ts` (create if absent)

**Interfaces:**
- Produces: `offerings` table with columns `id, projectId, identifier, isDefault, packages (jsonb), metadata, createdAt, updatedAt` — **no `accessId`**. Each `packages` element is `{ identifier: string, productId: string, order: number, isPromoted: boolean, metadata?: object }`.
- Produces: Drizzle types `Offering` / `NewOffering` reflect the above (auto-derived from schema).

- [ ] **Step 1: Edit the schema** — replace the `offerings` table definition (`schema.ts:623-653`) with:

```ts
// =============================================================
// offerings (paywall configurations — RevenueCat-style)
//
// Decoupled from access levels: an offering is a project-scoped
// collection of packages. The entitlement a purchase grants comes
// from the purchased product's accessIds[], not the offering.
// At most one offering per project is the default ("current").
// =============================================================

export const offerings = pgTable(
  "offerings",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    identifier: text("identifier").notNull(),
    isDefault: boolean("isDefault").notNull().default(false),
    // Array of packages: { identifier, productId, order, isPromoted, metadata? }
    packages: jsonb("packages").notNull().default(sql`'[]'::jsonb`),
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
    // Hardening: at most one default offering per project, enforced
    // at the DB level in addition to the transactional clear in the repo.
    projectIdDefaultKey: uniqueIndex("offerings_projectId_default_key")
      .on(t.projectId)
      .where(sql`${t.isDefault}`),
  }),
);
```

- [ ] **Step 2: Generate the migration scaffold**

Run: `pnpm db:migrate:generate`
Expected: a new `0074_*.sql` file plus a `meta/_journal.json` entry. (drizzle-kit will likely emit destructive `DROP COLUMN products` / `ADD COLUMN packages` / `DROP COLUMN accessId` — that loses package data, so we replace the SQL in the next step. Rename the generated `.sql` file to `0074_offerings_decouple_packages.sql` and update the matching `tag` in `meta/_journal.json` to `0074_offerings_decouple_packages`.)

- [ ] **Step 3: Replace the generated SQL** with a data-preserving migration at `packages/db/drizzle/migrations/0074_offerings_decouple_packages.sql`:

```sql
-- Add packages column (nullable first so we can backfill)
ALTER TABLE "offerings" ADD COLUMN "packages" jsonb;

-- Backfill packages from the old products JSONB. Each element gains an
-- "identifier": prefer a deterministic slug per slot; admins rename later.
UPDATE "offerings" o
SET "packages" = COALESCE(
  (
    SELECT jsonb_agg(
      jsonb_build_object(
        'identifier', 'package_' || (elem->>'order'),
        'productId',  elem->>'productId',
        'order',      COALESCE((elem->>'order')::int, 0),
        'isPromoted', COALESCE((elem->>'isPromoted')::boolean, false),
        'metadata',   COALESCE(elem->'metadata', '{}'::jsonb)
      )
    )
    FROM jsonb_array_elements(o."products") AS elem
  ),
  '[]'::jsonb
)
WHERE o."products" IS NOT NULL;

-- Enforce NOT NULL + default now that every row is backfilled
ALTER TABLE "offerings" ALTER COLUMN "packages" SET DEFAULT '[]'::jsonb;
UPDATE "offerings" SET "packages" = '[]'::jsonb WHERE "packages" IS NULL;
ALTER TABLE "offerings" ALTER COLUMN "packages" SET NOT NULL;

-- Drop the old products JSONB
ALTER TABLE "offerings" DROP COLUMN "products";

-- Decouple from access: drop the FK index, then the column
DROP INDEX IF EXISTS "offerings_accessId_isDefault_idx";
ALTER TABLE "offerings" DROP COLUMN "accessId";

-- Hardening: single default offering per project
CREATE UNIQUE INDEX "offerings_projectId_default_key"
  ON "offerings" ("projectId") WHERE "isDefault";
```

- [ ] **Step 4: Write the failing integration test** at `packages/db/src/drizzle/repositories/offerings.integration.test.ts` (mirror an existing `*.integration.test.ts` for the testcontainer + migration harness):

```ts
import { describe, it, expect, beforeAll } from "vitest";
// ... reuse the project's testcontainer Postgres + migrate helper ...
import { offerings } from "../schema";

describe("offerings schema (decoupled + packages)", () => {
  it("inserts an offering with packages and no accessId column", async () => {
    const [row] = await db.insert(offerings).values({
      projectId,
      identifier: "default",
      isDefault: true,
      packages: [
        { identifier: "$rov_monthly", productId: prodId, order: 0, isPromoted: false },
      ],
    }).returning();
    expect(row.packages).toHaveLength(1);
    expect((row.packages as any)[0].identifier).toBe("$rov_monthly");
    expect("accessId" in row).toBe(false);
  });

  it("rejects a second default offering for the same project", async () => {
    await db.insert(offerings).values({ projectId, identifier: "a", isDefault: true, packages: [] });
    await expect(
      db.insert(offerings).values({ projectId, identifier: "b", isDefault: true, packages: [] }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 5: Run migration + test to verify the test fails first, then passes after migrate**

Run the repo's DB test command for `offerings.integration.test.ts`.
Expected: passes after `0074` is applied; the second-default insert rejects on the unique index.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/drizzle/schema.ts packages/db/drizzle/migrations/0074_offerings_decouple_packages.sql packages/db/drizzle/migrations/meta/_journal.json packages/db/src/drizzle/repositories/offerings.integration.test.ts
git commit -m "feat(db): decouple offerings from access; rename products JSONB to packages with identifier"
```

---

### Task 2: Shared types — add package identifier, drop accessId, rename products→packages

**Files:**
- Modify: `packages/shared/src/dashboard.ts:1513-1550`

**Interfaces:**
- Produces: `OfferingPackage` (replaces `OfferingMembership`), `DashboardOfferingRow.packages`, create/update inputs without `accessId`. Consumed by Tasks 4, 8, 9.

- [ ] **Step 1: Replace the offering type block** (`dashboard.ts:1513-1550`) with:

```ts
/** A package inside an offering's `packages` JSONB column. */
export interface OfferingPackage {
  /** Standard ($rov_monthly/$rov_annual/...) or custom slug, unique within the offering. */
  identifier: string;
  productId: string;
  order: number;
  isPromoted: boolean;
  metadata?: Record<string, unknown>;
}

export interface DashboardOfferingRow {
  id: string;
  identifier: string;
  isDefault: boolean;
  packages: OfferingPackage[];
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface DashboardOfferingsListResponse {
  offerings: DashboardOfferingRow[];
}

export interface DashboardOfferingCreateInput {
  identifier: string;
  isDefault?: boolean;
  packages?: OfferingPackage[];
  metadata?: Record<string, unknown>;
}

export interface DashboardOfferingUpdateInput {
  identifier?: string;
  isDefault?: boolean;
  packages?: OfferingPackage[];
  metadata?: Record<string, unknown>;
}
```

- [ ] **Step 2: Keep a back-compat alias** so unrelated importers don't break mid-migration — add directly below the block:

```ts
/** @deprecated use OfferingPackage */
export type OfferingMembership = OfferingPackage;
```

- [ ] **Step 3: Typecheck the shared package**

Run: `pnpm --filter @rovenue/shared build`
Expected: PASS (no type errors).

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/dashboard.ts
git commit -m "feat(shared): offering packages with identifier; drop accessId from offering types"
```

---

### Task 3: Repo — drop accessId surfaces, rename products→packages references

**Files:**
- Modify: `packages/db/src/drizzle/repositories/offerings.ts`

**Interfaces:**
- Consumes: `offerings` schema from Task 1.
- Produces: `UpdateOfferingInput` without `accessId`/`products` (uses `packages`); `listOfferingsByAccess` removed. Consumed by Tasks 4, 5.

- [ ] **Step 1: Remove `listOfferingsByAccess`** (`offerings.ts:30-42`) entirely (the public route no longer filters by access — Task 5).

- [ ] **Step 2: Update `UpdateOfferingInput`** (`offerings.ts:166-172`) to:

```ts
export interface UpdateOfferingInput {
  identifier?: string;
  isDefault?: boolean;
  packages?: unknown;
  metadata?: Record<string, unknown>;
}
```

- [ ] **Step 3: Remove the unused `inArray`/`ne` only if now unused** — leave imports that are still referenced (`ne` is used by `updateOffering`; keep it). No code in `createOffering`/`updateOffering` references `accessId` or `products` directly (they spread `input`/`patch`), so they need no change beyond the input type. Verify by grepping:

Run: `grep -n "accessId\|\.products" packages/db/src/drizzle/repositories/offerings.ts`
Expected: no remaining references after edits (only `packages` going forward).

- [ ] **Step 4: Typecheck the db package**

Run: `pnpm --filter @rovenue/db build`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/drizzle/repositories/offerings.ts
git commit -m "refactor(db): drop accessId/products surfaces from offering repo"
```

---

### Task 4: Dashboard API — offerings route uses packages, drops accessId

**Files:**
- Modify: `apps/api/src/routes/dashboard/offerings.ts`
- Test: `apps/api/src/routes/dashboard/offerings.integration.test.ts` (create)

**Interfaces:**
- Consumes: Task 2 types, Task 3 repo.
- Produces: `POST/PATCH` accept `{ identifier, isDefault?, packages[], metadata? }`; `toWire` emits `packages`, no `accessId`.

- [ ] **Step 1: Write the failing integration test** at `apps/api/src/routes/dashboard/offerings.integration.test.ts` (mirror an existing dashboard `*.integration.test.ts` for app/auth setup):

```ts
it("creates an offering with packages and no accessId", async () => {
  const res = await app.request(`/api/dashboard/projects/${projectId}/offerings`, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      identifier: "default",
      isDefault: true,
      packages: [{ identifier: "$rov_monthly", productId, order: 0, isPromoted: false }],
    }),
  });
  expect(res.status).toBe(200);
  const { data } = await res.json();
  expect(data.offering.packages[0].identifier).toBe("$rov_monthly");
  expect(data.offering.accessId).toBeUndefined();
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run the dashboard offerings integration test.
Expected: FAIL (body still requires `accessId`; response still has it).

- [ ] **Step 3: Edit the route.** Apply these concrete edits to `apps/api/src/routes/dashboard/offerings.ts`:

  - Remove the `accessIdSchema` import (line 5) and the `assertAccessIdExists` helper (lines 117-127).
  - Replace `membershipSchema` (lines 21-26) with a package schema:

```ts
const PACKAGE_ID_RE = /^(\$rov_(weekly|monthly|annual|lifetime)|[a-z0-9][a-z0-9_-]*)$/;
const packageSchema = z.object({
  identifier: z.string().trim().min(1).max(160).regex(PACKAGE_ID_RE),
  productId: z.string().min(1),
  order: z.number().int().min(0).max(10_000),
  isPromoted: z.boolean().default(false),
  metadata: z.record(z.unknown()).optional(),
});
```

  - In `createBodySchema` (lines 28-34): drop `accessId`, rename `products` → `packages: z.array(packageSchema).optional()`.
  - In `updateBodySchema` (lines 36-46): drop `accessId`, rename `products` → `packages`.
  - Replace `parseMemberships` with a `parsePackages` that also reads `identifier`:

```ts
function parsePackages(raw: unknown): OfferingPackage[] {
  if (!Array.isArray(raw)) return [];
  const out: OfferingPackage[] = [];
  for (const item of raw) {
    if (
      typeof item === "object" && item !== null &&
      typeof (item as any).identifier === "string" &&
      typeof (item as any).productId === "string" &&
      typeof (item as any).order === "number" &&
      typeof (item as any).isPromoted === "boolean"
    ) {
      const m = item as OfferingPackage;
      out.push({ identifier: m.identifier, productId: m.productId, order: m.order, isPromoted: m.isPromoted, metadata: m.metadata });
    }
  }
  return out;
}
```

  - Update the `toWire` signature to drop `accessId` and emit `packages: parsePackages(row.packages)` from `row.packages` (was `row.products`).
  - In the `POST` handler: remove the `await assertAccessIdExists(...)` call; change `body.products` → `body.packages` (assertProductsExist + the `createOffering` call's `products: body.products ?? []` → `packages: body.packages ?? []`, and drop `accessId: body.accessId`).
  - In the `PATCH` handler: remove the `if (body.accessId) { await assertAccessIdExists(...) }` block; change `body.products` → `body.packages`.
  - Update the `@rovenue/shared` import: `OfferingMembership` → `OfferingPackage`.

- [ ] **Step 4: Run the test to confirm it passes**

Run the dashboard offerings integration test.
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/dashboard/offerings.ts apps/api/src/routes/dashboard/offerings.integration.test.ts
git commit -m "feat(api): dashboard offerings use packages with identifier; drop accessId"
```

---

### Task 5: Public API — `/v1/offerings` drops accessId, exposes package identifier

**Files:**
- Modify: `apps/api/src/routes/v1/offerings.ts`
- Test: `apps/api/src/routes/v1/offerings.integration.test.ts` (create if absent; else add cases)

**Interfaces:**
- Consumes: Task 3 repo (`listOfferings` only; `listOfferingsByAccess` gone).
- Produces: response items `{ identifier, isDefault, packages: [{ packageIdentifier, identifier, type, displayName, order, isPromoted, creditAmount, accessIds, storeIds, metadata }], metadata }` where `packageIdentifier` is the package slot id ($rov_monthly...) and `identifier` is the product's own identifier (unchanged). Consumed by the SDK (Task 6).

- [ ] **Step 1: Write the failing test**

```ts
it("hydrates packages with their package identifier and omits accessId", async () => {
  const res = await app.request("/v1/offerings", { headers: publicKeyHeaders });
  const { data } = await res.json();
  const o = data.offerings.find((x: any) => x.identifier === "default");
  expect(o.accessId).toBeUndefined();
  // packageIdentifier is the RevenueCat-style slot id ($rov_monthly);
  // identifier remains the product's own identifier (additive, non-breaking).
  expect(o.packages[0].packageIdentifier).toBe("$rov_monthly");
  expect(o.packages[0].identifier).toBeTruthy();
});
```

- [ ] **Step 2: Run to confirm failure** — Expected: FAIL (field is `products`, has `accessId`, no package `identifier`).

- [ ] **Step 3: Edit the route** (`apps/api/src/routes/v1/offerings.ts`):

  - Rename the membership schema to packages and add `identifier` + keep it as the source of the package id:

```ts
const packageSchema = z.object({
  identifier: z.string(),
  productId: z.string(),
  order: z.number().int().nonnegative().default(0),
  isPromoted: z.boolean().default(false),
  metadata: z.record(z.unknown()).optional(),
});
const packagesSchema = z.array(packageSchema);
```

  - Add `packageIdentifier: string` to `OfferingProductEntry` and set it in `hydrateProducts` from `entry.identifier` (additive — keep the existing `identifier` = product identifier and all other product fields unchanged so existing SDK consumers don't break):

```ts
interface OfferingProductEntry {
  packageIdentifier: string;   // the package slot id ($rov_monthly...) → PackageDTO.identifier
  identifier: string;          // the product's own identifier (unchanged)
  type: string;
  displayName: string;
  order: number;
  isPromoted: boolean;
  creditAmount: number | null;
  accessIds: string[];
  storeIds: Record<string, string>;
  metadata: unknown;
}
// inside hydrateProducts map: packageIdentifier: entry.identifier, ...
```

  - In `GET /`: remove `const accessId = c.req.query("accessId")` and the ternary; always call `listOfferings`. Parse `o.packages` (was `o.products`) with `packagesSchema`. In the response, rename the `products:` array key to `packages:`, drop `accessId: offering.accessId`.
  - In `GET /:identifier`: parse `offering.packages` with `packagesSchema`; in both the early-return and the success return, rename `products:` → `packages:`, drop `accessId: offering.accessId`.
  - Update the comment block at the top to remove the "optionally filtered by `accessId`" wording.

- [ ] **Step 4: Run to confirm pass** — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/v1/offerings.ts apps/api/src/routes/v1/offerings.integration.test.ts
git commit -m "feat(api): v1 offerings expose package identifier, drop accessId filter+field"
```

---

### Task 6: SDK — wire package identifier end-to-end

**Files:**
- Read first: `packages/sdk-rn/src/specs/RovenueModule.types.ts`, `packages/sdk-rn/src/api/purchases.ts`, `packages/sdk-swift/Sources/Rovenue/Types.swift`
- Modify: whichever of the above maps the server response `packages[].identifier` into `PackageDTO.identifier`
- Test: existing SDK offering/package mapping tests (RN Vitest and/or Swift)

**Interfaces:**
- Consumes: Task 5 response shape (`packages: [{ packageIdentifier, identifier, ... }]`, where `packageIdentifier` is the slot id and `identifier` is the product id).
- Produces: `PackageDTO.identifier` populated from the server `packageIdentifier` field (not derived).

- [ ] **Step 1: Read the three files** to find where the offerings HTTP response is mapped to `OfferingDTO`/`PackageDTO`. Confirm whether the RN bridge or the native (Swift/Kotlin) core consumes `/v1/offerings`.

- [ ] **Step 2: Write/adjust the failing test** — a mapping test asserting that given a server payload with `packages: [{ packageIdentifier: "$rov_monthly", identifier: "<productId>", ... }]`, the resulting `Package.identifier === "$rov_monthly"`. Place it next to the existing offerings mapping test.

- [ ] **Step 3: Run to confirm failure** (the mapper currently derives/ignores the package identifier).

- [ ] **Step 4: Update the mapper** to read `pkg.packageIdentifier` from the server response field into `PackageDTO.identifier`, leaving `PackageDTO.product` mapping (which uses the product `identifier`/`storeIds`) unchanged.

- [ ] **Step 5: Run the SDK test to confirm pass.** For Kotlin, verify with `testDebugUnitTest` (per project convention), not a compile-only task.

- [ ] **Step 6: Commit**

```bash
git add packages/sdk-rn packages/sdk-swift
git commit -m "feat(sdk): populate package identifier from server offering response"
```

---

### Task 7: Dashboard nav — "Products" group with Products / Offerings / Access Levels

**Files:**
- Modify: `apps/dashboard/src/components/dashboard/navigation.ts:54-70`
- Modify: dashboard i18n catalogs (locate via grep for `sidebar.sections.catalog` and `sidebar.items.access`)

**Interfaces:**
- Produces: a `products` nav section containing `products`, `offerings`, `access` items. Consumed by the Sidebar renderer (unchanged).

- [ ] **Step 1: Replace the `catalog` section** (`navigation.ts:54-70`) with:

```ts
  {
    sectionKey: "products",
    items: [
      {
        id: "products",
        labelKey: "sidebar.items.products",
        icon: Box,
        to: "/projects/$projectId/products",
      },
      {
        id: "offerings",
        labelKey: "sidebar.items.offerings",
        icon: LayoutGrid,
        to: "/projects/$projectId/offerings",
      },
      {
        id: "access",
        labelKey: "sidebar.items.access",
        icon: KeyRound,
        to: "/projects/$projectId/access",
      },
    ],
  },
```

(`LayoutGrid` is already imported; if a more distinct icon is preferred, import one already used elsewhere — do not add a new dependency.)

- [ ] **Step 2: Update i18n** — add `sidebar.sections.products` (e.g. "Products") and `sidebar.items.offerings` (e.g. "Offerings") keys; change `sidebar.items.access` label to "Access Levels". Locate the catalog(s):

Run: `grep -rln "sidebar.items.access\|sidebar.sections.catalog" apps/dashboard/src`
Apply the same keys across every locale file found.

- [ ] **Step 3: Typecheck the dashboard**

Run: `pnpm --filter @rovenue/dashboard build` (or the dashboard's typecheck script)
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/components/dashboard/navigation.ts apps/dashboard/src/<locale files>
git commit -m "feat(dashboard): Products nav group with Products/Offerings/Access Levels"
```

---

### Task 8: Dashboard — dedicated Offerings page

**Files:**
- Read first: `apps/dashboard/src/routes/_authed/projects/$projectId/access.tsx`, `apps/dashboard/src/components/offerings/*` (OfferingList, OfferingFormDialog, etc.), and the existing `useProjectOfferings`-style hook (grep `offerings` under `apps/dashboard/src/hooks` / data layer).
- Create: `apps/dashboard/src/routes/_authed/projects/$projectId/offerings.tsx`
- Modify: the dashboard API client for offerings (drop `accessId`, use `packages`) — grep `dashboard/projects/${...}/offerings` or `DashboardOffering` under `apps/dashboard/src`.

**Interfaces:**
- Consumes: Task 4 dashboard endpoints (`GET/POST/PATCH/DELETE /projects/:id/offerings`) and Task 2 types (`DashboardOfferingRow.packages`).
- Produces: a route at `/projects/$projectId/offerings`.

- [ ] **Step 1: Read** the access route + `components/offerings/*` to learn the list+detail pattern, the data hook, and the form dialog. Note the exact prop names the offering components expect (they currently assume an `accessId` context via `AccessOfferingsSection`).

- [ ] **Step 2: Update the offerings data client/hook** — remove `accessId` from create/update payloads; rename `products` → `packages`; ensure the package form captures `identifier`. Reuse `OfferingFormDialog`; extend its form state with a package `identifier` field (standard select + custom input) per package row.

- [ ] **Step 3: Create the route** `offerings.tsx` modeled on `access.tsx`: a sticky `OfferingList` left rail (search + selection + "New offering"), and a detail pane showing the offering's packages (identifier + product, order, isPromoted), a "Set as current" toggle wired to `PATCH { isDefault: true }`, and a read-only "Access levels granted" list derived from each package product's `accessIds` (resolve names via the existing `useProjectAccess` hook). Follow the existing Tailwind `rv-*` tokens, `cn()`, Base UI `Dialog`, and `useTranslation()` patterns.

- [ ] **Step 4: Build to verify route + types compile**

Run: `pnpm --filter @rovenue/dashboard build`
Expected: PASS; the new route is picked up by TanStack Router's file-based routing (regenerate the route tree if the project uses a generated `routeTree.gen.ts` — run the dashboard dev/build which regenerates it).

- [ ] **Step 5: Manual smoke check** — `pnpm dev`, open `/projects/<id>/offerings`, create an offering with a `$rov_monthly` package, set it as current, confirm it persists on reload.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/routes/_authed/projects/$projectId/offerings.tsx apps/dashboard/src/components/offerings apps/dashboard/src/<offerings client/hook>
git commit -m "feat(dashboard): dedicated Offerings page (packages, set-current)"
```

---

### Task 9: Dashboard — Access Levels page cleanup

**Files:**
- Read first: `apps/dashboard/src/routes/_authed/projects/$projectId/access.tsx`, `apps/dashboard/src/components/access/AccessOfferingsSection.tsx`
- Modify: `access.tsx` (remove the inline offerings section)
- Possibly remove: `AccessOfferingsSection.tsx` (if no longer referenced anywhere)

**Interfaces:**
- Consumes: `useProjectProducts` / `useProjectAccess` (existing hooks).
- Produces: Access detail shows "Products granting this access level" instead of inline offerings.

- [ ] **Step 1: Read** `access.tsx` + `AccessOfferingsSection.tsx` to see how the section is mounted and what data it pulled.

- [ ] **Step 2: Remove** the `<AccessOfferingsSection />` usage from `access.tsx` (offerings now live on their own page).

- [ ] **Step 3: Add** a read-only "Products granting this access level" list in the access detail pane: filter `useProjectProducts` results to products whose `accessIds` includes the selected access id; render product `displayName` + `identifier`. Mirror the existing detail-pane list styling.

- [ ] **Step 4: Delete `AccessOfferingsSection.tsx`** only if grep shows no remaining importers:

Run: `grep -rn "AccessOfferingsSection" apps/dashboard/src`
Expected: no references after Step 2 → safe to delete the file.

- [ ] **Step 5: Build to verify**

Run: `pnpm --filter @rovenue/dashboard build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/routes/_authed/projects/$projectId/access.tsx apps/dashboard/src/components/access
git commit -m "feat(dashboard): Access Levels page shows granting products; drop inline offerings"
```

---

## Final verification

- [ ] Run the full API test suite (`pnpm test` or the targeted api/db packages) — all offerings/access/products tests green.
- [ ] `pnpm --filter @rovenue/db db:verify:clickhouse` — confirm no analytics parity regression (offerings are not mirrored; expected unchanged).
- [ ] `pnpm build` across the affected packages (shared, db, api, dashboard) — green.
- [ ] Grep for stragglers: `grep -rn "offerings.accessId\|listOfferingsByAccess\|\.products" apps packages | grep -i offering` returns nothing meaningful.
- [ ] Note in the SDK changelog: `/v1/offerings` no longer accepts `?accessId=` and the response uses `packages` (with `identifier`) instead of `products`; `accessId` removed from offering objects.

## Open follow-ups (out of scope; surface, do not implement)

- Package identifiers backfilled as `package_<order>` should be reviewed/renamed by admins post-migration (documented in the migration).
- A paywall visual builder / placements / targeting is explicitly out of scope.
