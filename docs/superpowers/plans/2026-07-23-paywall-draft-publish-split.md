# Paywall Draft/Publish Split (P0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the paywall builder's autosave from shipping straight to production devices, by introducing an immutable published-version snapshot that `/v1/placements` serves, while `paywalls.builderConfig` becomes the private draft.

**Architecture:** Mirror the funnel subsystem exactly (`funnels.status` + `funnel_versions` + `publish`/`versions`/`revert`). A new `paywall_versions` table stores immutable snapshots of `{builderConfig, remoteConfig, offeringId, configFormatVersion}`. `paywalls` gains `status` and `publishedVersionId`. `placement-resolution.ts` resolves `publishedVersionId → paywall_versions` instead of reading the live row; a paywall with no published version resolves to `null` (same treatment as `!isActive` today). A one-shot backfill in the same migration auto-publishes a v1 for every existing paywall so nothing goes dark. A pure `diffBuilderConfigs()` in `@rovenue/shared/paywall` powers both the diff endpoint and the dashboard's diff modal.

**Tech Stack:** PostgreSQL 16 + Drizzle ORM (hand-written SQL migrations + `meta/_journal.json`), Hono + Zod (API), Vitest + testcontainers (integration tests), React + `impair` DI (dashboard), `lucide-react` icons, `react-i18next`.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-23-paywall-builder-gap-analysis.md` — §5.1 (version model), §6.1–6.7 (endpoints), §7 (P0 row), §8 (decisions taken).
- TypeScript strict everywhere. Zod for API input. All API responses are `{ data: T }` (via `ok()`) or `{ error: { code, message } }`.
- Postgres access **via Drizzle repositories only** — `packages/db/src/drizzle/repositories/`. Raw `sql` only when truly necessary, and columns must be qualified (`"paywalls"."id"`).
- All app-generated IDs are cuid2 (`createId()`); timestamps UTC.
- `audit()` runs **inside the caller's Drizzle tx**, never in its own.
- Every paywall mutation calls `purgeProjectCatalogCache(projectId)` — paywalls are edge-cached under `/v1/placements`.
- Conventional commits. Commit after every task.
- **Stay on the current branch.** Do not create or switch branches or worktrees.
- Migrations are **hand-written SQL** in `packages/db/drizzle/migrations/` with a manually appended `meta/_journal.json` entry. Do **not** run `drizzle-kit generate` for this work — it re-emits hand-written DDL from earlier migrations into the new file.
- `paywall_versions` uses **camelCase quoted column names** to match its parent table `paywalls` (`"projectId"`, `"offeringId"`, …), not the snake_case used by `funnel_versions`. The two tables are queried together; matching `paywalls` wins.
- API route tests live in `apps/api/tests/` (a separate directory from `apps/api/src`). DB and shared tests are colocated next to the source.

---

## File Structure

**Create:**
- `packages/db/drizzle/migrations/0093_paywall_versions.sql` — DDL + backfill
- `packages/db/src/drizzle/repositories/paywall-versions.ts` — version repo
- `packages/db/src/drizzle/repositories/paywall-versions.integration.test.ts`
- `packages/shared/src/paywall/diff.ts` — pure `diffBuilderConfigs()`
- `packages/shared/src/paywall/diff.test.ts`
- `apps/api/tests/dashboard-paywalls-versions.integration.test.ts`
- `apps/api/tests/placement-resolution-published-version.integration.test.ts`
- `apps/dashboard/src/components/paywall-builder/version-menu.tsx`
- `apps/dashboard/src/components/paywall-builder/diff-modal.tsx`

**Modify:**
- `packages/db/src/drizzle/enums.ts` — add `paywallStatus`
- `packages/db/src/drizzle/schema.ts:732` — `paywalls.status`, `paywalls.publishedVersionId`, new `paywallVersions` table
- `packages/db/src/drizzle/repositories/paywalls.ts` — `setPublishedVersion`, `UpdatePaywallInput.status`
- `packages/db/src/drizzle/index.ts:75` — export `paywallVersionRepo`
- `packages/shared/src/paywall/index.ts` — re-export diff
- `packages/shared/src/dashboard.ts:1732` — `DashboardPaywallRow` + version DTOs
- `apps/api/src/lib/audit.ts:31,125` — `paywall.*` actions + `paywall` resource
- `apps/api/src/routes/dashboard/paywalls.ts` — 6 new endpoints
- `apps/api/src/lib/placement-resolution.ts:41` — serve the published snapshot
- `apps/dashboard/src/lib/services/paywall-builder-api.ts` — version RPC methods
- `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.ts` — publish/version state
- `apps/dashboard/src/components/paywall-builder/top-bar.tsx` — publish group
- `apps/dashboard/src/components/paywall-builder/builder-shell.tsx` — mount diff modal

---

### Task 1: Database schema + backfill migration

**Files:**
- Modify: `packages/db/src/drizzle/enums.ts`
- Modify: `packages/db/src/drizzle/schema.ts:732-762`
- Create: `packages/db/drizzle/migrations/0093_paywall_versions.sql`
- Modify: `packages/db/drizzle/migrations/meta/_journal.json`

**Interfaces:**
- Consumes: nothing.
- Produces: `paywallStatus` pgEnum; `paywallVersions` table + `PaywallVersion` / `NewPaywallVersion` types; `paywalls.status` (`"draft" | "published" | "archived"`) and `paywalls.publishedVersionId` (`string | null`).

- [ ] **Step 1: Add the `paywallStatus` enum**

In `packages/db/src/drizzle/enums.ts`, directly after the `funnelTemplateScope` block (~line 310), add:

```ts
// =============================================================
// Paywall versioning pgEnums
// =============================================================

export const paywallStatus = pgEnum("PaywallStatus", [
  "draft",
  "published",
  "archived",
]);
```

- [ ] **Step 2: Add the columns and the versions table to the Drizzle schema**

In `packages/db/src/drizzle/schema.ts`, add `paywallStatus` to the existing import from `./enums`. Then inside the `paywalls` table definition (line 732), add these two columns immediately after `isActive`:

```ts
    status: paywallStatus("status").notNull().default("draft"),
    // FK is declared in SQL only (0093) — a Drizzle `.references()` here
    // would create a circular table reference with paywallVersions.
    publishedVersionId: text("publishedVersionId"),
```

Then, immediately after the closing `);` of the `paywalls` table (line 762), add:

```ts
// =============================================================
// paywall_versions — immutable published snapshots
// =============================================================
//
// `paywalls.builderConfig` is the DRAFT (the builder's autosave
// target). Publishing snapshots the draft here and points
// `paywalls.publishedVersionId` at the new row. `/v1/placements`
// serves the snapshot, never the draft — see
// apps/api/src/lib/placement-resolution.ts.
//
// The snapshot deliberately includes `offeringId`: reverting or
// re-pointing the draft at a different offering must not retroactively
// change what an already-published version resolves against.

export const paywallVersions = pgTable(
  "paywall_versions",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    paywallId: text("paywallId")
      .notNull()
      .references(() => paywalls.id, { onDelete: "cascade" }),
    versionNo: integer("versionNo").notNull(),
    builderConfig: jsonb("builderConfig"),
    remoteConfig: jsonb("remoteConfig").notNull(),
    offeringId: text("offeringId").notNull(),
    configFormatVersion: integer("configFormatVersion").notNull().default(1),
    /** Optional human label from "Name this version…". */
    label: text("label"),
    publishedAt: timestamp("publishedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    publishedBy: text("publishedBy").references(() => user.id, {
      onDelete: "set null",
    }),
  },
  (t) => ({
    paywallVersionUnique: uniqueIndex("paywall_versions_paywallId_versionNo_key").on(
      t.paywallId,
      t.versionNo,
    ),
  }),
);

export type PaywallVersion = typeof paywallVersions.$inferSelect;
export type NewPaywallVersion = typeof paywallVersions.$inferInsert;
```

- [ ] **Step 3: Write the migration SQL**

Create `packages/db/drizzle/migrations/0093_paywall_versions.sql`:

```sql
-- 0093_paywall_versions.sql
--
-- P0 of the paywall builder redesign: split draft from published.
--
-- Before this migration `paywalls.builderConfig` was BOTH the builder's
-- autosave target AND the document /v1/placements shipped to production
-- devices — an in-progress edit went live as soon as the edge cache
-- expired. After it, the builder still autosaves into
-- `paywalls.builderConfig` (now unambiguously THE DRAFT) and publishing
-- snapshots that draft into `paywall_versions`, which is what the SDK
-- resolution path reads.
--
-- The snapshot carries `offeringId` and `remoteConfig` as well as
-- `builderConfig`: re-pointing the draft at another offering, or editing
-- remote config, must not retroactively change an already-published
-- version.
--
-- The backfill at the bottom is NOT optional. apps/api/src/lib/
-- placement-resolution.ts resolves `publishedVersionId` and returns null
-- when it is absent, so without the backfill every existing paywall
-- would go dark on deploy.

CREATE TYPE "PaywallStatus" AS ENUM ('draft', 'published', 'archived');

CREATE TABLE "paywall_versions" (
  "id" text PRIMARY KEY NOT NULL,
  "paywallId" text NOT NULL,
  "versionNo" integer NOT NULL,
  "builderConfig" jsonb,
  "remoteConfig" jsonb NOT NULL,
  "offeringId" text NOT NULL,
  "configFormatVersion" integer DEFAULT 1 NOT NULL,
  "label" text,
  "publishedAt" timestamp with time zone DEFAULT now() NOT NULL,
  "publishedBy" text
);

ALTER TABLE "paywall_versions"
  ADD CONSTRAINT "paywall_versions_paywallId_paywalls_id_fk"
  FOREIGN KEY ("paywallId") REFERENCES "paywalls"("id") ON DELETE cascade;

ALTER TABLE "paywall_versions"
  ADD CONSTRAINT "paywall_versions_publishedBy_user_id_fk"
  FOREIGN KEY ("publishedBy") REFERENCES "user"("id") ON DELETE set null;

CREATE UNIQUE INDEX "paywall_versions_paywallId_versionNo_key"
  ON "paywall_versions" ("paywallId", "versionNo");

ALTER TABLE "paywalls"
  ADD COLUMN "status" "PaywallStatus" DEFAULT 'draft' NOT NULL;

ALTER TABLE "paywalls" ADD COLUMN "publishedVersionId" text;

ALTER TABLE "paywalls"
  ADD CONSTRAINT "paywalls_publishedVersionId_paywall_versions_id_fk"
  FOREIGN KEY ("publishedVersionId") REFERENCES "paywall_versions"("id")
  ON DELETE set null;

-- ---------------------------------------------------------------
-- Backfill: auto-publish a v1 for every existing paywall from its
-- current state, then point the paywall at it.
--
-- `gen_random_uuid()::text` is a deliberate one-off exception to the
-- cuid2 ID convention: cuid2 is generated in application code and is
-- unavailable inside a SQL migration. IDs are opaque `text`, so a UUID
-- string is a valid value for this column; every version minted after
-- this migration comes from `createId()` as normal.
-- ---------------------------------------------------------------

WITH inserted AS (
  INSERT INTO "paywall_versions" (
    "id", "paywallId", "versionNo", "builderConfig", "remoteConfig",
    "offeringId", "configFormatVersion", "label", "publishedAt", "publishedBy"
  )
  SELECT
    gen_random_uuid()::text,
    "paywalls"."id",
    1,
    "paywalls"."builderConfig",
    "paywalls"."remoteConfig",
    "paywalls"."offeringId",
    "paywalls"."configFormatVersion",
    'Backfilled from pre-versioning state',
    "paywalls"."updatedAt",
    NULL
  FROM "paywalls"
  RETURNING "id", "paywallId"
)
UPDATE "paywalls"
SET "publishedVersionId" = inserted."id",
    "status" = 'published'
FROM inserted
WHERE "paywalls"."id" = inserted."paywallId";
```

- [ ] **Step 4: Append the journal entry**

In `packages/db/drizzle/migrations/meta/_journal.json`, append to `entries` (after the `0092_apple_pay_domain` object):

```json
  {
   "idx": 93,
   "version": "7",
   "when": 1784680711519,
   "tag": "0093_paywall_versions",
   "breakpoints": true
  }
```

- [ ] **Step 5: Run the migration and verify the backfill**

Run: `pnpm db:migrate`
Expected: completes without error.

Then verify with `psql "$DATABASE_URL"`:

```sql
SELECT count(*) AS paywalls,
       count("publishedVersionId") AS with_published
FROM "paywalls";
```

Expected: both counts equal (every paywall has a published version).

```sql
SELECT count(*) FROM "paywalls" WHERE "status" <> 'published';
```

Expected: `0`.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @rovenue/db build`
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/drizzle/enums.ts packages/db/src/drizzle/schema.ts \
  packages/db/drizzle/migrations/0093_paywall_versions.sql \
  packages/db/drizzle/migrations/meta/_journal.json
git commit -m "feat(db): paywall_versions table + status/publishedVersionId with backfill"
```

---

### Task 2: `paywallVersionRepo` + `paywallRepo.setPublishedVersion`

**Files:**
- Create: `packages/db/src/drizzle/repositories/paywall-versions.ts`
- Create: `packages/db/src/drizzle/repositories/paywall-versions.integration.test.ts`
- Modify: `packages/db/src/drizzle/repositories/paywalls.ts`
- Modify: `packages/db/src/drizzle/index.ts:75`

**Interfaces:**
- Consumes: `paywallVersions`, `PaywallVersion`, `NewPaywallVersion` (Task 1).
- Produces:
  - `paywallVersionRepo.findById(db, id): Promise<PaywallVersion | null>`
  - `paywallVersionRepo.findByIds(db, ids: string[]): Promise<PaywallVersion[]>`
  - `paywallVersionRepo.findByVersionNo(db, paywallId, versionNo): Promise<PaywallVersion | null>`
  - `paywallVersionRepo.listByPaywall(db, paywallId): Promise<PaywallVersion[]>` (versionNo DESC)
  - `paywallVersionRepo.nextVersionNo(db, paywallId): Promise<number>`
  - `paywallVersionRepo.insert(db, row: NewPaywallVersion): Promise<PaywallVersion>`
  - `paywallVersionRepo.setLabel(db, paywallId, versionNo, label: string | null): Promise<PaywallVersion | null>`
  - `paywallRepo.setPublishedVersion(db, projectId, paywallId, versionId): Promise<Paywall | null>`
  - `UpdatePaywallInput` gains `status?: "draft" | "published" | "archived"`

- [ ] **Step 1: Write the failing integration test**

Create `packages/db/src/drizzle/repositories/paywall-versions.integration.test.ts`:

```ts
// =============================================================
// paywallVersionRepo integration tests — real Postgres.
// Mirrors paywalls.integration.test.ts's seeding style.
// =============================================================

import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { getDb } from "../client";
import * as drizzleRepos from "../index";
import { projects, offerings, paywalls, paywallVersions } from "../schema";
import { eq } from "drizzle-orm";

const RUN_ID = Date.now();
const db = getDb();

let projectId: string;
let offeringId: string;
let paywallId: string;

beforeAll(async () => {
  const [project] = await db
    .insert(projects)
    .values({ name: `pwv-${RUN_ID}` })
    .returning();
  projectId = project!.id;

  const [offering] = await db
    .insert(offerings)
    .values({
      projectId,
      identifier: `off-${RUN_ID}`,
      name: "Default",
      packages: [{ identifier: "monthly", productId: null }],
    })
    .returning();
  offeringId = offering!.id;

  const [paywall] = await db
    .insert(paywalls)
    .values({
      projectId,
      identifier: `pw-${RUN_ID}`,
      name: "Test paywall",
      offeringId,
      remoteConfig: { defaultLocale: "en", locales: { en: {} } },
    })
    .returning();
  paywallId = paywall!.id;
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.id, projectId));
});

describe("paywallVersionRepo", () => {
  it("nextVersionNo starts at 1 and increments", async () => {
    expect(await drizzleRepos.paywallVersionRepo.nextVersionNo(db, paywallId)).toBe(1);

    await drizzleRepos.paywallVersionRepo.insert(db, {
      paywallId,
      versionNo: 1,
      builderConfig: null,
      remoteConfig: { defaultLocale: "en", locales: { en: {} } },
      offeringId,
      configFormatVersion: 1,
    });

    expect(await drizzleRepos.paywallVersionRepo.nextVersionNo(db, paywallId)).toBe(2);
  });

  it("listByPaywall returns newest first", async () => {
    await drizzleRepos.paywallVersionRepo.insert(db, {
      paywallId,
      versionNo: 2,
      builderConfig: null,
      remoteConfig: { defaultLocale: "en", locales: { en: {} } },
      offeringId,
      configFormatVersion: 1,
    });

    const rows = await drizzleRepos.paywallVersionRepo.listByPaywall(db, paywallId);
    expect(rows.map((r) => r.versionNo)).toEqual([2, 1]);
  });

  it("findByVersionNo scopes to the paywall", async () => {
    const v1 = await drizzleRepos.paywallVersionRepo.findByVersionNo(db, paywallId, 1);
    expect(v1?.versionNo).toBe(1);
    expect(await drizzleRepos.paywallVersionRepo.findByVersionNo(db, "nope", 1)).toBeNull();
  });

  it("findByIds batches", async () => {
    const rows = await drizzleRepos.paywallVersionRepo.listByPaywall(db, paywallId);
    const found = await drizzleRepos.paywallVersionRepo.findByIds(
      db,
      rows.map((r) => r.id),
    );
    expect(found).toHaveLength(2);
    expect(await drizzleRepos.paywallVersionRepo.findByIds(db, [])).toEqual([]);
  });

  it("setLabel updates only the targeted version", async () => {
    const updated = await drizzleRepos.paywallVersionRepo.setLabel(db, paywallId, 1, "Launch");
    expect(updated?.label).toBe("Launch");
    const other = await drizzleRepos.paywallVersionRepo.findByVersionNo(db, paywallId, 2);
    expect(other?.label).toBeNull();
  });

  it("setPublishedVersion points the paywall at a version", async () => {
    const v2 = await drizzleRepos.paywallVersionRepo.findByVersionNo(db, paywallId, 2);
    const row = await drizzleRepos.paywallRepo.setPublishedVersion(
      db,
      projectId,
      paywallId,
      v2!.id,
    );
    expect(row?.publishedVersionId).toBe(v2!.id);
    expect(row?.status).toBe("published");
  });

  it("deleting the paywall cascades its versions", async () => {
    const [tmp] = await db
      .insert(paywalls)
      .values({
        projectId,
        identifier: `pw-tmp-${RUN_ID}`,
        name: "Temp",
        offeringId,
        remoteConfig: { defaultLocale: "en", locales: { en: {} } },
      })
      .returning();
    await drizzleRepos.paywallVersionRepo.insert(db, {
      paywallId: tmp!.id,
      versionNo: 1,
      builderConfig: null,
      remoteConfig: { defaultLocale: "en", locales: { en: {} } },
      offeringId,
      configFormatVersion: 1,
    });
    await db.delete(paywalls).where(eq(paywalls.id, tmp!.id));
    const left = await db
      .select()
      .from(paywallVersions)
      .where(eq(paywallVersions.paywallId, tmp!.id));
    expect(left).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rovenue/db vitest run src/drizzle/repositories/paywall-versions.integration.test.ts`
Expected: FAIL — `drizzleRepos.paywallVersionRepo is undefined`.

- [ ] **Step 3: Write the repository**

Create `packages/db/src/drizzle/repositories/paywall-versions.ts`:

```ts
import { and, desc, eq, inArray, max } from "drizzle-orm";
import type { Db } from "../client";
import {
  paywallVersions,
  type NewPaywallVersion,
  type PaywallVersion,
} from "../schema";

// =============================================================
// Paywall published-version snapshots — Drizzle repository
// =============================================================
//
// Rows here are IMMUTABLE except for `label` ("Name this version…").
// Publishing appends; reverting copies a snapshot back into the
// paywall's draft columns rather than mutating history.

export async function findById(db: Db, id: string): Promise<PaywallVersion | null> {
  const rows = await db
    .select()
    .from(paywallVersions)
    .where(eq(paywallVersions.id, id))
    .limit(1);
  return rows[0] ?? null;
}

/** Batched lookup — used by the /v1/placements experiment-variant hot path. */
export async function findByIds(db: Db, ids: string[]): Promise<PaywallVersion[]> {
  if (ids.length === 0) return [];
  return db.select().from(paywallVersions).where(inArray(paywallVersions.id, ids));
}

export async function findByVersionNo(
  db: Db,
  paywallId: string,
  versionNo: number,
): Promise<PaywallVersion | null> {
  const rows = await db
    .select()
    .from(paywallVersions)
    .where(
      and(
        eq(paywallVersions.paywallId, paywallId),
        eq(paywallVersions.versionNo, versionNo),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function listByPaywall(
  db: Db,
  paywallId: string,
): Promise<PaywallVersion[]> {
  return db
    .select()
    .from(paywallVersions)
    .where(eq(paywallVersions.paywallId, paywallId))
    .orderBy(desc(paywallVersions.versionNo));
}

export async function nextVersionNo(db: Db, paywallId: string): Promise<number> {
  const [row] = await db
    .select({ v: max(paywallVersions.versionNo) })
    .from(paywallVersions)
    .where(eq(paywallVersions.paywallId, paywallId));
  return (row?.v ?? 0) + 1;
}

export async function insert(
  db: Db,
  row: NewPaywallVersion,
): Promise<PaywallVersion> {
  const [inserted] = await db.insert(paywallVersions).values(row).returning();
  return inserted!;
}

export async function setLabel(
  db: Db,
  paywallId: string,
  versionNo: number,
  label: string | null,
): Promise<PaywallVersion | null> {
  const [row] = await db
    .update(paywallVersions)
    .set({ label })
    .where(
      and(
        eq(paywallVersions.paywallId, paywallId),
        eq(paywallVersions.versionNo, versionNo),
      ),
    )
    .returning();
  return row ?? null;
}
```

- [ ] **Step 4: Extend `paywallRepo`**

In `packages/db/src/drizzle/repositories/paywalls.ts`, add `status` to `UpdatePaywallInput`:

```ts
export interface UpdatePaywallInput {
  identifier?: string;
  name?: string;
  offeringId?: string;
  remoteConfig?: unknown;
  configFormatVersion?: number;
  builderConfig?: unknown;
  isActive?: boolean;
  status?: "draft" | "published" | "archived";
  publishedVersionId?: string | null;
  metadata?: Record<string, unknown>;
}
```

and append this function at the end of the file:

```ts
/**
 * Point a paywall at a published version. Also flips `status` to
 * `published` — the two always move together, so callers can't leave a
 * paywall claiming `draft` while serving a version.
 */
export async function setPublishedVersion(
  db: Db,
  projectId: string,
  paywallId: string,
  versionId: string,
): Promise<Paywall | null> {
  const [row] = await db
    .update(paywalls)
    .set({ publishedVersionId: versionId, status: "published", updatedAt: new Date() })
    .where(and(eq(paywalls.projectId, projectId), eq(paywalls.id, paywallId)))
    .returning();
  return row ?? null;
}
```

- [ ] **Step 5: Export the repo from the barrel**

In `packages/db/src/drizzle/index.ts`, next to the existing paywall exports, add:

```ts
export * as paywallVersionRepo from "./repositories/paywall-versions";
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `pnpm --filter @rovenue/db vitest run src/drizzle/repositories/paywall-versions.integration.test.ts`
Expected: PASS — 7 tests.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/drizzle/repositories/paywall-versions.ts \
  packages/db/src/drizzle/repositories/paywall-versions.integration.test.ts \
  packages/db/src/drizzle/repositories/paywalls.ts \
  packages/db/src/drizzle/index.ts
git commit -m "feat(db): paywallVersionRepo + paywallRepo.setPublishedVersion"
```

---

### Task 3: Shared types + audit vocabulary

**Files:**
- Modify: `packages/shared/src/dashboard.ts:1732`
- Modify: `apps/api/src/lib/audit.ts:31,125`

**Interfaces:**
- Consumes: nothing.
- Produces: `DashboardPaywallRow.status` and `.publishedVersionId`; `DashboardPaywallVersionRow`; `DashboardPaywallVersionsResponse`; `DashboardPaywallVersionDetailResponse`; `AuditAction` gains `"paywall.published" | "paywall.reverted" | "paywall.draft_discarded" | "paywall.version_labeled"`; `AuditResource` gains `"paywall"`.

- [ ] **Step 1: Extend `DashboardPaywallRow` and add version DTOs**

In `packages/shared/src/dashboard.ts`, add two fields to `DashboardPaywallRow` (line 1732), after `isActive`:

```ts
  status: "draft" | "published" | "archived";
  publishedVersionId: string | null;
```

and immediately after `DashboardPaywallsListResponse` (line 1749), add:

```ts
/** One row of a paywall's publish history. `builderConfig`/`remoteConfig`
 * are omitted from the list shape — the version menu only needs metadata;
 * the full snapshot comes from the detail endpoint. */
export interface DashboardPaywallVersionRow {
  id: string;
  versionNo: number;
  label: string | null;
  offeringId: string;
  configFormatVersion: number;
  publishedAt: string;
  publishedBy: string | null;
  /** True when `paywalls.publishedVersionId` points at this row. */
  isLive: boolean;
}

export interface DashboardPaywallVersionsResponse {
  versions: DashboardPaywallVersionRow[];
}

export interface DashboardPaywallVersionDetailResponse {
  version: DashboardPaywallVersionRow & {
    builderConfig: unknown;
    remoteConfig: PaywallRemoteConfig;
  };
}

/** One field-level change between two builder configs. Mirrors
 * `BuilderConfigDiffEntry` from `@rovenue/shared/paywall`. */
export interface DashboardPaywallDiffResponse {
  from: { versionNo: number | null; label: string | null };
  to: { versionNo: number | null; label: string | null };
  entries: Array<{
    kind: "added" | "removed" | "changed";
    scope: "config" | "node" | "localization";
    nodeId: string | null;
    nodeType: string | null;
    field: string;
    from: string | null;
    to: string | null;
  }>;
}
```

- [ ] **Step 2: Add the audit vocabulary**

In `apps/api/src/lib/audit.ts`, add to the `AuditAction` union (after the `funnel.*` block ending at line 98):

```ts
  | "paywall.published"
  | "paywall.reverted"
  | "paywall.draft_discarded"
  | "paywall.version_labeled"
```

and add `"paywall"` to the `AuditResource` union (line 125), after `"funnel"`.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @rovenue/shared build && pnpm --filter @rovenue/api exec tsc --noEmit`
Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/dashboard.ts apps/api/src/lib/audit.ts
git commit -m "feat(shared): paywall version DTOs + paywall audit vocabulary"
```

---

### Task 4: `diffBuilderConfigs()` — pure shared function

**Files:**
- Create: `packages/shared/src/paywall/diff.ts`
- Create: `packages/shared/src/paywall/diff.test.ts`
- Modify: `packages/shared/src/paywall/index.ts`

**Interfaces:**
- Consumes: `BuilderConfig`, `PaywallNode` from `./schema`.
- Produces:
  - `type BuilderConfigDiffEntry = { kind: "added" | "removed" | "changed"; scope: "config" | "node" | "localization"; nodeId: string | null; nodeType: PaywallNode["type"] | null; field: string; from: string | null; to: string | null }`
  - `function diffBuilderConfigs(from: BuilderConfig | null, to: BuilderConfig | null): BuilderConfigDiffEntry[]`

- [ ] **Step 1: Write the failing test**

Create `packages/shared/src/paywall/diff.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { diffBuilderConfigs } from "./diff";
import type { BuilderConfig } from "./schema";

function base(): BuilderConfig {
  return {
    formatVersion: 2,
    defaultLocale: "en",
    localizations: { en: { title: "Hello", cta: "Buy" } },
    root: {
      type: "stack",
      id: "root",
      axis: "v",
      spacing: 8,
      children: [
        { type: "text", id: "t1", key: "title", role: "title" },
        {
          type: "packageList",
          id: "pl",
          packageIds: ["monthly", "annual"],
          defaultSelected: "monthly",
          cellLayout: "row",
        },
        { type: "purchaseButton", id: "pb", labelKey: "cta" },
      ],
    },
  };
}

describe("diffBuilderConfigs", () => {
  it("returns nothing for identical configs", () => {
    expect(diffBuilderConfigs(base(), base())).toEqual([]);
  });

  it("reports a changed scalar node prop", () => {
    const to = base();
    (to.root.children[1] as { defaultSelected?: string }).defaultSelected = "annual";

    const entries = diffBuilderConfigs(base(), to);
    expect(entries).toEqual([
      {
        kind: "changed",
        scope: "node",
        nodeId: "pl",
        nodeType: "packageList",
        field: "defaultSelected",
        from: '"monthly"',
        to: '"annual"',
      },
    ]);
  });

  it("reports an added node", () => {
    const to = base();
    to.root.children.push({ type: "spacer", id: "sp", size: 12 });

    const entries = diffBuilderConfigs(base(), to);
    expect(entries).toContainEqual({
      kind: "added",
      scope: "node",
      nodeId: "sp",
      nodeType: "spacer",
      field: "node",
      from: null,
      to: "spacer",
    });
  });

  it("reports a removed node", () => {
    const from = base();
    const to = base();
    to.root.children = to.root.children.filter((n) => n.id !== "pb");

    const entries = diffBuilderConfigs(from, to);
    expect(entries).toContainEqual({
      kind: "removed",
      scope: "node",
      nodeId: "pb",
      nodeType: "purchaseButton",
      field: "node",
      from: "purchaseButton",
      to: null,
    });
  });

  it("reports array element changes with index paths", () => {
    const to = base();
    (to.root.children[1] as { packageIds: string[] }).packageIds = ["monthly", "weekly"];

    const entries = diffBuilderConfigs(base(), to);
    expect(entries).toContainEqual({
      kind: "changed",
      scope: "node",
      nodeId: "pl",
      nodeType: "packageList",
      field: "packageIds[1]",
      from: '"annual"',
      to: '"weekly"',
    });
  });

  it("reports localization changes, additions and removals", () => {
    const to = base();
    to.localizations.en!.title = "Hi";
    to.localizations.en!.extra = "New";
    delete to.localizations.en!.cta;

    const entries = diffBuilderConfigs(base(), to).filter((e) => e.scope === "localization");
    expect(entries).toEqual([
      { kind: "changed", scope: "localization", nodeId: null, nodeType: null, field: "en.title", from: '"Hello"', to: '"Hi"' },
      { kind: "removed", scope: "localization", nodeId: null, nodeType: null, field: "en.cta", from: '"Buy"', to: null },
      { kind: "added", scope: "localization", nodeId: null, nodeType: null, field: "en.extra", from: null, to: '"New"' },
    ]);
  });

  it("reports config-level changes", () => {
    const to = base();
    to.defaultLocale = "de";
    to.background = { light: "#fff", dark: "#000" };

    const entries = diffBuilderConfigs(base(), to).filter((e) => e.scope === "config");
    expect(entries).toContainEqual({
      kind: "changed",
      scope: "config",
      nodeId: null,
      nodeType: null,
      field: "defaultLocale",
      from: '"en"',
      to: '"de"',
    });
    expect(entries).toContainEqual({
      kind: "added",
      scope: "config",
      nodeId: null,
      nodeType: null,
      field: "background.light",
      from: null,
      to: '"#fff"',
    });
  });

  it("descends into fallback and cellTemplate subtrees as nodes", () => {
    const from = base();
    const to = base();
    (to.root.children[1] as { cellTemplate?: unknown }).cellTemplate = {
      type: "text",
      id: "cell",
      key: "title",
      role: "body",
    };

    const entries = diffBuilderConfigs(from, to);
    expect(entries).toContainEqual({
      kind: "added",
      scope: "node",
      nodeId: "cell",
      nodeType: "text",
      field: "node",
      from: null,
      to: "text",
    });
  });

  it("treats a null side as everything added or removed", () => {
    expect(diffBuilderConfigs(null, null)).toEqual([]);
    const added = diffBuilderConfigs(null, base());
    expect(added.some((e) => e.kind === "added" && e.nodeId === "root")).toBe(true);
    const removed = diffBuilderConfigs(base(), null);
    expect(removed.every((e) => e.kind === "removed")).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rovenue/shared vitest run src/paywall/diff.test.ts`
Expected: FAIL — `Cannot find module './diff'`.

- [ ] **Step 3: Write the implementation**

Create `packages/shared/src/paywall/diff.ts`:

```ts
import type { BuilderConfig, PaywallNode } from "./schema";

// =============================================================
// Structural diff between two builder configs.
//
// Server-side so the four render targets and the dashboard don't each
// reimplement it. Powers GET /paywalls/:id/diff and the builder's
// "Draft → Published" modal.
//
// Values are compared as JSON strings so the result is renderable
// verbatim without the caller re-serialising, and so `undefined` vs
// absent collapses to the same thing.
// =============================================================

export type BuilderConfigDiffEntry = {
  kind: "added" | "removed" | "changed";
  scope: "config" | "node" | "localization";
  /** Node the change belongs to; null for config/localization scope. */
  nodeId: string | null;
  nodeType: PaywallNode["type"] | null;
  /** Dotted path relative to the scope, or the literal "node" for add/remove. */
  field: string;
  from: string | null;
  to: string | null;
};

/**
 * Keys handled by the tree walk rather than the per-node prop flatten:
 * `id` identifies the node, and the other three are subtrees whose nodes
 * are diffed in their own right. Without this exclusion a change deep in
 * a `fallback` would be reported twice.
 */
const STRUCTURAL_KEYS = new Set(["id", "children", "fallback", "cellTemplate"]);

function flatten(value: unknown, prefix: string, out: Record<string, string>): void {
  if (value === undefined) return;
  if (value === null || typeof value !== "object") {
    out[prefix] = JSON.stringify(value);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      out[prefix] = "[]";
      return;
    }
    value.forEach((v, i) => flatten(v, `${prefix}[${i}]`, out));
    return;
  }
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    out[prefix] = "{}";
    return;
  }
  for (const [k, v] of entries) {
    flatten(v, prefix ? `${prefix}.${k}` : k, out);
  }
}

function nodeProps(node: PaywallNode): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (STRUCTURAL_KEYS.has(k)) continue;
    flatten(v, k, out);
  }
  return out;
}

/** Document-order walk descending into children, fallback and cellTemplate. */
function collectNodes(root: PaywallNode | undefined): Map<string, PaywallNode> {
  const map = new Map<string, PaywallNode>();
  if (!root) return map;
  const stack: PaywallNode[] = [root];
  while (stack.length > 0) {
    const node = stack.shift()!;
    if (!map.has(node.id)) map.set(node.id, node);
    const nested: PaywallNode[] = [];
    if (node.type === "stack") nested.push(...node.children);
    if (node.type === "packageList" && node.cellTemplate) nested.push(node.cellTemplate);
    if (node.fallback) nested.push(node.fallback);
    stack.unshift(...nested);
  }
  return map;
}

function diffMaps(
  from: Record<string, string>,
  to: Record<string, string>,
  make: (
    kind: BuilderConfigDiffEntry["kind"],
    field: string,
    a: string | null,
    b: string | null,
  ) => BuilderConfigDiffEntry,
): BuilderConfigDiffEntry[] {
  const out: BuilderConfigDiffEntry[] = [];
  for (const [field, a] of Object.entries(from)) {
    const b = to[field];
    if (b === undefined) out.push(make("removed", field, a, null));
    else if (b !== a) out.push(make("changed", field, a, b));
  }
  for (const [field, b] of Object.entries(to)) {
    if (from[field] === undefined) out.push(make("added", field, null, b));
  }
  return out;
}

function configProps(config: BuilderConfig | null): Record<string, string> {
  if (!config) return {};
  const out: Record<string, string> = {};
  flatten(config.defaultLocale, "defaultLocale", out);
  if (config.background) flatten(config.background, "background", out);
  return out;
}

function localizationProps(config: BuilderConfig | null): Record<string, string> {
  if (!config) return {};
  const out: Record<string, string> = {};
  for (const [locale, entries] of Object.entries(config.localizations)) {
    for (const [key, value] of Object.entries(entries)) {
      out[`${locale}.${key}`] = JSON.stringify(value);
    }
  }
  return out;
}

/**
 * Ordering is deterministic: config fields, then nodes in `to` document
 * order followed by nodes only present in `from`, then localizations.
 * The diff modal renders the list as-is.
 */
export function diffBuilderConfigs(
  from: BuilderConfig | null,
  to: BuilderConfig | null,
): BuilderConfigDiffEntry[] {
  const entries: BuilderConfigDiffEntry[] = [];

  entries.push(
    ...diffMaps(configProps(from), configProps(to), (kind, field, a, b) => ({
      kind,
      scope: "config",
      nodeId: null,
      nodeType: null,
      field,
      from: a,
      to: b,
    })),
  );

  const fromNodes = collectNodes(from?.root);
  const toNodes = collectNodes(to?.root);

  for (const [id, toNode] of toNodes) {
    const fromNode = fromNodes.get(id);
    if (!fromNode) {
      entries.push({
        kind: "added",
        scope: "node",
        nodeId: id,
        nodeType: toNode.type,
        field: "node",
        from: null,
        to: toNode.type,
      });
      continue;
    }
    entries.push(
      ...diffMaps(nodeProps(fromNode), nodeProps(toNode), (kind, field, a, b) => ({
        kind,
        scope: "node",
        nodeId: id,
        nodeType: toNode.type,
        field,
        from: a,
        to: b,
      })),
    );
  }

  for (const [id, fromNode] of fromNodes) {
    if (toNodes.has(id)) continue;
    entries.push({
      kind: "removed",
      scope: "node",
      nodeId: id,
      nodeType: fromNode.type,
      field: "node",
      from: fromNode.type,
      to: null,
    });
  }

  entries.push(
    ...diffMaps(localizationProps(from), localizationProps(to), (kind, field, a, b) => ({
      kind,
      scope: "localization",
      nodeId: null,
      nodeType: null,
      field,
      from: a,
      to: b,
    })),
  );

  return entries;
}
```

- [ ] **Step 4: Re-export from the barrel**

In `packages/shared/src/paywall/index.ts`, add:

```ts
export { diffBuilderConfigs } from "./diff";
export type { BuilderConfigDiffEntry } from "./diff";
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @rovenue/shared vitest run src/paywall/diff.test.ts`
Expected: PASS — 9 tests.

- [ ] **Step 6: Commit**

```bash
git add packages/shared/src/paywall/diff.ts packages/shared/src/paywall/diff.test.ts \
  packages/shared/src/paywall/index.ts
git commit -m "feat(shared): diffBuilderConfigs for paywall draft-vs-published comparison"
```

---

### Task 5: `POST /:id/publish`

**Files:**
- Modify: `apps/api/src/routes/dashboard/paywalls.ts`
- Create: `apps/api/tests/dashboard-paywalls-versions.integration.test.ts`

**Interfaces:**
- Consumes: `paywallVersionRepo.nextVersionNo/insert` and `paywallRepo.setPublishedVersion` (Task 2); `paywall.published` audit action (Task 3).
- Produces: `POST /dashboard/projects/:projectId/paywalls/:id/publish` → `{ data: { paywall, version } }`; 400 `{ code: "PAYWALL_NOT_PUBLISHABLE", issues }` when the draft has blocking issues; 400 `{ code: "PAYWALL_EMPTY_DRAFT" }` when `builderConfig` is null.

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/tests/dashboard-paywalls-versions.integration.test.ts`:

```ts
// =============================================================
// Paywall versioning endpoints — publish / versions / revert /
// discard-draft / label / diff.
//
// Same harness as dashboard-paywalls.integration.test.ts: minimal Hono
// app on the production mount path, real Postgres, real Better Auth
// session cookie so requireDashboardAuth runs unmocked.
// =============================================================

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { getDb, projects, offerings, drizzle } from "@rovenue/db";
import { auth } from "../src/lib/auth";
import { errorHandler } from "../src/middleware/error";

const { purgeSpy } = vi.hoisted(() => ({ purgeSpy: vi.fn() }));
vi.mock("../src/lib/edge-cache", () => ({
  purgeProjectCatalogCache: (projectId: string) => purgeSpy(projectId),
}));

const { paywallsDashboardRoute } = await import("../src/routes/dashboard/paywalls");

const RUN_ID = Date.now();
const db = getDb();

function buildApp() {
  const app = new Hono();
  app.onError(errorHandler);
  return app.route("/projects/:projectId/paywalls", paywallsDashboardRoute);
}

let projectId: string;
let offeringId: string;
let cookie: string;
let userId: string;

const VALID_CONFIG = {
  formatVersion: 2,
  defaultLocale: "en",
  localizations: { en: { title: "Hello", cta: "Buy" } },
  root: {
    type: "stack",
    id: "root",
    axis: "v",
    children: [
      { type: "text", id: "t1", key: "title", role: "title" },
      { type: "packageList", id: "pl", packageIds: ["monthly"], cellLayout: "row" },
      { type: "purchaseButton", id: "pb", labelKey: "cta" },
    ],
  },
};

beforeAll(async () => {
  const email = `pwver_${RUN_ID}@rovenue.test`;
  const password = "Test1234!pwver";
  const signUp = await auth.api.signUpEmail({
    body: { email, password, name: `PW Ver ${RUN_ID}` },
  });
  userId = signUp!.user!.id;
  const signIn = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  cookie = signIn.headers.get("set-cookie")!.split(";")[0]!;

  const [project] = await db
    .insert(projects)
    .values({ name: `pwver-${RUN_ID}`, ownerId: userId })
    .returning();
  projectId = project!.id;

  const [offering] = await db
    .insert(offerings)
    .values({
      projectId,
      identifier: `off-${RUN_ID}`,
      name: "Default",
      packages: [{ identifier: "monthly", productId: null }],
    })
    .returning();
  offeringId = offering!.id;
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.id, projectId));
});

async function createPaywall(suffix: string, builderConfig: unknown) {
  const app = buildApp();
  const res = await app.request(`/projects/${projectId}/paywalls`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: JSON.stringify({
      identifier: `pw-${suffix}-${RUN_ID}`,
      name: `Paywall ${suffix}`,
      offeringId,
      remoteConfig: { defaultLocale: "en", locales: { en: {} } },
      builderConfig,
    }),
  });
  expect(res.status).toBe(200);
  const body = await res.json();
  return body.data.paywall;
}

describe("POST /paywalls/:id/publish", () => {
  it("snapshots the draft, points the paywall at it, and purges the cache", async () => {
    const app = buildApp();
    const paywall = await createPaywall("pub", VALID_CONFIG);
    expect(paywall.status).toBe("draft");
    expect(paywall.publishedVersionId).toBeNull();

    purgeSpy.mockClear();
    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/publish`,
      { method: "POST", headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();

    expect(data.version.versionNo).toBe(1);
    expect(data.version.builderConfig).toEqual(VALID_CONFIG);
    expect(data.version.offeringId).toBe(offeringId);
    expect(data.paywall.status).toBe("published");
    expect(data.paywall.publishedVersionId).toBe(data.version.id);
    expect(purgeSpy).toHaveBeenCalledWith(projectId);
  });

  it("increments versionNo on the second publish", async () => {
    const app = buildApp();
    const paywall = await createPaywall("pub2", VALID_CONFIG);
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}/publish`, {
      method: "POST",
      headers: { cookie },
    });
    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/publish`,
      { method: "POST", headers: { cookie } },
    );
    const { data } = await res.json();
    expect(data.version.versionNo).toBe(2);
  });

  it("rejects a paywall with no builderConfig", async () => {
    const app = buildApp();
    const paywall = await createPaywall("empty", null);
    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/publish`,
      { method: "POST", headers: { cookie } },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(JSON.parse(body.error.message).code).toBe("PAYWALL_EMPTY_DRAFT");
  });

  it("rejects a draft with blocking issues", async () => {
    // MISSING_PURCHASE_BUTTON: a packageList with no purchaseButton anywhere.
    const app = buildApp();
    const paywall = await createPaywall("blocked", {
      ...VALID_CONFIG,
      root: {
        type: "stack",
        id: "root",
        axis: "v",
        children: [
          { type: "packageList", id: "pl", packageIds: ["monthly"], cellLayout: "row" },
        ],
      },
    });
    // The create endpoint already blocks this, so seed the row directly.
    await drizzle.paywallRepo.updatePaywall(db, projectId, paywall.id, {
      builderConfig: {
        ...VALID_CONFIG,
        root: {
          type: "stack",
          id: "root",
          axis: "v",
          children: [
            { type: "packageList", id: "pl", packageIds: ["monthly"], cellLayout: "row" },
          ],
        },
      },
      configFormatVersion: 2,
    });
    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/publish`,
      { method: "POST", headers: { cookie } },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    const parsed = JSON.parse(body.error.message);
    expect(parsed.code).toBe("PAYWALL_NOT_PUBLISHABLE");
    expect(parsed.issues.some((i: { code: string }) => i.code === "MISSING_PURCHASE_BUTTON")).toBe(true);
  });

  it("404s for a paywall in another project", async () => {
    const app = buildApp();
    const res = await app.request(
      `/projects/${projectId}/paywalls/does-not-exist/publish`,
      { method: "POST", headers: { cookie } },
    );
    expect(res.status).toBe(404);
  });
});
```

Note: the `"blocked"` test creates the paywall with a valid config first (the create endpoint rejects blocking configs), then writes the blocking config straight through the repo to set up the publish-gate case.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rovenue/api vitest run tests/dashboard-paywalls-versions.integration.test.ts -t "snapshots the draft"`
Expected: FAIL with 404 — the `/publish` route does not exist.

- [ ] **Step 3: Implement the publish endpoint**

In `apps/api/src/routes/dashboard/paywalls.ts`, add these imports at the top:

```ts
import { audit, extractRequestContext } from "../../lib/audit";
import { diffBuilderConfigs } from "@rovenue/shared/paywall";
```

Then insert this chained handler after the `.patch("/:id", …)` block and before `.delete("/:id", …)`:

```ts
  // -----------------------------------------------------------
  // Versioning — publish / versions / revert / discard / label / diff
  //
  // `paywalls.builderConfig` is THE DRAFT. Publishing snapshots it into
  // paywall_versions and repoints `publishedVersionId`; /v1/placements
  // serves that snapshot, never the draft.
  // -----------------------------------------------------------

  .post("/:id/publish", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "products:write");

    const paywall = await drizzle.paywallRepo.findPaywallById(drizzle.db, projectId, id);
    if (!paywall) {
      throw new HTTPException(404, { message: "Paywall not found" });
    }
    if (paywall.builderConfig === null) {
      throw new HTTPException(400, {
        message: JSON.stringify({
          code: "PAYWALL_EMPTY_DRAFT",
          message: "This paywall has no builder config to publish.",
        }),
      });
    }

    // Re-validate at publish time rather than trusting what PATCH let
    // through: the offering's packages can change after the draft was
    // last saved, which can turn a previously-clean draft into one with
    // FOREIGN_PACKAGE_ID issues.
    const offering = await loadOffering(projectId, paywall.offeringId);
    const parsed = builderConfigSchema.safeParse(paywall.builderConfig);
    if (!parsed.success) {
      throw new HTTPException(400, {
        message: JSON.stringify({
          code: "PAYWALL_NOT_PUBLISHABLE",
          issues: parsed.error.issues.map((issue) => ({
            code: "SCHEMA_INVALID",
            message: `${issue.path.join(".")}: ${issue.message}`,
          })),
        }),
      });
    }
    const issues = validateBuilderConfig(parsed.data, {
      offeringPackageIds: extractOfferingPackageIds(offering),
    });
    if (issues.some(isBlockingIssue)) {
      throw new HTTPException(400, {
        message: JSON.stringify({ code: "PAYWALL_NOT_PUBLISHABLE", issues }),
      });
    }

    const result = await drizzle.db.transaction(async (tx) => {
      const versionNo = await drizzle.paywallVersionRepo.nextVersionNo(tx, id);
      const version = await drizzle.paywallVersionRepo.insert(tx, {
        paywallId: id,
        versionNo,
        builderConfig: paywall.builderConfig,
        remoteConfig: paywall.remoteConfig,
        offeringId: paywall.offeringId,
        configFormatVersion: paywall.configFormatVersion,
        publishedBy: user.id,
      });
      const updated = await drizzle.paywallRepo.setPublishedVersion(
        tx,
        projectId,
        id,
        version.id,
      );
      await audit(
        {
          projectId,
          userId: user.id,
          action: "paywall.published",
          resource: "paywall",
          resourceId: id,
          after: { versionNo, versionId: version.id, warnings: issues.length },
          ...extractRequestContext(c),
        },
        tx,
      );
      return { version, paywall: updated };
    });

    purgeProjectCatalogCache(projectId);
    return c.json(ok(result));
  })
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @rovenue/api vitest run tests/dashboard-paywalls-versions.integration.test.ts`
Expected: PASS — 5 tests in the `publish` describe.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/dashboard/paywalls.ts \
  apps/api/tests/dashboard-paywalls-versions.integration.test.ts
git commit -m "feat(api): POST /paywalls/:id/publish snapshots the draft into paywall_versions"
```

---

### Task 6: Version list + detail endpoints

**Files:**
- Modify: `apps/api/src/routes/dashboard/paywalls.ts`
- Modify: `apps/api/tests/dashboard-paywalls-versions.integration.test.ts`

**Interfaces:**
- Consumes: `paywallVersionRepo.listByPaywall/findByVersionNo` (Task 2); `DashboardPaywallVersionRow` (Task 3).
- Produces: `GET /:id/versions` → `{ data: { versions: DashboardPaywallVersionRow[] } }`; `GET /:id/versions/:versionNo` → `{ data: { version: … & { builderConfig, remoteConfig } } }`.

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/tests/dashboard-paywalls-versions.integration.test.ts`:

```ts
describe("GET /paywalls/:id/versions", () => {
  it("lists newest first and flags the live version", async () => {
    const app = buildApp();
    const paywall = await createPaywall("list", VALID_CONFIG);
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}/publish`, {
      method: "POST",
      headers: { cookie },
    });
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}/publish`, {
      method: "POST",
      headers: { cookie },
    });

    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/versions`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.versions.map((v: { versionNo: number }) => v.versionNo)).toEqual([2, 1]);
    expect(data.versions[0].isLive).toBe(true);
    expect(data.versions[1].isLive).toBe(false);
    expect(data.versions[0].publishedBy).toBe(userId);
    // The list shape carries metadata only.
    expect(data.versions[0].builderConfig).toBeUndefined();
  });

  it("returns an empty array for a never-published paywall", async () => {
    const app = buildApp();
    const paywall = await createPaywall("nover", VALID_CONFIG);
    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/versions`,
      { headers: { cookie } },
    );
    const { data } = await res.json();
    expect(data.versions).toEqual([]);
  });
});

describe("GET /paywalls/:id/versions/:versionNo", () => {
  it("returns the full snapshot", async () => {
    const app = buildApp();
    const paywall = await createPaywall("detail", VALID_CONFIG);
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}/publish`, {
      method: "POST",
      headers: { cookie },
    });

    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/versions/1`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.version.versionNo).toBe(1);
    expect(data.version.builderConfig).toEqual(VALID_CONFIG);
    expect(data.version.remoteConfig).toEqual({ defaultLocale: "en", locales: { en: {} } });
  });

  it("404s on an unknown versionNo", async () => {
    const app = buildApp();
    const paywall = await createPaywall("detail404", VALID_CONFIG);
    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/versions/99`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(404);
  });

  it("400s on a non-numeric versionNo", async () => {
    const app = buildApp();
    const paywall = await createPaywall("detail400", VALID_CONFIG);
    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/versions/abc`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @rovenue/api vitest run tests/dashboard-paywalls-versions.integration.test.ts -t "lists newest first"`
Expected: FAIL with 404.

- [ ] **Step 3: Implement the endpoints**

In `apps/api/src/routes/dashboard/paywalls.ts`, add this helper just above `export const paywallsDashboardRoute`:

```ts
/** Parse a `:versionNo` path segment, 400ing on anything that is not a
 * canonical positive integer (rejects "", "0", negatives, "1.5", "1e2",
 * "0x10", and whitespace-padded values — a bare Number() would admit the
 * last three). */
function parseVersionNo(raw: string | undefined): number {
  if (!raw || !/^[1-9][0-9]*$/.test(raw)) {
    throw new HTTPException(400, { message: "versionNo must be a positive integer" });
  }
  return Number(raw);
}

/** Metadata-only projection of a version row, shared by list and detail. */
function toVersionRow(
  v: {
    id: string;
    versionNo: number;
    label: string | null;
    offeringId: string;
    configFormatVersion: number;
    publishedAt: Date;
    publishedBy: string | null;
  },
  livePublishedVersionId: string | null,
) {
  return {
    id: v.id,
    versionNo: v.versionNo,
    label: v.label,
    offeringId: v.offeringId,
    configFormatVersion: v.configFormatVersion,
    publishedAt: v.publishedAt.toISOString(),
    publishedBy: v.publishedBy,
    isLive: v.id === livePublishedVersionId,
  };
}
```

Then add these handlers immediately after the `/:id/publish` handler:

```ts
  .get("/:id/versions", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const paywall = await drizzle.paywallRepo.findPaywallById(drizzle.db, projectId, id);
    if (!paywall) {
      throw new HTTPException(404, { message: "Paywall not found" });
    }
    const rows = await drizzle.paywallVersionRepo.listByPaywall(drizzle.db, id);
    return c.json(
      ok({ versions: rows.map((v) => toVersionRow(v, paywall.publishedVersionId)) }),
    );
  })

  .get("/:id/versions/:versionNo", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const versionNo = parseVersionNo(c.req.param("versionNo"));
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const paywall = await drizzle.paywallRepo.findPaywallById(drizzle.db, projectId, id);
    if (!paywall) {
      throw new HTTPException(404, { message: "Paywall not found" });
    }
    const version = await drizzle.paywallVersionRepo.findByVersionNo(
      drizzle.db,
      id,
      versionNo,
    );
    if (!version) {
      throw new HTTPException(404, { message: "Version not found" });
    }
    return c.json(
      ok({
        version: {
          ...toVersionRow(version, paywall.publishedVersionId),
          builderConfig: version.builderConfig,
          remoteConfig: version.remoteConfig,
        },
      }),
    );
  })
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @rovenue/api vitest run tests/dashboard-paywalls-versions.integration.test.ts`
Expected: PASS — all publish + versions tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/dashboard/paywalls.ts \
  apps/api/tests/dashboard-paywalls-versions.integration.test.ts
git commit -m "feat(api): paywall version list + detail endpoints"
```

---

### Task 7: Revert, discard-draft and label endpoints

**Files:**
- Modify: `apps/api/src/routes/dashboard/paywalls.ts`
- Modify: `apps/api/tests/dashboard-paywalls-versions.integration.test.ts`

**Interfaces:**
- Consumes: `paywallVersionRepo.findByVersionNo/findById/setLabel` (Task 2); `paywallRepo.updatePaywall` (existing).
- Produces:
  - `POST /:id/versions/:versionNo/revert` → `{ data: { paywall } }` (copies snapshot into the draft; does **not** publish)
  - `POST /:id/discard-draft` → `{ data: { paywall } }` (400 `PAYWALL_NO_PUBLISHED_VERSION` when nothing is published)
  - `PATCH /:id/versions/:versionNo` body `{ label: string | null }` → `{ data: { version } }`

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/tests/dashboard-paywalls-versions.integration.test.ts`:

```ts
describe("revert / discard-draft / label", () => {
  it("revert copies a snapshot back into the draft without republishing", async () => {
    const app = buildApp();
    const paywall = await createPaywall("revert", VALID_CONFIG);
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}/publish`, {
      method: "POST",
      headers: { cookie },
    });

    // Edit the draft: change the title string.
    const edited = {
      ...VALID_CONFIG,
      localizations: { en: { title: "Edited", cta: "Buy" } },
    };
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ builderConfig: edited }),
    });

    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/versions/1/revert`,
      { method: "POST", headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.paywall.builderConfig).toEqual(VALID_CONFIG);
    // Reverting touches the draft only — the live version is unchanged.
    expect(data.paywall.publishedVersionId).not.toBeNull();
    const versions = await (
      await app.request(`/projects/${projectId}/paywalls/${paywall.id}/versions`, {
        headers: { cookie },
      })
    ).json();
    expect(versions.data.versions).toHaveLength(1);
  });

  it("discard-draft resets the draft to the live version", async () => {
    const app = buildApp();
    const paywall = await createPaywall("discard", VALID_CONFIG);
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}/publish`, {
      method: "POST",
      headers: { cookie },
    });
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        builderConfig: {
          ...VALID_CONFIG,
          localizations: { en: { title: "Scratch", cta: "Buy" } },
        },
      }),
    });

    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/discard-draft`,
      { method: "POST", headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.paywall.builderConfig).toEqual(VALID_CONFIG);
  });

  it("discard-draft 400s when nothing has been published", async () => {
    const app = buildApp();
    const paywall = await createPaywall("discard-none", VALID_CONFIG);
    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/discard-draft`,
      { method: "POST", headers: { cookie } },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(JSON.parse(body.error.message).code).toBe("PAYWALL_NO_PUBLISHED_VERSION");
  });

  it("PATCH versions/:n sets and clears the label", async () => {
    const app = buildApp();
    const paywall = await createPaywall("label", VALID_CONFIG);
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}/publish`, {
      method: "POST",
      headers: { cookie },
    });

    const set = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/versions/1`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ label: "Q3 launch" }),
      },
    );
    expect(set.status).toBe(200);
    expect((await set.json()).data.version.label).toBe("Q3 launch");

    const clear = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/versions/1`,
      {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie },
        body: JSON.stringify({ label: null }),
      },
    );
    expect((await clear.json()).data.version.label).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @rovenue/api vitest run tests/dashboard-paywalls-versions.integration.test.ts -t "revert copies a snapshot"`
Expected: FAIL with 404.

- [ ] **Step 3: Implement the three endpoints**

In `apps/api/src/routes/dashboard/paywalls.ts`, add this schema next to the other body schemas:

```ts
const versionLabelBodySchema = z.object({
  label: z.string().trim().min(1).max(120).nullable(),
});
```

Then add these handlers after the `/:id/versions/:versionNo` GET handler:

```ts
  .post("/:id/versions/:versionNo/revert", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const versionNo = parseVersionNo(c.req.param("versionNo"));
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "products:write");

    const paywall = await drizzle.paywallRepo.findPaywallById(drizzle.db, projectId, id);
    if (!paywall) {
      throw new HTTPException(404, { message: "Paywall not found" });
    }
    const version = await drizzle.paywallVersionRepo.findByVersionNo(
      drizzle.db,
      id,
      versionNo,
    );
    if (!version) {
      throw new HTTPException(404, { message: "Version not found" });
    }

    // Revert restores the DRAFT only. The live version is untouched until
    // the author publishes again — same semantics as funnels' revert.
    const updated = await drizzle.db.transaction(async (tx) => {
      const row = await drizzle.paywallRepo.updatePaywall(tx, projectId, id, {
        builderConfig: version.builderConfig,
        remoteConfig: version.remoteConfig,
        offeringId: version.offeringId,
        configFormatVersion: version.configFormatVersion,
      });
      if (!row) {
        throw new HTTPException(404, { message: "Paywall not found" });
      }
      await audit(
        {
          projectId,
          userId: user.id,
          action: "paywall.reverted",
          resource: "paywall",
          resourceId: id,
          after: { versionNo, versionId: version.id },
          ...extractRequestContext(c),
        },
        tx,
      );
      return row;
    });

    return c.json(ok({ paywall: updated }));
  })

  .post("/:id/discard-draft", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "products:write");

    const paywall = await drizzle.paywallRepo.findPaywallById(drizzle.db, projectId, id);
    if (!paywall) {
      throw new HTTPException(404, { message: "Paywall not found" });
    }
    if (!paywall.publishedVersionId) {
      throw new HTTPException(400, {
        message: JSON.stringify({
          code: "PAYWALL_NO_PUBLISHED_VERSION",
          message: "Nothing has been published yet — there is no state to discard back to.",
        }),
      });
    }
    const live = await drizzle.paywallVersionRepo.findById(
      drizzle.db,
      paywall.publishedVersionId,
    );
    if (!live) {
      throw new HTTPException(404, { message: "Published version not found" });
    }

    const updated = await drizzle.db.transaction(async (tx) => {
      const row = await drizzle.paywallRepo.updatePaywall(tx, projectId, id, {
        builderConfig: live.builderConfig,
        remoteConfig: live.remoteConfig,
        offeringId: live.offeringId,
        configFormatVersion: live.configFormatVersion,
      });
      if (!row) {
        throw new HTTPException(404, { message: "Paywall not found" });
      }
      await audit(
        {
          projectId,
          userId: user.id,
          action: "paywall.draft_discarded",
          resource: "paywall",
          resourceId: id,
          after: { versionNo: live.versionNo, versionId: live.id },
          ...extractRequestContext(c),
        },
        tx,
      );
      return row;
    });

    return c.json(ok({ paywall: updated }));
  })

  .patch("/:id/versions/:versionNo", validate("json", versionLabelBodySchema), async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const versionNo = parseVersionNo(c.req.param("versionNo"));
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "products:write");
    const { label } = c.req.valid("json");

    const paywall = await drizzle.paywallRepo.findPaywallById(drizzle.db, projectId, id);
    if (!paywall) {
      throw new HTTPException(404, { message: "Paywall not found" });
    }

    const version = await drizzle.db.transaction(async (tx) => {
      const row = await drizzle.paywallVersionRepo.setLabel(tx, id, versionNo, label);
      if (!row) {
        throw new HTTPException(404, { message: "Version not found" });
      }
      await audit(
        {
          projectId,
          userId: user.id,
          action: "paywall.version_labeled",
          resource: "paywall",
          resourceId: id,
          after: { versionNo, label },
          ...extractRequestContext(c),
        },
        tx,
      );
      return row;
    });

    return c.json(ok({ version: toVersionRow(version, paywall.publishedVersionId) }));
  })
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @rovenue/api vitest run tests/dashboard-paywalls-versions.integration.test.ts`
Expected: PASS — all tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/dashboard/paywalls.ts \
  apps/api/tests/dashboard-paywalls-versions.integration.test.ts
git commit -m "feat(api): paywall revert, discard-draft and version-label endpoints"
```

---

### Task 8: `GET /:id/diff`

**Files:**
- Modify: `apps/api/src/routes/dashboard/paywalls.ts`
- Modify: `apps/api/tests/dashboard-paywalls-versions.integration.test.ts`

**Interfaces:**
- Consumes: `diffBuilderConfigs` (Task 4).
- Produces: `GET /:id/diff?from=<versionNo|draft>&to=<versionNo|draft>` → `DashboardPaywallDiffResponse`. Defaults: `from` = the live published version, `to` = `draft`.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/tests/dashboard-paywalls-versions.integration.test.ts`:

```ts
describe("GET /paywalls/:id/diff", () => {
  it("defaults to live-published → draft", async () => {
    const app = buildApp();
    const paywall = await createPaywall("diff", VALID_CONFIG);
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}/publish`, {
      method: "POST",
      headers: { cookie },
    });
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        builderConfig: {
          ...VALID_CONFIG,
          localizations: { en: { title: "Changed", cta: "Buy" } },
        },
      }),
    });

    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/diff`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.from.versionNo).toBe(1);
    expect(data.to.versionNo).toBeNull();
    expect(data.entries).toContainEqual({
      kind: "changed",
      scope: "localization",
      nodeId: null,
      nodeType: null,
      field: "en.title",
      from: '"Hello"',
      to: '"Changed"',
    });
  });

  it("accepts explicit version numbers on both sides", async () => {
    const app = buildApp();
    const paywall = await createPaywall("diff2", VALID_CONFIG);
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}/publish`, {
      method: "POST",
      headers: { cookie },
    });
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({
        builderConfig: { ...VALID_CONFIG, root: { ...VALID_CONFIG.root, spacing: 20 } },
      }),
    });
    await app.request(`/projects/${projectId}/paywalls/${paywall.id}/publish`, {
      method: "POST",
      headers: { cookie },
    });

    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/diff?from=1&to=2`,
      { headers: { cookie } },
    );
    const { data } = await res.json();
    expect(data.from.versionNo).toBe(1);
    expect(data.to.versionNo).toBe(2);
    expect(data.entries).toContainEqual({
      kind: "added",
      scope: "node",
      nodeId: "root",
      nodeType: "stack",
      field: "spacing",
      from: null,
      to: "20",
    });
  });

  it("returns an empty diff when nothing has been published", async () => {
    const app = buildApp();
    const paywall = await createPaywall("diff-none", VALID_CONFIG);
    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/diff`,
      { headers: { cookie } },
    );
    const { data } = await res.json();
    expect(data.from.versionNo).toBeNull();
    // No published side → everything in the draft reads as added.
    expect(data.entries.length).toBeGreaterThan(0);
    expect(data.entries.every((e: { kind: string }) => e.kind === "added")).toBe(true);
  });

  it("404s on an unknown version number", async () => {
    const app = buildApp();
    const paywall = await createPaywall("diff404", VALID_CONFIG);
    const res = await app.request(
      `/projects/${projectId}/paywalls/${paywall.id}/diff?from=42`,
      { headers: { cookie } },
    );
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rovenue/api vitest run tests/dashboard-paywalls-versions.integration.test.ts -t "defaults to live-published"`
Expected: FAIL with 404.

- [ ] **Step 3: Implement the diff endpoint**

In `apps/api/src/routes/dashboard/paywalls.ts`, add this handler after the `PATCH /:id/versions/:versionNo` handler:

```ts
  .get("/:id/diff", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing identifier" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const paywall = await drizzle.paywallRepo.findPaywallById(drizzle.db, projectId, id);
    if (!paywall) {
      throw new HTTPException(404, { message: "Paywall not found" });
    }

    /**
     * Resolve one side of the diff. `"draft"` (and the default for `to`)
     * means the live `paywalls.builderConfig`; a number means that
     * published version; the default for `from` is whatever is currently
     * live, which is the comparison the diff modal actually shows.
     */
    async function resolveSide(
      raw: string | undefined,
      fallback: "draft" | "live",
    ): Promise<{ versionNo: number | null; label: string | null; config: unknown }> {
      const spec = raw ?? fallback;
      if (spec === "draft") {
        return { versionNo: null, label: null, config: paywall!.builderConfig };
      }
      if (spec === "live") {
        if (!paywall!.publishedVersionId) {
          return { versionNo: null, label: null, config: null };
        }
        const live = await drizzle.paywallVersionRepo.findById(
          drizzle.db,
          paywall!.publishedVersionId,
        );
        if (!live) return { versionNo: null, label: null, config: null };
        return { versionNo: live.versionNo, label: live.label, config: live.builderConfig };
      }
      const versionNo = parseVersionNo(spec);
      const version = await drizzle.paywallVersionRepo.findByVersionNo(
        drizzle.db,
        id!,
        versionNo,
      );
      if (!version) {
        throw new HTTPException(404, { message: "Version not found" });
      }
      return {
        versionNo: version.versionNo,
        label: version.label,
        config: version.builderConfig,
      };
    }

    const from = await resolveSide(c.req.query("from"), "live");
    const to = await resolveSide(c.req.query("to"), "draft");

    // Both sides are already schema-validated (PATCH and publish both
    // parse before persisting), so a plain cast is safe here; a defensive
    // re-parse would double the work on a read-only endpoint.
    const entries = diffBuilderConfigs(
      (from.config as Parameters<typeof diffBuilderConfigs>[0]) ?? null,
      (to.config as Parameters<typeof diffBuilderConfigs>[1]) ?? null,
    );

    return c.json(
      ok({
        from: { versionNo: from.versionNo, label: from.label },
        to: { versionNo: to.versionNo, label: to.label },
        entries,
      }),
    );
  })
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @rovenue/api vitest run tests/dashboard-paywalls-versions.integration.test.ts`
Expected: PASS — all tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/dashboard/paywalls.ts \
  apps/api/tests/dashboard-paywalls-versions.integration.test.ts
git commit -m "feat(api): GET /paywalls/:id/diff comparing published versions and the draft"
```

---

### Task 9: `/v1/placements` serves the published version

**Files:**
- Modify: `apps/api/src/lib/placement-resolution.ts:36-80,119-165`
- Create: `apps/api/tests/placement-resolution-published-version.integration.test.ts`

**Interfaces:**
- Consumes: `paywallVersionRepo.findById/findByIds` (Task 2).
- Produces: `hydratePaywall(projectId, paywall, version, requestedLocale?)` — the `version` parameter is new and required. A paywall whose `publishedVersionId` is null is skipped exactly like `!isActive`.

**This is the behavioural change the whole plan exists for. Task 1's backfill must be applied before this ships, or every existing paywall resolves to `null`.**

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/tests/placement-resolution-published-version.integration.test.ts`:

```ts
// =============================================================
// /v1/placements must serve the PUBLISHED snapshot, never the draft.
//
// This is the regression guard for the P0 defect: before the
// draft/publish split, `paywalls.builderConfig` was both the builder's
// autosave target and the document shipped to devices, so an
// in-progress edit went live as soon as the edge cache expired.
// =============================================================

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, projects, offerings, drizzle } from "@rovenue/db";
import { resolvePlacement } from "../src/lib/placement-resolution";

const RUN_ID = Date.now();
const db = getDb();

let projectId: string;
let offeringId: string;
let paywallId: string;
let placement: Awaited<ReturnType<typeof drizzle.placementRepo.findPlacementByIdentifier>>;

const PUBLISHED_CONFIG = {
  formatVersion: 2,
  defaultLocale: "en",
  localizations: { en: { title: "Published", cta: "Buy" } },
  root: {
    type: "stack",
    id: "root",
    axis: "v",
    children: [
      { type: "text", id: "t1", key: "title", role: "title" },
      { type: "packageList", id: "pl", packageIds: ["monthly"], cellLayout: "row" },
      { type: "purchaseButton", id: "pb", labelKey: "cta" },
    ],
  },
};

const DRAFT_CONFIG = {
  ...PUBLISHED_CONFIG,
  localizations: { en: { title: "WORK IN PROGRESS", cta: "Buy" } },
};

beforeAll(async () => {
  const [project] = await db
    .insert(projects)
    .values({ name: `plres-${RUN_ID}` })
    .returning();
  projectId = project!.id;

  const [offering] = await db
    .insert(offerings)
    .values({
      projectId,
      identifier: `off-${RUN_ID}`,
      name: "Default",
      packages: [{ identifier: "monthly", productId: null }],
    })
    .returning();
  offeringId = offering!.id;

  const paywall = await drizzle.paywallRepo.createPaywall(db, {
    projectId,
    identifier: `pw-${RUN_ID}`,
    name: "Resolution paywall",
    offeringId,
    remoteConfig: { defaultLocale: "en", locales: { en: { theme: "published" } } },
    builderConfig: PUBLISHED_CONFIG,
    configFormatVersion: 2,
  });
  paywallId = paywall.id;

  // Publish v1 from the published config, then dirty the draft.
  const version = await drizzle.paywallVersionRepo.insert(db, {
    paywallId,
    versionNo: 1,
    builderConfig: PUBLISHED_CONFIG,
    remoteConfig: { defaultLocale: "en", locales: { en: { theme: "published" } } },
    offeringId,
    configFormatVersion: 2,
  });
  await drizzle.paywallRepo.setPublishedVersion(db, projectId, paywallId, version.id);
  await drizzle.paywallRepo.updatePaywall(db, projectId, paywallId, {
    builderConfig: DRAFT_CONFIG,
    remoteConfig: { defaultLocale: "en", locales: { en: { theme: "draft" } } },
  });

  await drizzle.placementRepo.createPlacement(db, {
    projectId,
    identifier: `pl-${RUN_ID}`,
    name: "Onboarding",
    rows: [{ audienceId: null, target: { type: "paywall", paywallId } }],
  });
  placement = await drizzle.placementRepo.findPlacementByIdentifier(
    db,
    projectId,
    `pl-${RUN_ID}`,
  );
});

afterAll(async () => {
  await db.delete(projects).where(eq(projects.id, projectId));
});

describe("resolvePlacement", () => {
  it("serves the published builderConfig, not the draft", async () => {
    const resolved = await resolvePlacement(projectId, placement!, {});
    expect(resolved.paywall).not.toBeNull();
    expect(resolved.paywall!.builderConfig).toEqual(PUBLISHED_CONFIG);
    expect(
      (resolved.paywall!.builderConfig as typeof PUBLISHED_CONFIG).localizations.en!.title,
    ).toBe("Published");
  });

  it("serves the published remoteConfig, not the draft", async () => {
    const resolved = await resolvePlacement(projectId, placement!, {});
    expect(resolved.paywall!.remoteConfig).toEqual({
      locale: "en",
      data: { theme: "published" },
    });
  });

  it("resolves to null when nothing has been published", async () => {
    const unpublished = await drizzle.paywallRepo.createPaywall(db, {
      projectId,
      identifier: `pw-unpub-${RUN_ID}`,
      name: "Never published",
      offeringId,
      remoteConfig: { defaultLocale: "en", locales: { en: {} } },
      builderConfig: DRAFT_CONFIG,
      configFormatVersion: 2,
    });
    await drizzle.placementRepo.createPlacement(db, {
      projectId,
      identifier: `pl-unpub-${RUN_ID}`,
      name: "Unpublished placement",
      rows: [{ audienceId: null, target: { type: "paywall", paywallId: unpublished.id } }],
    });
    const p = await drizzle.placementRepo.findPlacementByIdentifier(
      db,
      projectId,
      `pl-unpub-${RUN_ID}`,
    );
    const resolved = await resolvePlacement(projectId, p!, {});
    expect(resolved.paywall).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rovenue/api vitest run tests/placement-resolution-published-version.integration.test.ts`
Expected: FAIL — `expected 'WORK IN PROGRESS' to be 'Published'` (the resolver still reads the draft).

- [ ] **Step 3: Rewrite `hydratePaywall` to take a version**

In `apps/api/src/lib/placement-resolution.ts`, replace the `hydratePaywall` function (line 41) with:

```ts
type PaywallVersionRow = NonNullable<
  Awaited<ReturnType<typeof drizzle.paywallVersionRepo.findById>>
>;

/**
 * Hydrate the PUBLISHED snapshot, never `paywalls.builderConfig`.
 *
 * `paywalls.builderConfig` is the builder's private draft — serving it
 * here is exactly the P0 defect this split fixed. Identifier and name
 * come from the live row (identifier is immutable, name is cosmetic);
 * everything the device actually renders comes from `version`, including
 * `offeringId`, so re-pointing the draft at another offering can't
 * retroactively change what a published version resolves against.
 */
async function hydratePaywall(
  projectId: string,
  paywall: PaywallRow,
  version: PaywallVersionRow,
  requestedLocale?: string,
) {
  const offering = await drizzle.offeringRepo.findOfferingById(
    drizzle.db,
    projectId,
    version.offeringId,
  );
  const { locale, data } = resolveLocale(version.remoteConfig, requestedLocale);
  return {
    id: paywall.id,
    identifier: paywall.identifier,
    name: paywall.name,
    configFormatVersion: version.configFormatVersion,
    remoteConfig: locale ? { locale, data } : null,
    // builderConfig ships whole (all localizations) — ?locale only slices
    // remoteConfig above. Field is present ONLY when non-null: the Rust
    // SDK wire fixtures decode this payload, and adding a field is safe
    // (serde ignores unknown fields) but an always-present `null` isn't
    // worth the wire-size cost for paywalls that don't use the builder.
    ...(version.builderConfig !== null && { builderConfig: version.builderConfig }),
    offering: offering ? await hydrateOffering(projectId, offering) : null,
  };
}
```

- [ ] **Step 4: Update the direct-paywall branch**

In the same file, in the `row.target.type === "paywall"` branch (~line 121), replace the block that currently reads:

```ts
      if (!paywall || !paywall.isActive) continue; // dangling ref → next row
```

and its following `return` with:

```ts
      if (!paywall || !paywall.isActive) continue; // dangling ref → next row
      // No published version → treat exactly like an inactive paywall.
      // A draft must never resolve on a device.
      if (!paywall.publishedVersionId) continue;
      const version = await drizzle.paywallVersionRepo.findById(
        drizzle.db,
        paywall.publishedVersionId,
      );
      if (!version) continue;
      return {
        placement: placementInfo,
        paywall: await hydratePaywall(projectId, paywall, version, requestedLocale),
        experiment: null,
      };
```

(keep the existing surrounding structure; only the guard and the `hydratePaywall` call site change).

- [ ] **Step 5: Update the batched experiment-variant branch**

In the variant-hydration block (~line 149), after the existing `findPaywallsByIds` call and `paywallById` map, add a second batched lookup and thread it through:

```ts
    const paywallById = new Map(variantPaywalls.map((p) => [p.id, p] as const));

    // Second batched lookup so the variant fan-out still costs two
    // queries, not one per variant.
    const versionIds = variantPaywalls
      .map((p) => p.publishedVersionId)
      .filter((v): v is string => v !== null);
    const versions = await drizzle.paywallVersionRepo.findByIds(drizzle.db, versionIds);
    const versionById = new Map(versions.map((v) => [v.id, v] as const));
```

Then in the per-variant mapping, replace:

```ts
          const paywall = paywallById.get(ref.paywallId);
          if (!paywall || !paywall.isActive) return null;
```

with:

```ts
          const paywall = paywallById.get(ref.paywallId);
          if (!paywall || !paywall.isActive) return null;
          if (!paywall.publishedVersionId) return null;
          const version = versionById.get(paywall.publishedVersionId);
          if (!version) return null;
```

and update that variant's `hydratePaywall(projectId, paywall, requestedLocale)` call to `hydratePaywall(projectId, paywall, version, requestedLocale)`.

- [ ] **Step 6: Run the new test to verify it passes**

Run: `pnpm --filter @rovenue/api vitest run tests/placement-resolution-published-version.integration.test.ts`
Expected: PASS — 3 tests.

- [ ] **Step 7: Run the existing placement and fallback-export suites**

Run: `pnpm --filter @rovenue/api vitest run tests/dashboard-paywalls-fallback-export.integration.test.ts tests/dashboard-experiments-paywall-variants.integration.test.ts`
Expected: PASS. `fallback-export` goes through `resolvePlacement`, so it now exports published versions automatically — if its fixtures create paywalls without publishing, publish them in the fixture setup (via `paywallVersionRepo.insert` + `paywallRepo.setPublishedVersion`) rather than relaxing the resolver.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/lib/placement-resolution.ts \
  apps/api/tests/placement-resolution-published-version.integration.test.ts \
  apps/api/tests/dashboard-paywalls-fallback-export.integration.test.ts \
  apps/api/tests/dashboard-experiments-paywall-variants.integration.test.ts
git commit -m "fix(api): /v1/placements serves the published paywall version, never the draft"
```

---

### Task 10: Dashboard API client + view-model state

**Files:**
- Modify: `apps/dashboard/src/lib/services/paywall-builder-api.ts`
- Modify: `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.ts`
- Modify: `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.test.ts`

**Interfaces:**
- Consumes: the six endpoints from Tasks 5–8.
- Produces on `PaywallBuilderApi`:
  - `publish(projectId, paywallId): Promise<{ versionNo: number }>`
  - `listVersions(projectId, paywallId): Promise<DashboardPaywallVersionRow[]>`
  - `revert(projectId, paywallId, versionNo): Promise<PaywallBuilderDetailDto>`
  - `discardDraft(projectId, paywallId): Promise<PaywallBuilderDetailDto>`
  - `labelVersion(projectId, paywallId, versionNo, label: string | null): Promise<void>`
  - `diff(projectId, paywallId): Promise<DashboardPaywallDiffResponse>`
- Produces on `PaywallBuilderViewModel`: `status`, `publishedVersionId`, `versions`, `diffResult`, `publishState: "idle" | "publishing" | "error"`, `publishError: string | null`, `canPublish: boolean`, `hasUnpublishedChanges: boolean`, and the methods `publish()`, `loadVersions()`, `loadDiff()`, `revertTo(versionNo)`, `discardToPublished()`, `labelVersion(versionNo, label)`.

**Three collisions with the existing VM that this task must respect:**
1. `discardDraft()` **already exists** and means "re-fetch from the server, throwing away unsaved local edits". The new server-side reset is therefore named **`discardToPublished()`** — do not overload the existing name.
2. The flush-the-autosave method is **`saveNow()`**, not `flushSave()`.
3. `this.config` is **never null** — `syncFromDetail` falls back to `emptyBuilderConfig(...)`. Do not write `config !== null` guards.

Also note the load lifecycle: `init()` is a sync `@onInit` that only copies props; the async work happens in the `@onMount load(cleanup)` method. New fetches belong at the end of `load()`.

- [ ] **Step 1: Write the failing VM test**

First extend the existing `fakeDetail()` helper in `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.test.ts` with the two new DTO fields, before the `...overrides` spread:

```ts
    status: "draft",
    publishedVersionId: null,
```

Then append this describe block to the same file:

```ts
// ----- Publish / versions -----
describe("publish flow", () => {
  function blockingConfig(): BuilderConfig {
    // packageList with no purchaseButton anywhere → MISSING_PURCHASE_BUTTON
    const config = emptyBuilderConfig("en");
    config.root.children.push({
      type: "packageList",
      id: "pl",
      packageIds: ["pkg_monthly"],
      cellLayout: "row",
    });
    return config;
  }

  const LIVE_VERSION = {
    id: "pwv_1",
    versionNo: 3,
    label: null,
    offeringId: "off_1",
    configFormatVersion: 2,
    publishedAt: "2026-07-23T00:00:00.000Z",
    publishedBy: "u_1",
    isLive: true,
  };

  const EMPTY_DIFF = {
    from: { versionNo: 3, label: null },
    to: { versionNo: null, label: null },
    entries: [],
  };

  it("canPublish is false while blocking issues exist", async () => {
    const vm = makeVm({
      get: vi.fn().mockResolvedValue(fakeDetail({ builderConfig: blockingConfig() })),
      patchBuilderConfig: vi.fn(),
      listVersions: vi.fn().mockResolvedValue([]),
      diff: vi.fn().mockResolvedValue(EMPTY_DIFF),
    });
    await vm.load(() => {});

    expect(vm.errorIssues.length).toBeGreaterThan(0);
    expect(vm.canPublish).toBe(false);
  });

  it("canPublish is true for a clean draft", async () => {
    const vm = makeVm({
      get: vi.fn().mockResolvedValue(fakeDetail()),
      patchBuilderConfig: vi.fn(),
      listVersions: vi.fn().mockResolvedValue([]),
      diff: vi.fn().mockResolvedValue(EMPTY_DIFF),
    });
    await vm.load(() => {});

    expect(vm.errorIssues).toEqual([]);
    expect(vm.canPublish).toBe(true);
  });

  it("publish() flushes the autosave, calls the API and refreshes versions", async () => {
    const publish = vi.fn().mockResolvedValue({ versionNo: 3 });
    const listVersions = vi.fn().mockResolvedValue([LIVE_VERSION]);
    const diff = vi.fn().mockResolvedValue(EMPTY_DIFF);
    const patchBuilderConfig = vi.fn().mockResolvedValue(fakeDetail());
    const vm = makeVm({
      get: vi.fn().mockResolvedValue(fakeDetail()),
      patchBuilderConfig,
      publish,
      listVersions,
      diff,
    });
    await vm.load(() => {});

    // Dirty the draft so saveNow() actually fires.
    vm.addNode("spacer", "root");
    await vm.publish();

    expect(patchBuilderConfig).toHaveBeenCalled();
    expect(publish).toHaveBeenCalledWith("p_1", "pw_1");
    expect(vm.versions[0]?.versionNo).toBe(3);
    expect(vm.status).toBe("published");
    expect(vm.publishState).toBe("idle");
    expect(vm.hasUnpublishedChanges).toBe(false);
  });

  it("publish() surfaces the server's blocking-issue error", async () => {
    const vm = makeVm({
      get: vi.fn().mockResolvedValue(fakeDetail()),
      patchBuilderConfig: vi.fn(),
      publish: vi.fn().mockRejectedValue(new Error("PAYWALL_NOT_PUBLISHABLE")),
      listVersions: vi.fn().mockResolvedValue([]),
      diff: vi.fn().mockResolvedValue(EMPTY_DIFF),
    });
    await vm.load(() => {});

    await vm.publish();

    expect(vm.publishState).toBe("error");
    expect(vm.publishError).toContain("PAYWALL_NOT_PUBLISHABLE");
  });

  it("hasUnpublishedChanges is true when the diff is non-empty", async () => {
    const vm = makeVm({
      get: vi.fn().mockResolvedValue(fakeDetail({ status: "published", publishedVersionId: "pwv_1" })),
      patchBuilderConfig: vi.fn(),
      listVersions: vi.fn().mockResolvedValue([LIVE_VERSION]),
      diff: vi.fn().mockResolvedValue({
        from: { versionNo: 3, label: null },
        to: { versionNo: null, label: null },
        entries: [
          {
            kind: "changed",
            scope: "localization",
            nodeId: null,
            nodeType: null,
            field: "en.t1_key",
            from: '"Hi"',
            to: '"Hello"',
          },
        ],
      }),
    });
    await vm.load(() => {});

    expect(vm.hasUnpublishedChanges).toBe(true);
  });

  it("discardToPublished() replaces the working tree with the server's response", async () => {
    const resetConfig = emptyBuilderConfig("en");
    resetConfig.localizations.en.t1_key = "Live";
    const vm = makeVm({
      get: vi.fn().mockResolvedValue(fakeDetail()),
      patchBuilderConfig: vi.fn(),
      discardToPublished: vi.fn().mockResolvedValue(fakeDetail({ builderConfig: resetConfig })),
      listVersions: vi.fn().mockResolvedValue([LIVE_VERSION]),
      diff: vi.fn().mockResolvedValue(EMPTY_DIFF),
    });
    await vm.load(() => {});

    await vm.discardToPublished();

    expect(vm.config.localizations.en?.t1_key).toBe("Live");
    expect(vm.config.root.children).toEqual([]);
    expect(vm.isDirty).toBe(false);
  });

  it("revertTo() applies the server response and reloads the version list", async () => {
    const revertedConfig = emptyBuilderConfig("en");
    revertedConfig.localizations.en.t1_key = "Reverted";
    const listVersions = vi.fn().mockResolvedValue([LIVE_VERSION]);
    const revert = vi.fn().mockResolvedValue(fakeDetail({ builderConfig: revertedConfig }));
    const vm = makeVm({
      get: vi.fn().mockResolvedValue(fakeDetail()),
      patchBuilderConfig: vi.fn(),
      revert,
      listVersions,
      diff: vi.fn().mockResolvedValue(EMPTY_DIFF),
    });
    await vm.load(() => {});
    listVersions.mockClear();

    await vm.revertTo(2);

    expect(revert).toHaveBeenCalledWith("p_1", "pw_1", 2);
    expect(listVersions).toHaveBeenCalled();
    expect(vm.config.localizations.en?.t1_key).toBe("Reverted");
    expect(vm.config.root.children).toEqual([]);
    expect(vm.isDirty).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rovenue/dashboard vitest run src/components/paywall-builder/vm/paywall-builder.vm.test.ts -t "publish flow"`
Expected: FAIL — `vm.canPublish is not a function` / `vm.publish is not a function`.

- [ ] **Step 3: Extend `PaywallBuilderApi`**

In `apps/dashboard/src/lib/services/paywall-builder-api.ts`, add the two new fields to `PaywallBuilderDetailDto`:

```ts
  status: "draft" | "published" | "archived";
  publishedVersionId: string | null;
```

and to `toDetailDto`'s return object:

```ts
    status: row.status,
    publishedVersionId: row.publishedVersionId,
```

Add the import:

```ts
import type {
  DashboardOfferingRow,
  DashboardPaywallRow,
  DashboardPaywallDiffResponse,
  DashboardPaywallVersionRow,
} from "@rovenue/shared";
```

and these methods to the class:

```ts
  async publish(
    projectId: string,
    paywallId: string,
    signal?: AbortSignal,
  ): Promise<{ versionNo: number }> {
    const { version } = await unwrap<{ version: { versionNo: number } }>(
      rpc.dashboard.projects[":projectId"].paywalls[":id"].publish.$post(
        { param: { projectId, id: paywallId } },
        { init: { signal } },
      ),
    );
    return { versionNo: version.versionNo };
  }

  async listVersions(
    projectId: string,
    paywallId: string,
    signal?: AbortSignal,
  ): Promise<DashboardPaywallVersionRow[]> {
    const { versions } = await unwrap<{ versions: DashboardPaywallVersionRow[] }>(
      rpc.dashboard.projects[":projectId"].paywalls[":id"].versions.$get(
        { param: { projectId, id: paywallId } },
        { init: { signal } },
      ),
    );
    return versions;
  }

  async revert(
    projectId: string,
    paywallId: string,
    versionNo: number,
    signal?: AbortSignal,
  ): Promise<PaywallBuilderDetailDto> {
    const { paywall } = await unwrap<{ paywall: DashboardPaywallRow }>(
      rpc.dashboard.projects[":projectId"].paywalls[":id"].versions[":versionNo"].revert.$post(
        { param: { projectId, id: paywallId, versionNo: String(versionNo) } },
        { init: { signal } },
      ),
    );
    const offeringPackageIds = await this.fetchOfferingPackageIds(
      projectId,
      paywall.offeringId,
      signal,
    );
    return toDetailDto(paywall, offeringPackageIds);
  }

  /** Server-side reset of the draft back to the live published version.
   * Distinct from `PaywallBuilderViewModel.discardDraft()`, which merely
   * re-fetches to throw away unsaved LOCAL edits. */
  async discardToPublished(
    projectId: string,
    paywallId: string,
    signal?: AbortSignal,
  ): Promise<PaywallBuilderDetailDto> {
    const { paywall } = await unwrap<{ paywall: DashboardPaywallRow }>(
      rpc.dashboard.projects[":projectId"].paywalls[":id"]["discard-draft"].$post(
        { param: { projectId, id: paywallId } },
        { init: { signal } },
      ),
    );
    const offeringPackageIds = await this.fetchOfferingPackageIds(
      projectId,
      paywall.offeringId,
      signal,
    );
    return toDetailDto(paywall, offeringPackageIds);
  }

  async labelVersion(
    projectId: string,
    paywallId: string,
    versionNo: number,
    label: string | null,
    signal?: AbortSignal,
  ): Promise<void> {
    await unwrap<{ version: DashboardPaywallVersionRow }>(
      rpc.dashboard.projects[":projectId"].paywalls[":id"].versions[":versionNo"].$patch(
        {
          param: { projectId, id: paywallId, versionNo: String(versionNo) },
          json: { label } as never,
        },
        { init: { signal } },
      ),
    );
  }

  async diff(
    projectId: string,
    paywallId: string,
    signal?: AbortSignal,
  ): Promise<DashboardPaywallDiffResponse> {
    return unwrap<DashboardPaywallDiffResponse>(
      rpc.dashboard.projects[":projectId"].paywalls[":id"].diff.$get(
        { param: { projectId, id: paywallId } },
        { init: { signal } },
      ),
    );
  }
```

- [ ] **Step 4: Extend the view model**

In `apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.ts`, add the import:

```ts
import type {
  DashboardPaywallDiffResponse,
  DashboardPaywallVersionRow,
} from "@rovenue/shared";
```

Add these observable fields alongside the existing ones:

```ts
  status: "draft" | "published" | "archived" = "draft";
  publishedVersionId: string | null = null;
  versions: DashboardPaywallVersionRow[] = [];
  publishState: "idle" | "publishing" | "error" = "idle";
  publishError: string | null = null;
  /** Server-computed published→draft diff. `entries.length === 0` is the
   * authoritative "the draft matches what devices are served" signal —
   * cheaper and more honest than reconstructing it from local snapshots,
   * because the server owns both sides. */
  diffResult: DashboardPaywallDiffResponse | null = null;
```

In `syncFromDetail`, after `this.paywall = detail;`, also copy the two new fields:

```ts
    this.status = detail.status;
    this.publishedVersionId = detail.publishedVersionId;
```

At the end of the `@onMount load(cleanup)` method's `try` block, after `this.applyServer(detail);`, add:

```ts
      // Version list + diff drive the publish group's chips. Fire and
      // forget: a failure here must not fail the builder's load.
      void this.refreshPublishState();
```

Add the derived getters next to the existing `isDirty`:

```ts
  /**
   * True from a save until the next `loadDiff` reconfirms the delta. An
   * autosave clears `isDirty` (draft == SERVER) but the cached `diffResult`
   * still reflects the pre-save draft, so without this `hasUnpublishedChanges`
   * would briefly collapse to false and the "in sync" chip would lie. Set
   * synchronously in the save success path, cleared only when the refetched
   * diff lands.
   */
  private diffStale = false;

  /**
   * Publishing is gated on zero blocking issues AND `hasUnpublishedChanges`
   * (an in-sync draft would otherwise mint an identical vN+1). A never-
   * published paywall always has changes (its `publishedVersionId === null`
   * branch), so first-publish stays enabled. `config` is never null
   * (syncFromDetail falls back to emptyBuilderConfig), so there is no null
   * check here — the server's PAYWALL_EMPTY_DRAFT guard covers "never saved".
   */
  @derived get canPublish(): boolean {
    return (
      !this.isLoading &&
      this.errorIssues.length === 0 &&
      this.publishState !== "publishing" &&
      this.hasUnpublishedChanges
    );
  }

  /** True when the draft differs from what devices are currently served. */
  @derived get hasUnpublishedChanges(): boolean {
    if (this.isDirty || this.diffStale) return true;
    if (this.publishedVersionId === null) return true;
    // Unknown until the first diff lands — report "no changes" rather
    // than flashing a false warning chip on load.
    return (this.diffResult?.entries.length ?? 0) > 0;
  }

  /**
   * A save changed the persisted draft, so the cached diff is stale. Mark
   * it and refetch; `loadDiff` clears the flag when the fresh delta lands.
   * Fire-and-forget and NON-FATAL: on a failed refetch `diffStale` stays
   * true, so the UI conservatively keeps reporting unpublished changes.
   * Call at the end of the success path in BOTH `autosave` and `saveNow`.
   */
  private refreshDiffAfterSave() {
    this.diffStale = true;
    void this.loadDiff().catch(() => {});
  }
```

Add the action methods at the end of the class:

```ts
  async loadVersions() {
    this.versions = await this.api.listVersions(this.props.projectId, this.props.paywallId);
  }

  async loadDiff() {
    this.diffResult = await this.api.diff(this.props.projectId, this.props.paywallId);
    // The cached diff now reflects the current persisted draft.
    this.diffStale = false;
  }

  /** Refresh both publish-state reads together; used on load and after
   * every publish / revert / discard. */
  private async refreshPublishState() {
    try {
      await Promise.all([this.loadVersions(), this.loadDiff()]);
    } catch {
      // Non-fatal: the publish group degrades to "unknown", the builder
      // itself keeps working.
    }
  }

  async publish() {
    if (!this.canPublish) return;
    this.publishState = "publishing";
    this.publishError = null;
    try {
      // Flush first: publish snapshots what the SERVER holds, so an
      // edit still sitting behind the 30s autosave throttle would
      // silently not ship.
      await this.saveNow();
      await this.api.publish(this.props.projectId, this.props.paywallId);
      this.status = "published";
      await this.refreshPublishState();
      // publish returns only { versionNo }; the live version's id comes from
      // the refreshed version list so publishedVersionId can't go stale.
      this.publishedVersionId =
        this.versions.find((v) => v.isLive)?.id ?? this.publishedVersionId;
      this.publishState = "idle";
    } catch (err) {
      this.publishState = "error";
      this.publishError = err instanceof Error ? err.message : String(err);
    }
  }

  async revertTo(versionNo: number) {
    const detail = await this.api.revert(
      this.props.projectId,
      this.props.paywallId,
      versionNo,
    );
    this.applyServer(detail);
    await this.refreshPublishState();
  }

  /**
   * Reset the draft to the live published version, server-side. Distinct
   * from `discardDraft()` above, which only re-fetches to drop unsaved
   * local edits.
   */
  async discardToPublished() {
    const detail = await this.api.discardToPublished(
      this.props.projectId,
      this.props.paywallId,
    );
    this.applyServer(detail);
    await this.refreshPublishState();
  }

  async labelVersion(versionNo: number, label: string | null) {
    await this.api.labelVersion(
      this.props.projectId,
      this.props.paywallId,
      versionNo,
      label,
    );
    await this.loadVersions();
  }
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm --filter @rovenue/dashboard vitest run src/components/paywall-builder/vm/paywall-builder.vm.test.ts`
Expected: PASS — existing tests plus the 7 new publish-flow tests.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/lib/services/paywall-builder-api.ts \
  apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.ts \
  apps/dashboard/src/components/paywall-builder/vm/paywall-builder.vm.test.ts
git commit -m "feat(dashboard): paywall builder publish/version state in the view model"
```

---

### Task 11: Top-bar publish group + version menu

**Files:**
- Create: `apps/dashboard/src/components/paywall-builder/version-menu.tsx`
- Modify: `apps/dashboard/src/components/paywall-builder/top-bar.tsx`

**Interfaces:**
- Consumes: `vm.canPublish`, `vm.publish()`, `vm.versions`, `vm.loadVersions()`, `vm.revertTo()`, `vm.discardToPublished()`, `vm.labelVersion()`, `vm.status`, `vm.publishState`, `vm.publishError`, `vm.hasUnpublishedChanges` (Task 10).
- Produces: `<VersionMenu onClose={() => void} onOpenDiff={() => void} />`; `TopBar` gains an `onOpenDiff: () => void` prop.

- [ ] **Step 1: Write the version menu**

Create `apps/dashboard/src/components/paywall-builder/version-menu.tsx`:

```tsx
import { useEffect, useState } from "react";
import { component, useService } from "impair";
import { useTranslation } from "react-i18next";
import { Check, GitCompare, History, RotateCcw } from "lucide-react";
import { cn } from "../../lib/cn";
import { PaywallBuilderViewModel } from "./vm/paywall-builder.vm";

type Props = {
  onClose: () => void;
  onOpenDiff: () => void;
};

/**
 * Publish history dropdown. Versions are immutable except for their
 * label, so the only mutating actions here are "name this version",
 * "revert draft to this version" and "discard draft changes" — none of
 * which touch what devices are currently served.
 */
export const VersionMenu = component(({ onClose, onOpenDiff }: Props) => {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const [labelling, setLabelling] = useState<number | null>(null);
  const [labelDraft, setLabelDraft] = useState("");

  useEffect(() => {
    void vm.loadVersions();
  }, [vm]);

  return (
    <>
      <div className="fixed inset-0 z-[49]" onClick={onClose} />
      <div className="absolute right-0 top-full z-50 mt-1 w-[340px] rounded-lg border border-rv-divider-strong bg-rv-c1 p-1.5 shadow-[0_18px_44px_rgba(0,0,0,0.5)]">
        <div className="mb-1 px-1.5 py-1 font-rv-mono text-[9px] uppercase tracking-wider text-rv-mute-500">
          {t("paywalls.builder.versions.title", "Version history")}
        </div>

        {vm.versions.length === 0 && (
          <div className="px-2 py-3 text-[12px] text-rv-mute-500">
            {t("paywalls.builder.versions.empty", "Nothing published yet.")}
          </div>
        )}

        {vm.versions.map((v) => (
          <div key={v.id} className="flex items-start gap-2 rounded px-2 py-1.5 hover:bg-rv-c2">
            <span className="mt-0.5 min-w-[26px] font-rv-mono text-[11px] text-rv-mute-500">
              v{v.versionNo}
            </span>
            <div className="min-w-0 flex-1">
              {labelling === v.versionNo ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void vm.labelVersion(v.versionNo, labelDraft.trim() || null);
                    setLabelling(null);
                  }}
                >
                  <input
                    autoFocus
                    value={labelDraft}
                    onChange={(e) => setLabelDraft(e.currentTarget.value)}
                    onBlur={() => setLabelling(null)}
                    placeholder={t("paywalls.builder.versions.labelPlaceholder", "Name this version…")}
                    className="h-6 w-full rounded border border-rv-divider bg-rv-c2 px-1.5 text-[12px] text-foreground outline-none focus:border-rv-accent-500"
                  />
                </form>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setLabelDraft(v.label ?? "");
                    setLabelling(v.versionNo);
                  }}
                  className="block w-full cursor-text truncate text-left text-[12px] text-foreground"
                >
                  {v.label ?? t("paywalls.builder.versions.unnamed", "Unnamed version")}
                </button>
              )}
              <div className="mt-0.5 font-rv-mono text-[10px] text-rv-mute-500">
                {new Date(v.publishedAt).toLocaleString()}
              </div>
            </div>
            {v.isLive && (
              <span className="mt-0.5 rounded bg-rv-success/15 px-1.5 py-0.5 font-rv-mono text-[9px] uppercase tracking-wider text-rv-success">
                {t("paywalls.builder.versions.live", "live")}
              </span>
            )}
            {!v.isLive && (
              <button
                type="button"
                title={t("paywalls.builder.versions.revert", "Revert draft to this version")}
                onClick={() => {
                  void vm.revertTo(v.versionNo);
                  onClose();
                }}
                className="mt-0.5 flex h-5 w-5 cursor-pointer items-center justify-center rounded text-rv-mute-500 transition hover:bg-rv-c3 hover:text-foreground"
              >
                <RotateCcw size={11} />
              </button>
            )}
          </div>
        ))}

        <div className="my-1 h-px bg-rv-divider" />

        <button
          type="button"
          onClick={() => {
            onClose();
            onOpenDiff();
          }}
          className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-foreground transition hover:bg-rv-c2"
        >
          <GitCompare size={13} className="text-rv-mute-500" />
          {t("paywalls.builder.versions.diff", "Diff draft vs published")}
        </button>
        <button
          type="button"
          disabled={vm.publishedVersionId === null}
          onClick={() => {
            void vm.discardToPublished();
            onClose();
          }}
          className={cn(
            "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] transition",
            vm.publishedVersionId === null
              ? "cursor-not-allowed text-rv-mute-600 opacity-50"
              : "cursor-pointer text-rv-danger hover:bg-rv-danger/10",
          )}
        >
          <History size={13} />
          {t("paywalls.builder.versions.discard", "Discard draft changes")}
        </button>
      </div>
    </>
  );
});
```

- [ ] **Step 2: Wire the publish group into the top bar**

In `apps/dashboard/src/components/paywall-builder/top-bar.tsx`:

Add to the imports:

```tsx
import { CloudUpload, GitBranch } from "lucide-react";
import { VersionMenu } from "./version-menu";
```

Change `Props` to:

```tsx
type Props = {
  projectId: string;
  onOpenValidation: () => void;
  onOpenDiff: () => void;
};
```

and destructure `onOpenDiff` in the component signature. Add near the top of the component body:

```tsx
  const [versionsOpen, setVersionsOpen] = useState(false);
```

Then insert this block immediately after the closing `)}` of the existing issues/warnings/no-issues conditional, before the closing `</div>` of the right-hand group:

```tsx
        <div className="mx-0.5 h-5 w-px bg-rv-divider" />

        {vm.status === "published" && !vm.hasUnpublishedChanges && (
          <span
            title={t(
              "paywalls.builder.topbar.inSyncHint",
              "The draft matches what devices are being served",
            )}
            className="inline-flex h-7 items-center gap-1.5 rounded-md border border-rv-divider bg-rv-c2 px-2 font-rv-mono text-[11px] text-rv-mute-600"
          >
            {t("paywalls.builder.topbar.inSync", "in sync")}
          </span>
        )}

        <div className="relative flex items-center">
          <button
            type="button"
            disabled={!vm.canPublish}
            onClick={() => void vm.publish()}
            title={
              vm.canPublish
                ? t("paywalls.builder.topbar.publishHint", "Publish over-the-air")
                : t(
                    "paywalls.builder.topbar.publishBlocked",
                    "Resolve blocking issues before publishing",
                  )
            }
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-l-md border border-r-0 px-2.5 text-[11px] font-medium transition",
              vm.canPublish
                ? "cursor-pointer border-rv-accent-500 bg-rv-accent-500 text-white hover:bg-rv-accent-600"
                : "cursor-not-allowed border-rv-divider bg-rv-c2 text-rv-mute-600 opacity-60",
            )}
          >
            <CloudUpload size={13} />
            {vm.publishState === "publishing"
              ? t("paywalls.builder.topbar.publishing", "Publishing…")
              : t("paywalls.builder.topbar.publish", "Publish")}
          </button>
          <button
            type="button"
            onClick={() => setVersionsOpen((o) => !o)}
            title={t("paywalls.builder.topbar.versions", "Version history")}
            className="flex h-7 w-6 cursor-pointer items-center justify-center rounded-r-md border border-rv-divider bg-rv-c2 text-rv-mute-600 transition hover:bg-rv-c3 hover:text-foreground"
          >
            <GitBranch size={12} />
          </button>
          {versionsOpen && (
            <VersionMenu onClose={() => setVersionsOpen(false)} onOpenDiff={onOpenDiff} />
          )}
        </div>
```

Also add, directly under the existing `AutosaveBadge`, a publish-error surface:

```tsx
        {vm.publishState === "error" && (
          <button
            type="button"
            onClick={onOpenValidation}
            title={vm.publishError ?? ""}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-rv-danger/40 bg-rv-danger/15 px-2 text-[11px] font-medium text-rv-danger"
          >
            <TriangleAlert size={12} />
            {t("paywalls.builder.topbar.publishFailed", "Publish failed")}
          </button>
        )}
```

- [ ] **Step 3: Typecheck and lint**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit`
Expected: exits 0 — note this fails until Task 12 supplies `onOpenDiff` from `BuilderShell`. Pass a temporary `onOpenDiff={() => {}}` in `builder-shell.tsx` now and replace it in Task 12.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/components/paywall-builder/version-menu.tsx \
  apps/dashboard/src/components/paywall-builder/top-bar.tsx \
  apps/dashboard/src/components/paywall-builder/builder-shell.tsx
git commit -m "feat(dashboard): paywall builder publish button + version history menu"
```

---

### Task 12: Diff modal

**Files:**
- Create: `apps/dashboard/src/components/paywall-builder/diff-modal.tsx`
- Modify: `apps/dashboard/src/components/paywall-builder/builder-shell.tsx`
- Modify: `apps/dashboard/src/components/paywall-builder/index.ts`

**Interfaces:**
- Consumes: `vm.loadDiff()`, `vm.diffResult` (Task 10).
- Produces: `<DiffModal onClose={() => void} />`, mounted from `BuilderShell` and opened by the version menu's "Diff draft vs published".

- [ ] **Step 1: Write the modal**

Create `apps/dashboard/src/components/paywall-builder/diff-modal.tsx`:

```tsx
import { useEffect } from "react";
import { component, useService } from "impair";
import { useTranslation } from "react-i18next";
import { ArrowRight, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { PaywallBuilderViewModel } from "./vm/paywall-builder.vm";

type Props = { onClose: () => void };

const KIND_CLASS: Record<string, string> = {
  added: "bg-rv-success/15 text-rv-success",
  removed: "bg-rv-danger/15 text-rv-danger",
  changed: "bg-rv-warning/15 text-rv-warning",
};

/**
 * "What ships when I hit Publish" — the published version on the left,
 * the draft on the right. Entries come from `diffBuilderConfigs` on the
 * server so this component never has to reimplement tree comparison.
 */
export const DiffModal = component(({ onClose }: Props) => {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();

  useEffect(() => {
    void vm.loadDiff();
  }, [vm]);

  const diff = vm.diffResult;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[84vh] w-[min(680px,94vw)] flex-col rounded-xl border border-rv-divider-strong bg-rv-c1 shadow-[0_30px_80px_rgba(0,0,0,0.6)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-rv-divider px-5 py-4">
          <div className="flex-1">
            <h2 className="text-[15px] font-semibold text-foreground">
              {diff
                ? t("paywalls.builder.diff.title", "Published v{{from}} → draft", {
                    from: diff.from.versionNo ?? "—",
                  })
                : t("paywalls.builder.diff.loading", "Comparing…")}
            </h2>
            <p className="mt-0.5 text-[12px] text-rv-mute-500">
              {diff
                ? t("paywalls.builder.diff.subtitle", {
                    count: diff.entries.length,
                    defaultValue: "{{count}} change ships when you publish.",
                    defaultValue_other: "{{count}} changes ship when you publish.",
                  })
                : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-rv-mute-600 transition hover:bg-rv-c2 hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {diff && diff.entries.length === 0 && (
            <div className="py-8 text-center text-[13px] text-rv-mute-500">
              {t("paywalls.builder.diff.none", "The draft matches the published version.")}
            </div>
          )}
          {diff?.entries.map((e, i) => (
            <div
              key={`${e.scope}-${e.nodeId ?? ""}-${e.field}-${i}`}
              className="flex items-start gap-3 border-b border-rv-divider py-2.5 last:border-b-0"
            >
              <span
                className={cn(
                  "mt-0.5 rounded px-1.5 py-0.5 font-rv-mono text-[9px] uppercase tracking-wider",
                  KIND_CLASS[e.kind],
                )}
              >
                {e.kind}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] text-foreground">
                  {e.nodeId
                    ? `${e.nodeType ?? "node"} · ${e.nodeId}`
                    : t(`paywalls.builder.diff.scope.${e.scope}`, e.scope)}
                </div>
                <div className="truncate font-rv-mono text-[10px] text-rv-mute-500">
                  {e.field}
                </div>
                <div className="mt-1 flex items-center gap-2 font-rv-mono text-[11px]">
                  {e.from !== null && (
                    <span className="truncate rounded bg-rv-danger/10 px-1.5 py-0.5 text-rv-danger line-through">
                      {e.from}
                    </span>
                  )}
                  {e.from !== null && e.to !== null && (
                    <ArrowRight size={11} className="flex-shrink-0 text-rv-mute-500" />
                  )}
                  {e.to !== null && (
                    <span className="truncate rounded bg-rv-success/10 px-1.5 py-0.5 text-rv-success">
                      {e.to}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-rv-divider px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 cursor-pointer items-center rounded-md border border-rv-divider bg-rv-c2 px-3 text-[12px] text-foreground transition hover:bg-rv-c3"
          >
            {t("paywalls.builder.diff.close", "Close")}
          </button>
          <button
            type="button"
            disabled={!vm.canPublish}
            onClick={() => {
              void vm.publish();
              onClose();
            }}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12px] font-medium transition",
              vm.canPublish
                ? "cursor-pointer bg-rv-accent-500 text-white hover:bg-rv-accent-600"
                : "cursor-not-allowed bg-rv-c2 text-rv-mute-600 opacity-60",
            )}
          >
            {t("paywalls.builder.diff.publish", "Publish these changes")}
          </button>
        </div>
      </div>
    </div>
  );
});
```

- [ ] **Step 2: Mount it from `BuilderShell`**

In `apps/dashboard/src/components/paywall-builder/builder-shell.tsx`, add the import:

```tsx
import { DiffModal } from "./diff-modal";
```

add the state next to `showValidation`:

```tsx
  const [showDiff, setShowDiff] = useState(false);
```

replace the `<TopBar …>` line with:

```tsx
      <TopBar
        projectId={projectId}
        onOpenValidation={() => setShowValidation(true)}
        onOpenDiff={() => setShowDiff(true)}
      />
```

and add next to the validation drawer:

```tsx
      {showDiff && <DiffModal onClose={() => setShowDiff(false)} />}
```

- [ ] **Step 3: Export from the barrel**

In `apps/dashboard/src/components/paywall-builder/index.ts`, add:

```ts
export { DiffModal } from "./diff-modal";
export { VersionMenu } from "./version-menu";
```

- [ ] **Step 4: Typecheck and build the dashboard**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit && pnpm --filter @rovenue/dashboard build`
Expected: both exit 0.

- [ ] **Step 5: Run the whole affected test surface**

Run:

```bash
pnpm --filter @rovenue/shared vitest run src/paywall
pnpm --filter @rovenue/db vitest run src/drizzle/repositories/paywall-versions.integration.test.ts
pnpm --filter @rovenue/api vitest run tests/dashboard-paywalls tests/placement-resolution-published-version.integration.test.ts
pnpm --filter @rovenue/dashboard vitest run src/components/paywall-builder
```

Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/components/paywall-builder/diff-modal.tsx \
  apps/dashboard/src/components/paywall-builder/builder-shell.tsx \
  apps/dashboard/src/components/paywall-builder/index.ts
git commit -m "feat(dashboard): paywall draft-vs-published diff modal"
```

---

## Post-implementation verification

Before declaring P0 done, confirm each of these with actual command output:

1. `pnpm build` — full monorepo build is green.
2. `pnpm --filter @rovenue/api vitest run tests/` — no regressions in the API suite beyond the pre-existing red tests documented in the repo.
3. Against a seeded dev database: edit a paywall in the builder, do **not** publish, then `curl` `/v1/placements/<identifier>` with a project public key and confirm the response still carries the **previous** `builderConfig`. This is the manual proof that the P0 defect is closed.
4. `SELECT count(*) FROM "paywalls" WHERE "publishedVersionId" IS NULL;` on a database migrated from a pre-0093 snapshot returns `0`.

## Deferred to later phases (explicitly out of scope here)

- Localization matrix, staleness, auto-translate → P2
- Template gallery, App Store import → P3
- New node types and the renderer unknown-type fallback branch → P4a/P4b/P4c
- Inspector tab split and node-level visibility → P5
- Commerce binding UX and the resolved-catalog endpoint → P6
- A/B from the builder, AI FAB, on-device preview, fonts → P7–P10
