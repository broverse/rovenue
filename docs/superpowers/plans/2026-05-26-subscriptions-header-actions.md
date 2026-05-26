# Subscriptions Header Actions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the three inert header buttons on `/projects/:projectId/subscriptions` (Schedule, Export CSV, New subscription) end-to-end — schema, services, endpoints, BullMQ worker, dashboard modals, and tests.

**Architecture:** Add `MANUAL` to the `Store` enum + a new `scheduled_subscription_actions` table. Three vertical slices: (1) `POST /subscriptions` grants a comp/promo purchase via an in-tx insert + entitlement replay + outbox + audit; (2) `POST /subscriptions/:purchaseId/schedule` enqueues a row picked up every 60s by a new BullMQ sweeper that branches by store; (3) `GET /subscriptions/export.csv` streams a CSV by walking the existing `listSubscriptions` cursor. Each slice writes audit entries inside its own tx.

**Tech Stack:** Hono + Zod + Drizzle ORM (Postgres 16), BullMQ + Redis, React Query + TanStack Router, Vitest + testcontainers.

**Spec:** `docs/superpowers/specs/2026-05-26-subscriptions-header-actions-design.md`

---

## Pre-flight Checklist (do these once before Task 1)

- [ ] **Read the spec** end-to-end: `docs/superpowers/specs/2026-05-26-subscriptions-header-actions-design.md`.
- [ ] **Read these files** to absorb the established patterns you will mirror:
  - `apps/api/src/routes/dashboard/subscriptions.ts` — Hono route shape, `requireDashboardAuth`, `assertProjectAccess`, `ok` helper, zValidator usage.
  - `apps/api/src/workers/expiry-checker.ts` — BullMQ Queue/Worker setup, repeatable job pattern, batch sweep with `FOR UPDATE SKIP LOCKED`. Your scheduled-actions worker MUST mirror this.
  - `apps/api/src/lib/audit.ts:190` — `audit(entry, callerTx?)` signature; pass the caller tx so audit commits atomically.
  - `packages/db/src/drizzle/schema.ts:474-530` — `purchases` table shape; you will insert into this.
  - `packages/db/src/drizzle/repositories/purchases.ts` — repo style for purchases.
  - `apps/dashboard/src/routes/_authed/projects/$projectId/subscriptions.tsx` — the page with the three inert buttons.
  - `apps/dashboard/src/lib/hooks/useProjectSubscriptions.ts` — React Query hook style.
- [ ] **Search for `case "STRIPE"` / `case "APP_STORE"` / `case "PLAY_STORE"`** in `apps/api/src` and note every file. After Task 2 adds `MANUAL` to the enum you will need to add a `case "MANUAL"` branch (or default) in each switch to keep the TypeScript exhaustiveness check happy.

```bash
grep -rn -E '"(APP_STORE|PLAY_STORE|STRIPE)"' apps/api/src packages/db/src 2>/dev/null
```

---

## File Structure

**Schema (packages/db):**
- Modify: `packages/db/src/drizzle/enums.ts` — add `MANUAL` to `store`, add `scheduledActionType`, `scheduledActionStatus`.
- Modify: `packages/db/src/drizzle/schema.ts` — add `scheduledSubscriptionActions` table.
- Modify: `packages/db/src/drizzle/index.ts` — export new repo barrel.
- Create: `packages/db/src/drizzle/repositories/scheduled-actions.ts` — typed CRUD for the new table.
- Generated: `packages/db/drizzle/migrations/<timestamp>_subscriptions_header_actions.sql` — output of `pnpm db:migrate:generate`.

**Shared types (packages/shared):**
- Modify: `packages/shared/src/dashboard.ts` — add `GrantSubscriptionRequest`, `ScheduleActionRequest`, `ScheduledActionRow`, `ListScheduledActionsResponse`.

**API (apps/api):**
- Create: `apps/api/src/services/subscriptions/grant.ts` — comp grant service (tx).
- Create: `apps/api/src/services/subscriptions/schedule.ts` — create/list/cancel scheduled actions.
- Create: `apps/api/src/services/subscriptions/export-csv.ts` — streaming CSV generator + CSV row writer.
- Create: `apps/api/src/workers/scheduled-actions.ts` — BullMQ queue + sweeper worker.
- Modify: `apps/api/src/routes/dashboard/subscriptions.ts` — add `POST /`, `POST /:purchaseId/schedule`, `GET /scheduled`, `DELETE /scheduled/:id`, `GET /export.csv`.
- Modify: `apps/api/src/index.ts` — register the new worker on boot.

**Dashboard (apps/dashboard):**
- Create: `apps/dashboard/src/components/subscriptions/grant-modal.tsx` — comp grant form modal.
- Create: `apps/dashboard/src/components/subscriptions/schedule-modal.tsx` — schedule cancel form modal.
- Modify: `apps/dashboard/src/components/subscriptions/index.ts` — re-export.
- Modify: `apps/dashboard/src/components/subscriptions/expanded-row.tsx` — show pending scheduled actions footer.
- Modify: `apps/dashboard/src/lib/hooks/useProjectSubscriptions.ts` — add `useGrantSubscription`, `useScheduleAction`, `useScheduledActions`, `useDeleteScheduledAction`, `buildExportUrl`.
- Modify: `apps/dashboard/src/routes/_authed/projects/$projectId/subscriptions.tsx` — wire the three buttons.

**Tests:**
- Create: `apps/api/src/services/subscriptions/grant.integration.test.ts`
- Create: `apps/api/src/services/subscriptions/schedule.integration.test.ts`
- Create: `apps/api/src/services/subscriptions/export-csv.test.ts`
- Create: `apps/api/src/workers/scheduled-actions.integration.test.ts`
- Create: `apps/api/src/routes/dashboard/subscriptions.integration.test.ts` (or extend if exists)

---

## Task 1: Add `MANUAL` to the Store enum + scheduled-actions enums

**Files:**
- Modify: `packages/db/src/drizzle/enums.ts`

- [ ] **Step 1: Read the file**

Read: `packages/db/src/drizzle/enums.ts`

- [ ] **Step 2: Add `MANUAL` to the store enum and add two new enums**

Edit `packages/db/src/drizzle/enums.ts`. Change:

```ts
export const store = pgEnum("Store", [
  "APP_STORE",
  "PLAY_STORE",
  "STRIPE",
]);
```

to:

```ts
export const store = pgEnum("Store", [
  "APP_STORE",
  "PLAY_STORE",
  "STRIPE",
  "MANUAL",
]);

export const scheduledActionType = pgEnum("ScheduledActionType", ["CANCEL"]);

export const scheduledActionStatus = pgEnum("ScheduledActionStatus", [
  "PENDING",
  "EXECUTED",
  "CANCELED",
  "FAILED",
]);
```

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/drizzle/enums.ts
git commit -m "feat(db): add MANUAL store + ScheduledAction enums"
```

---

## Task 2: Add `scheduled_subscription_actions` table to schema

**Files:**
- Modify: `packages/db/src/drizzle/schema.ts`

- [ ] **Step 1: Locate the bottom of schema.ts** (the file already imports `pgTable`, `text`, `timestamp`, `index`, `jsonb`, `createId`, `projects`, `subscribers`, `purchases`)

Run:
```bash
grep -n "^export const " packages/db/src/drizzle/schema.ts | tail -10
```

- [ ] **Step 2: Add the import for new enums at the top of schema.ts**

In the existing import line from `./enums`, add `scheduledActionType` and `scheduledActionStatus` alongside what's already imported.

- [ ] **Step 3: Append the new table at the bottom of schema.ts**

```ts
// =============================================================
// scheduled_subscription_actions
// =============================================================

export const scheduledSubscriptionActions = pgTable(
  "scheduled_subscription_actions",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    purchaseId: text("purchaseId")
      .notNull()
      .references(() => purchases.id, { onDelete: "cascade" }),
    subscriberId: text("subscriberId")
      .notNull()
      .references(() => subscribers.id, { onDelete: "cascade" }),
    action: scheduledActionType("action").notNull(),
    dueAt: timestamp("dueAt", { withTimezone: true }).notNull(),
    status: scheduledActionStatus("status").notNull().default("PENDING"),
    payload: jsonb("payload")
      .$type<{ revokeImmediately?: boolean }>()
      .notNull()
      .default({}),
    createdBy: text("createdBy").notNull(),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    executedAt: timestamp("executedAt", { withTimezone: true }),
    error: text("error"),
  },
  (t) => ({
    projectIdStatusIdx: index(
      "scheduled_actions_projectId_status_idx",
    ).on(t.projectId, t.status),
    statusDueAtIdx: index("scheduled_actions_status_dueAt_idx").on(
      t.status,
      t.dueAt,
    ),
  }),
);
```

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/drizzle/schema.ts
git commit -m "feat(db): add scheduled_subscription_actions table"
```

---

## Task 3: Generate + apply migration

**Files:**
- Generated: `packages/db/drizzle/migrations/<timestamp>_…sql`

- [ ] **Step 1: Generate migration**

Run:
```bash
pnpm db:migrate:generate
```

Expected: a new SQL file under `packages/db/drizzle/migrations/`. Inspect it. The enum addition must be `ALTER TYPE "Store" ADD VALUE 'MANUAL';` (and the same for the two new enums) — NOT a `DROP TYPE`. Drizzle usually gets this right; if it tries to DROP/CREATE, edit the SQL to use `ALTER TYPE … ADD VALUE` instead.

- [ ] **Step 2: Apply migration**

Run:
```bash
pnpm db:migrate
```

Expected: migration applied, no errors.

- [ ] **Step 3: Verify in psql**

```bash
psql "$DATABASE_URL" -c "\dT+ \"Store\"" -c "\d scheduled_subscription_actions"
```

Expected: `Store` shows 4 values including `MANUAL`; the new table exists with both indexes.

- [ ] **Step 4: Commit**

```bash
git add packages/db/drizzle/migrations
git commit -m "feat(db): migrate MANUAL store + scheduled_subscription_actions"
```

---

## Task 4: Add `scheduled-actions` repository

**Files:**
- Create: `packages/db/src/drizzle/repositories/scheduled-actions.ts`
- Modify: `packages/db/src/drizzle/index.ts`

- [ ] **Step 1: Create repo file**

Write `packages/db/src/drizzle/repositories/scheduled-actions.ts`:

```ts
import { and, eq, lte, sql } from "drizzle-orm";
import type { PgTransaction } from "drizzle-orm/pg-core";
import { db } from "../client";
import { scheduledSubscriptionActions } from "../schema";

export type ScheduledActionRow =
  typeof scheduledSubscriptionActions.$inferSelect;
export type NewScheduledAction =
  typeof scheduledSubscriptionActions.$inferInsert;

export async function insertScheduledAction(
  row: NewScheduledAction,
  tx?: PgTransaction<any, any, any>,
): Promise<ScheduledActionRow> {
  const exec = tx ?? db;
  const [inserted] = await exec
    .insert(scheduledSubscriptionActions)
    .values(row)
    .returning();
  return inserted;
}

export async function findPendingForPurchase(
  purchaseId: string,
): Promise<ScheduledActionRow | null> {
  const [row] = await db
    .select()
    .from(scheduledSubscriptionActions)
    .where(
      and(
        eq(scheduledSubscriptionActions.purchaseId, purchaseId),
        eq(scheduledSubscriptionActions.status, "PENDING"),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function listForProject(
  projectId: string,
  limit: number,
): Promise<ScheduledActionRow[]> {
  return db
    .select()
    .from(scheduledSubscriptionActions)
    .where(eq(scheduledSubscriptionActions.projectId, projectId))
    .orderBy(scheduledSubscriptionActions.dueAt)
    .limit(limit);
}

export async function cancelPending(
  id: string,
  projectId: string,
): Promise<ScheduledActionRow | null> {
  const [row] = await db
    .update(scheduledSubscriptionActions)
    .set({ status: "CANCELED" })
    .where(
      and(
        eq(scheduledSubscriptionActions.id, id),
        eq(scheduledSubscriptionActions.projectId, projectId),
        eq(scheduledSubscriptionActions.status, "PENDING"),
      ),
    )
    .returning();
  return row ?? null;
}

// Used by the worker. Selects up to `limit` due PENDING rows with
// row-level locks, skipping any already locked by another worker.
// MUST be called inside a transaction so SKIP LOCKED holds.
export async function claimDueBatch(
  tx: PgTransaction<any, any, any>,
  limit: number,
): Promise<ScheduledActionRow[]> {
  const rows = await tx.execute(sql`
    SELECT * FROM scheduled_subscription_actions
    WHERE status = 'PENDING' AND "dueAt" <= NOW()
    ORDER BY "dueAt"
    LIMIT ${limit}
    FOR UPDATE SKIP LOCKED
  `);
  return rows as unknown as ScheduledActionRow[];
}

export async function markExecuted(
  id: string,
  tx: PgTransaction<any, any, any>,
): Promise<void> {
  await tx
    .update(scheduledSubscriptionActions)
    .set({ status: "EXECUTED", executedAt: new Date() })
    .where(eq(scheduledSubscriptionActions.id, id));
}

export async function markFailed(
  id: string,
  error: string,
  tx: PgTransaction<any, any, any>,
): Promise<void> {
  await tx
    .update(scheduledSubscriptionActions)
    .set({ status: "FAILED", executedAt: new Date(), error })
    .where(eq(scheduledSubscriptionActions.id, id));
}
```

**Note on `db`/`client` path:** verify the actual export name by reading `packages/db/src/drizzle/index.ts` once. If the package exposes `drizzle.db` instead of bare `db` from `./client`, adjust the import accordingly. Match the style of the existing `repositories/purchases.ts` file.

- [ ] **Step 2: Add barrel export**

Edit `packages/db/src/drizzle/index.ts`. Add:

```ts
export * as scheduledActionsRepo from "./repositories/scheduled-actions";
```

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/drizzle/repositories/scheduled-actions.ts packages/db/src/drizzle/index.ts
git commit -m "feat(db): scheduled-actions repository"
```

---

## Task 5: Add shared Zod schemas + types

**Files:**
- Modify: `packages/shared/src/dashboard.ts`

- [ ] **Step 1: Read the file** to see the existing schema/type style (look at one existing schema like `SubscriptionRow` and copy its shape).

- [ ] **Step 2: Append**

```ts
// =============================================================
// Subscriptions — header actions (grant / schedule / export)
// =============================================================

export const grantDurationSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("preset"),
    preset: z.enum(["1mo", "3mo", "6mo", "1yr", "lifetime"]),
  }),
  z.object({ kind: z.literal("custom"), expiresAt: z.string().datetime() }),
]);

export const grantSubscriptionRequestSchema = z.object({
  subscriberId: z.string().min(1),
  productId: z.string().min(1),
  duration: grantDurationSchema,
  note: z.string().trim().max(200).optional(),
});
export type GrantSubscriptionRequest = z.infer<
  typeof grantSubscriptionRequestSchema
>;

export const scheduleActionRequestSchema = z.object({
  action: z.literal("CANCEL"),
  dueAt: z.string().datetime(),
  revokeImmediately: z.boolean().optional().default(false),
});
export type ScheduleActionRequest = z.infer<
  typeof scheduleActionRequestSchema
>;

export type ScheduledActionStatus =
  | "PENDING"
  | "EXECUTED"
  | "CANCELED"
  | "FAILED";

export type ScheduledActionRow = {
  id: string;
  purchaseId: string;
  subscriberId: string;
  action: "CANCEL";
  status: ScheduledActionStatus;
  dueAt: string;
  payload: { revokeImmediately?: boolean };
  createdAt: string;
  executedAt: string | null;
  error: string | null;
  // joined for display
  productName: string | null;
  store: string;
};

export type ListScheduledActionsResponse = {
  rows: ScheduledActionRow[];
};
```

- [ ] **Step 3: Build the shared package** to catch type errors

```bash
pnpm --filter @rovenue/shared build
```

Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/dashboard.ts
git commit -m "feat(shared): subscription grant/schedule request schemas"
```

---

## Task 6: Grant service — write failing test first

**Files:**
- Create: `apps/api/src/services/subscriptions/grant.integration.test.ts`

- [ ] **Step 1: Write the test file**

```ts
import { describe, it, expect, beforeEach } from "vitest";
import { grantComp } from "./grant";
import { drizzle, purchases, subscriberAccess, auditLogs, outboxEvents } from "@rovenue/db";
import { eq } from "drizzle-orm";
import { seedProject, seedSubscriber, seedProduct } from "../../../test/seed";
import { withTestDb } from "../../../test/with-test-db";

describe("grantComp", () => {
  withTestDb();

  it("creates a MANUAL purchase with computed expiresDate for a 3mo preset", async () => {
    const project = await seedProject();
    const sub = await seedSubscriber({ projectId: project.id });
    const prod = await seedProduct({ projectId: project.id });

    const result = await grantComp({
      projectId: project.id,
      actorUserId: "user-1",
      input: {
        subscriberId: sub.id,
        productId: prod.id,
        duration: { kind: "preset", preset: "3mo" },
        note: "VIP comp",
      },
    });

    expect(result.store).toBe("MANUAL");
    expect(result.storeTransactionId).toMatch(/^comp_/);
    expect(result.priceAmount).toBe("0");
    expect(result.autoRenewStatus).toBe(false);
    const now = Date.now();
    const expires = result.expiresDate!.getTime();
    // 3 months ≈ 90 days; allow 1 day slack for month-length variance.
    const expectedMs = 90 * 24 * 3600 * 1000;
    expect(Math.abs(expires - (now + expectedMs))).toBeLessThan(2 * 24 * 3600 * 1000);

    const access = await drizzle.db
      .select()
      .from(subscriberAccess)
      .where(eq(subscriberAccess.purchaseId, result.id));
    expect(access.length).toBeGreaterThan(0);

    const audits = await drizzle.db
      .select()
      .from(auditLogs)
      .where(eq(auditLogs.resourceId, result.id));
    expect(audits[0]?.action).toBe("subscription.granted");

    const outbox = await drizzle.db
      .select()
      .from(outboxEvents)
      .where(eq(outboxEvents.aggregateId, result.id));
    expect(outbox.length).toBe(1);
  });

  it("creates a lifetime grant with expiresDate=null", async () => {
    const project = await seedProject();
    const sub = await seedSubscriber({ projectId: project.id });
    const prod = await seedProduct({ projectId: project.id });

    const result = await grantComp({
      projectId: project.id,
      actorUserId: "user-1",
      input: {
        subscriberId: sub.id,
        productId: prod.id,
        duration: { kind: "preset", preset: "lifetime" },
      },
    });

    expect(result.expiresDate).toBeNull();
  });

  it("rejects a subscriber from another project", async () => {
    const projectA = await seedProject();
    const projectB = await seedProject();
    const subB = await seedSubscriber({ projectId: projectB.id });
    const prodA = await seedProduct({ projectId: projectA.id });

    await expect(
      grantComp({
        projectId: projectA.id,
        actorUserId: "user-1",
        input: {
          subscriberId: subB.id,
          productId: prodA.id,
          duration: { kind: "preset", preset: "1mo" },
        },
      }),
    ).rejects.toThrow(/subscriber/i);
  });

  it("rejects a custom expiresAt in the past", async () => {
    const project = await seedProject();
    const sub = await seedSubscriber({ projectId: project.id });
    const prod = await seedProduct({ projectId: project.id });

    await expect(
      grantComp({
        projectId: project.id,
        actorUserId: "user-1",
        input: {
          subscriberId: sub.id,
          productId: prod.id,
          duration: {
            kind: "custom",
            expiresAt: new Date(Date.now() - 1000).toISOString(),
          },
        },
      }),
    ).rejects.toThrow(/future/i);
  });
});
```

**Note on test helpers (`seedProject`, `seedSubscriber`, `seedProduct`, `withTestDb`):** these already exist somewhere in `apps/api/src/test/` or `apps/api/test/`. Read one existing `*.integration.test.ts` to find the exact import paths and helper signatures, then adjust the imports above to match. If a helper is missing (e.g. `seedProduct`), add it alongside the existing ones using the same style.

- [ ] **Step 2: Run the test (expect failure)**

```bash
pnpm --filter @rovenue/api test grant.integration -- --run
```

Expected: FAIL because `./grant` does not exist.

- [ ] **Step 3: Commit the failing test**

```bash
git add apps/api/src/services/subscriptions/grant.integration.test.ts
git commit -m "test(api): failing tests for grantComp service"
```

---

## Task 7: Implement grant service

**Files:**
- Create: `apps/api/src/services/subscriptions/grant.ts`

- [ ] **Step 1: Find the existing access resolver**

```bash
grep -rln "subscriberAccess" apps/api/src | head -5
```

Read whichever file owns "given a purchase, write subscriber_access rows for its product's entitlements." If it's named, e.g., `services/access/resolver.ts` with a function `replaceAccessForPurchase`, you will call it. If no such helper exists, write the inline logic that mirrors how the StoreKit / Play webhook handler does it.

- [ ] **Step 2: Write the service**

```ts
// apps/api/src/services/subscriptions/grant.ts
import { addMonths, addYears } from "date-fns";
import { HTTPException } from "hono/http-exception";
import { createId } from "@paralleldrive/cuid2";
import { eq } from "drizzle-orm";
import {
  drizzle,
  purchases,
  subscribers,
  products,
  outboxEvents,
} from "@rovenue/db";
import type { GrantSubscriptionRequest } from "@rovenue/shared";
import { audit } from "../../lib/audit";
import { replaceAccessForPurchase } from "../access/resolver"; // adjust path

const PRESET_OFFSETS = {
  "1mo": (now: Date) => addMonths(now, 1),
  "3mo": (now: Date) => addMonths(now, 3),
  "6mo": (now: Date) => addMonths(now, 6),
  "1yr": (now: Date) => addYears(now, 1),
} as const;

export type GrantParams = {
  projectId: string;
  actorUserId: string;
  input: GrantSubscriptionRequest;
};

export async function grantComp(params: GrantParams) {
  const { projectId, actorUserId, input } = params;
  const now = new Date();

  let expiresDate: Date | null;
  if (input.duration.kind === "preset") {
    if (input.duration.preset === "lifetime") {
      expiresDate = null;
    } else {
      expiresDate = PRESET_OFFSETS[input.duration.preset](now);
    }
  } else {
    const parsed = new Date(input.duration.expiresAt);
    if (!(parsed.getTime() > now.getTime())) {
      throw new HTTPException(400, {
        message: "expiresAt must be in the future",
      });
    }
    expiresDate = parsed;
  }

  return drizzle.db.transaction(async (tx) => {
    const [sub] = await tx
      .select()
      .from(subscribers)
      .where(eq(subscribers.id, input.subscriberId))
      .limit(1);
    if (!sub || sub.projectId !== projectId) {
      throw new HTTPException(404, { message: "subscriber not found" });
    }

    const [prod] = await tx
      .select()
      .from(products)
      .where(eq(products.id, input.productId))
      .limit(1);
    if (!prod || prod.projectId !== projectId) {
      throw new HTTPException(404, { message: "product not found" });
    }

    const synthId = `comp_${createId()}`;
    const [purchase] = await tx
      .insert(purchases)
      .values({
        projectId,
        subscriberId: sub.id,
        productId: prod.id,
        store: "MANUAL",
        storeTransactionId: synthId,
        originalTransactionId: synthId,
        status: "ACTIVE",
        isTrial: false,
        isIntroOffer: false,
        isSandbox: false,
        purchaseDate: now,
        originalPurchaseDate: now,
        expiresDate,
        priceAmount: "0",
        priceCurrency: "USD",
        environment: "PRODUCTION",
        autoRenewStatus: false,
      })
      .returning();

    await replaceAccessForPurchase(tx, purchase);

    await tx.insert(outboxEvents).values({
      aggregateId: purchase.id,
      aggregateType: "purchase",
      eventType: "revenue_event",
      payload: {
        type: "INITIAL",
        projectId,
        subscriberId: sub.id,
        purchaseId: purchase.id,
        productId: prod.id,
        store: "MANUAL",
        priceAmount: 0,
        priceCurrency: "USD",
        occurredAt: now.toISOString(),
      },
    });

    await audit(
      {
        projectId,
        actorUserId,
        action: "subscription.granted",
        resource: "purchase",
        resourceId: purchase.id,
        before: null,
        after: { store: "MANUAL", expiresDate, productId: prod.id },
        metadata: { note: input.note ?? null, duration: input.duration },
      },
      tx,
    );

    return purchase;
  });
}
```

**Note:** The exact column names on `outbox_events` (e.g. `aggregateId` vs `aggregate_id`, `eventType` vs `event_type`) and the exact `AuditEntry` field names (e.g. `actorUserId` vs `actorId`) must match the existing Drizzle schema. Open `packages/db/src/drizzle/schema.ts` and `apps/api/src/lib/audit.ts` once, then adjust the camelCase keys above to match exactly. Same for `replaceAccessForPurchase` — use whatever symbol the access resolver actually exports; if no helper exists, inline the logic that walks the product's entitlements and inserts into `subscriber_access`.

- [ ] **Step 3: Run the tests**

```bash
pnpm --filter @rovenue/api test grant.integration -- --run
```

Expected: PASS (all 4 cases).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/services/subscriptions/grant.ts
git commit -m "feat(api): grantComp service for manual subscriptions"
```

---

## Task 8: Add `POST /` route for grant + matching route test

**Files:**
- Modify: `apps/api/src/routes/dashboard/subscriptions.ts`
- Create: `apps/api/src/routes/dashboard/subscriptions.integration.test.ts` (if missing — otherwise extend)

- [ ] **Step 1: Write the route test**

Append to `subscriptions.integration.test.ts`:

```ts
describe("POST /v1/dashboard/projects/:projectId/subscriptions", () => {
  it("requires EDITOR role", async () => {
    const { app, project, viewerSession } = await setupRouteCtx({ role: "VIEWER" });
    const res = await app.request(
      `/v1/dashboard/projects/${project.id}/subscriptions`,
      {
        method: "POST",
        headers: { ...viewerSession.headers, "content-type": "application/json" },
        body: JSON.stringify({
          subscriberId: "x",
          productId: "y",
          duration: { kind: "preset", preset: "1mo" },
        }),
      },
    );
    expect(res.status).toBe(403);
  });

  it("creates a comp subscription", async () => {
    const { app, project, editorSession, sub, prod } = await setupRouteCtx({ role: "EDITOR", withSeed: true });
    const res = await app.request(
      `/v1/dashboard/projects/${project.id}/subscriptions`,
      {
        method: "POST",
        headers: { ...editorSession.headers, "content-type": "application/json" },
        body: JSON.stringify({
          subscriberId: sub.id,
          productId: prod.id,
          duration: { kind: "preset", preset: "1mo" },
        }),
      },
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.store).toBe("MANUAL");
  });
});
```

Match `setupRouteCtx` to whatever the existing dashboard tests use (look for the test helper that builds a Hono app with a mock session, like `apps/api/test/dashboard-app.ts`). If no such helper exists, build the simplest one possible inline.

- [ ] **Step 2: Run the test (expect failure)**

```bash
pnpm --filter @rovenue/api test subscriptions.integration -- --run
```

Expected: FAIL — route does not exist yet.

- [ ] **Step 3: Wire route**

In `apps/api/src/routes/dashboard/subscriptions.ts`, add at the top:

```ts
import { grantSubscriptionRequestSchema } from "@rovenue/shared";
import { grantComp } from "../../services/subscriptions/grant";
```

Add chained `.post(...)` on the `subscriptionsRoute` after the existing `.get("/")` block:

```ts
.post(
  "/",
  zValidator("json", grantSubscriptionRequestSchema),
  async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) throw new HTTPException(400, { message: "Missing projectId" });
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.EDITOR);

    const purchase = await grantComp({
      projectId,
      actorUserId: user.id,
      input: c.req.valid("json"),
    });
    return c.json(ok(purchase));
  },
)
```

- [ ] **Step 4: Run test, expect pass**

```bash
pnpm --filter @rovenue/api test subscriptions.integration -- --run
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/dashboard/subscriptions.ts apps/api/src/routes/dashboard/subscriptions.integration.test.ts
git commit -m "feat(api): POST /subscriptions endpoint for comp grants"
```

---

## Task 9: Schedule service — failing tests

**Files:**
- Create: `apps/api/src/services/subscriptions/schedule.integration.test.ts`

- [ ] **Step 1: Write tests**

```ts
import { describe, it, expect } from "vitest";
import {
  scheduleAction,
  listScheduledForProject,
  cancelScheduledAction,
} from "./schedule";
import { seedProject, seedManualPurchase } from "../../../test/seed";
import { withTestDb } from "../../../test/with-test-db";

describe("scheduleAction", () => {
  withTestDb();

  it("inserts a PENDING row", async () => {
    const project = await seedProject();
    const purchase = await seedManualPurchase({ projectId: project.id });
    const row = await scheduleAction({
      projectId: project.id,
      actorUserId: "u1",
      purchaseId: purchase.id,
      input: {
        action: "CANCEL",
        dueAt: new Date(Date.now() + 3600_000).toISOString(),
        revokeImmediately: false,
      },
    });
    expect(row.status).toBe("PENDING");
  });

  it("rejects dueAt in the past or within 60s skew window", async () => {
    const project = await seedProject();
    const purchase = await seedManualPurchase({ projectId: project.id });
    await expect(
      scheduleAction({
        projectId: project.id,
        actorUserId: "u1",
        purchaseId: purchase.id,
        input: {
          action: "CANCEL",
          dueAt: new Date(Date.now() + 30_000).toISOString(),
          revokeImmediately: false,
        },
      }),
    ).rejects.toThrow(/future/i);
  });

  it("rejects duplicate PENDING for same purchase", async () => {
    const project = await seedProject();
    const purchase = await seedManualPurchase({ projectId: project.id });
    const dueAt = new Date(Date.now() + 3600_000).toISOString();
    await scheduleAction({
      projectId: project.id,
      actorUserId: "u1",
      purchaseId: purchase.id,
      input: { action: "CANCEL", dueAt, revokeImmediately: false },
    });
    await expect(
      scheduleAction({
        projectId: project.id,
        actorUserId: "u1",
        purchaseId: purchase.id,
        input: { action: "CANCEL", dueAt, revokeImmediately: false },
      }),
    ).rejects.toThrow(/already/i);
  });

  it("rejects scheduling on a terminal-status purchase", async () => {
    const project = await seedProject();
    const purchase = await seedManualPurchase({
      projectId: project.id,
      status: "EXPIRED",
    });
    await expect(
      scheduleAction({
        projectId: project.id,
        actorUserId: "u1",
        purchaseId: purchase.id,
        input: {
          action: "CANCEL",
          dueAt: new Date(Date.now() + 3600_000).toISOString(),
          revokeImmediately: false,
        },
      }),
    ).rejects.toThrow(/terminal/i);
  });

  it("cancelScheduledAction marks PENDING → CANCELED", async () => {
    const project = await seedProject();
    const purchase = await seedManualPurchase({ projectId: project.id });
    const row = await scheduleAction({
      projectId: project.id,
      actorUserId: "u1",
      purchaseId: purchase.id,
      input: {
        action: "CANCEL",
        dueAt: new Date(Date.now() + 3600_000).toISOString(),
        revokeImmediately: false,
      },
    });
    const cancelled = await cancelScheduledAction({
      projectId: project.id,
      actorUserId: "u1",
      id: row.id,
    });
    expect(cancelled.status).toBe("CANCELED");
  });
});
```

`seedManualPurchase` likely doesn't exist yet — add it to the test seed module using `grantComp` or a direct insert.

- [ ] **Step 2: Run, expect FAIL**

```bash
pnpm --filter @rovenue/api test schedule.integration -- --run
```

Expected: FAIL (module missing).

- [ ] **Step 3: Commit failing tests**

```bash
git add apps/api/src/services/subscriptions/schedule.integration.test.ts apps/api/src/test/seed.ts
git commit -m "test(api): failing tests for schedule service"
```

---

## Task 10: Implement schedule service

**Files:**
- Create: `apps/api/src/services/subscriptions/schedule.ts`

- [ ] **Step 1: Write the file**

```ts
import { HTTPException } from "hono/http-exception";
import { eq } from "drizzle-orm";
import {
  drizzle,
  purchases,
  scheduledActionsRepo,
  type ScheduledActionRow,
} from "@rovenue/db";
import type { ScheduleActionRequest } from "@rovenue/shared";
import { audit } from "../../lib/audit";

const TERMINAL_STATUSES = new Set(["EXPIRED", "REFUNDED", "REVOKED"]);
const MIN_LEAD_MS = 60_000;

export type ScheduleParams = {
  projectId: string;
  actorUserId: string;
  purchaseId: string;
  input: ScheduleActionRequest;
};

export async function scheduleAction(
  params: ScheduleParams,
): Promise<ScheduledActionRow> {
  const { projectId, actorUserId, purchaseId, input } = params;
  const dueAt = new Date(input.dueAt);
  if (dueAt.getTime() <= Date.now() + MIN_LEAD_MS) {
    throw new HTTPException(400, {
      message: "dueAt must be at least 60s in the future",
    });
  }

  return drizzle.db.transaction(async (tx) => {
    const [purchase] = await tx
      .select()
      .from(purchases)
      .where(eq(purchases.id, purchaseId))
      .limit(1);
    if (!purchase || purchase.projectId !== projectId) {
      throw new HTTPException(404, { message: "purchase not found" });
    }
    if (TERMINAL_STATUSES.has(purchase.status)) {
      throw new HTTPException(409, {
        message: "purchase is in terminal status",
      });
    }
    const existing = await scheduledActionsRepo.findPendingForPurchase(
      purchaseId,
    );
    if (existing) {
      throw new HTTPException(409, {
        message: "purchase already has a pending scheduled action",
      });
    }

    const row = await scheduledActionsRepo.insertScheduledAction(
      {
        projectId,
        purchaseId,
        subscriberId: purchase.subscriberId,
        action: input.action,
        dueAt,
        payload: { revokeImmediately: input.revokeImmediately },
        createdBy: actorUserId,
      },
      tx,
    );

    await audit(
      {
        projectId,
        actorUserId,
        action: "subscription.cancel_scheduled",
        resource: "purchase",
        resourceId: purchaseId,
        before: null,
        after: { scheduledActionId: row.id, dueAt: dueAt.toISOString() },
        metadata: { revokeImmediately: input.revokeImmediately ?? false },
      },
      tx,
    );

    return row;
  });
}

export async function listScheduledForProject(
  projectId: string,
  limit: number,
): Promise<ScheduledActionRow[]> {
  return scheduledActionsRepo.listForProject(projectId, limit);
}

export async function cancelScheduledAction(params: {
  projectId: string;
  actorUserId: string;
  id: string;
}): Promise<ScheduledActionRow> {
  const { projectId, actorUserId, id } = params;
  const row = await scheduledActionsRepo.cancelPending(id, projectId);
  if (!row) {
    throw new HTTPException(409, {
      message: "scheduled action not pending or not found",
    });
  }
  await audit({
    projectId,
    actorUserId,
    action: "subscription.schedule_canceled",
    resource: "purchase",
    resourceId: row.purchaseId,
    before: { status: "PENDING" },
    after: { status: "CANCELED" },
    metadata: { scheduledActionId: row.id },
  });
  return row;
}
```

- [ ] **Step 2: Run tests, expect PASS**

```bash
pnpm --filter @rovenue/api test schedule.integration -- --run
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/services/subscriptions/schedule.ts
git commit -m "feat(api): scheduleAction service + list/cancel"
```

---

## Task 11: Wire schedule HTTP endpoints + route tests

**Files:**
- Modify: `apps/api/src/routes/dashboard/subscriptions.ts`
- Modify: `apps/api/src/routes/dashboard/subscriptions.integration.test.ts`

- [ ] **Step 1: Add tests** for `POST /:purchaseId/schedule`, `GET /scheduled`, `DELETE /scheduled/:id` covering happy-path + RBAC (`VIEWER → 403` on POST/DELETE, `VIEWER → 200` on GET).

- [ ] **Step 2: Run tests, expect FAIL.**

- [ ] **Step 3: Add routes**

```ts
import {
  scheduleAction,
  listScheduledForProject,
  cancelScheduledAction,
} from "../../services/subscriptions/schedule";
import { scheduleActionRequestSchema } from "@rovenue/shared";

// …append chained methods after the grant POST
.post(
  "/:purchaseId/schedule",
  zValidator("json", scheduleActionRequestSchema),
  async (c) => {
    const projectId = c.req.param("projectId");
    const purchaseId = c.req.param("purchaseId");
    if (!projectId || !purchaseId) {
      throw new HTTPException(400, { message: "Missing projectId/purchaseId" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.EDITOR);
    const row = await scheduleAction({
      projectId,
      actorUserId: user.id,
      purchaseId,
      input: c.req.valid("json"),
    });
    return c.json(ok(row));
  },
)
.get("/scheduled", async (c) => {
  const projectId = c.req.param("projectId");
  if (!projectId) throw new HTTPException(400, { message: "Missing projectId" });
  const user = c.get("user");
  await assertProjectAccess(projectId, user.id, MemberRole.VIEWER);
  const rows = await listScheduledForProject(projectId, 100);
  return c.json(ok({ rows }));
})
.delete("/scheduled/:id", async (c) => {
  const projectId = c.req.param("projectId");
  const id = c.req.param("id");
  if (!projectId || !id) throw new HTTPException(400, { message: "Missing param" });
  const user = c.get("user");
  await assertProjectAccess(projectId, user.id, MemberRole.EDITOR);
  const row = await cancelScheduledAction({
    projectId,
    actorUserId: user.id,
    id,
  });
  return c.json(ok(row));
})
```

- [ ] **Step 4: Run tests, expect PASS.**

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/dashboard/subscriptions.ts apps/api/src/routes/dashboard/subscriptions.integration.test.ts
git commit -m "feat(api): schedule cancel endpoints + list/delete"
```

---

## Task 12: Scheduled-actions worker — failing test

**Files:**
- Create: `apps/api/src/workers/scheduled-actions.integration.test.ts`

- [ ] **Step 1: Write test**

```ts
import { describe, it, expect } from "vitest";
import { runScheduledActionsSweep } from "./scheduled-actions";
import { drizzle, purchases, subscriberAccess } from "@rovenue/db";
import { eq } from "drizzle-orm";
import {
  seedProject,
  seedManualPurchase,
  insertPendingAction,
} from "../../test/seed";
import { withTestDb } from "../../test/with-test-db";

describe("runScheduledActionsSweep", () => {
  withTestDb();

  it("MANUAL + revokeImmediately: sets EXPIRED + deactivates access", async () => {
    const project = await seedProject();
    const purchase = await seedManualPurchase({
      projectId: project.id,
      expiresDate: new Date(Date.now() + 30 * 86400_000),
    });
    await insertPendingAction({
      projectId: project.id,
      purchaseId: purchase.id,
      subscriberId: purchase.subscriberId,
      dueAt: new Date(Date.now() - 1000),
      revokeImmediately: true,
    });

    const result = await runScheduledActionsSweep();
    expect(result.executed).toBe(1);

    const [after] = await drizzle.db
      .select()
      .from(purchases)
      .where(eq(purchases.id, purchase.id));
    expect(after.status).toBe("EXPIRED");

    const access = await drizzle.db
      .select()
      .from(subscriberAccess)
      .where(eq(subscriberAccess.purchaseId, purchase.id));
    expect(access.every((a) => a.isActive === false)).toBe(true);
  });

  it("MANUAL + !revokeImmediately: keeps expiresDate, flips autoRenew", async () => {
    const project = await seedProject();
    const future = new Date(Date.now() + 30 * 86400_000);
    const purchase = await seedManualPurchase({
      projectId: project.id,
      expiresDate: future,
    });
    await insertPendingAction({
      projectId: project.id,
      purchaseId: purchase.id,
      subscriberId: purchase.subscriberId,
      dueAt: new Date(Date.now() - 1000),
      revokeImmediately: false,
    });

    await runScheduledActionsSweep();
    const [after] = await drizzle.db
      .select()
      .from(purchases)
      .where(eq(purchases.id, purchase.id));
    expect(after.status).toBe("ACTIVE");
    expect(after.autoRenewStatus).toBe(false);
    expect(after.expiresDate?.getTime()).toBe(future.getTime());
  });

  it("ignores rows whose dueAt is still in the future", async () => {
    const project = await seedProject();
    const purchase = await seedManualPurchase({ projectId: project.id });
    await insertPendingAction({
      projectId: project.id,
      purchaseId: purchase.id,
      subscriberId: purchase.subscriberId,
      dueAt: new Date(Date.now() + 3600_000),
      revokeImmediately: true,
    });
    const result = await runScheduledActionsSweep();
    expect(result.executed).toBe(0);
  });
});
```

- [ ] **Step 2: Run, expect FAIL.**

```bash
pnpm --filter @rovenue/api test scheduled-actions.integration -- --run
```

- [ ] **Step 3: Commit failing tests + helpers.**

```bash
git add apps/api/src/workers/scheduled-actions.integration.test.ts apps/api/src/test/seed.ts
git commit -m "test(api): failing scheduled-actions sweep tests"
```

---

## Task 13: Implement scheduled-actions worker

**Files:**
- Create: `apps/api/src/workers/scheduled-actions.ts`

- [ ] **Step 1: Read `apps/api/src/workers/expiry-checker.ts` end-to-end** to copy the BullMQ + repeatable + Worker shape exactly. The new worker MUST follow the same conventions (queue name constant, repeatable job constant, `getXxxQueue()` + `getXxxWorker()` cached instances, logger child, env-driven Redis connection).

- [ ] **Step 2: Write the worker**

```ts
// apps/api/src/workers/scheduled-actions.ts
import { Queue, Worker } from "bullmq";
import { eq, inArray, and } from "drizzle-orm";
import {
  drizzle,
  purchases,
  subscriberAccess,
  scheduledSubscriptionActions,
  scheduledActionsRepo,
  outgoingWebhooks,
  outboxEvents,
} from "@rovenue/db";
import { redisConnection } from "../lib/redis"; // adjust to actual export
import { logger } from "../lib/logger";
import { audit } from "../lib/audit";

const log = logger.child("scheduled-actions");

export const SCHEDULED_ACTIONS_QUEUE_NAME = "rovenue-scheduled-actions";
const REPEATABLE_JOB_NAME = "scheduled-actions:sweep";
const REPEATABLE_JOB_ID = "scheduled-actions-repeatable";
const BATCH_SIZE = 200;

let cachedQueue: Queue | null = null;
let cachedWorker: Worker | null = null;

export function getScheduledActionsQueue(): Queue {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue(SCHEDULED_ACTIONS_QUEUE_NAME, {
    connection: redisConnection,
  });
  return cachedQueue;
}

export async function ensureRepeatable(): Promise<void> {
  const queue = getScheduledActionsQueue();
  await queue.upsertJobScheduler(
    REPEATABLE_JOB_ID,
    { pattern: "*/1 * * * *" }, // every minute
    { name: REPEATABLE_JOB_NAME, data: {} },
  );
}

export function getScheduledActionsWorker(): Worker {
  if (cachedWorker) return cachedWorker;
  cachedWorker = new Worker(
    SCHEDULED_ACTIONS_QUEUE_NAME,
    async () => {
      const out = await runScheduledActionsSweep();
      log.info("scheduled actions sweep complete", out);
      return out;
    },
    { connection: redisConnection },
  );
  return cachedWorker;
}

export type SweepResult = { executed: number; failed: number };

export async function runScheduledActionsSweep(): Promise<SweepResult> {
  let executed = 0;
  let failed = 0;

  // One tx per claim batch so SKIP LOCKED holds for the duration.
  await drizzle.db.transaction(async (tx) => {
    const batch = await scheduledActionsRepo.claimDueBatch(tx, BATCH_SIZE);
    for (const row of batch) {
      try {
        await executeAction(tx, row);
        await scheduledActionsRepo.markExecuted(row.id, tx);
        executed += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await scheduledActionsRepo.markFailed(row.id, message, tx);
        log.error("scheduled action failed", { id: row.id, error: message });
        failed += 1;
      }
    }
  });

  return { executed, failed };
}

async function executeAction(
  tx: Parameters<typeof scheduledActionsRepo.claimDueBatch>[0],
  row: Awaited<ReturnType<typeof scheduledActionsRepo.claimDueBatch>>[number],
): Promise<void> {
  const [purchase] = await tx
    .select()
    .from(purchases)
    .where(eq(purchases.id, row.purchaseId))
    .limit(1);
  if (!purchase) {
    throw new Error(`purchase ${row.purchaseId} not found`);
  }

  const now = new Date();
  const revokeNow = row.payload.revokeImmediately === true;

  switch (purchase.store) {
    case "MANUAL": {
      if (revokeNow) {
        await tx
          .update(purchases)
          .set({
            status: "EXPIRED",
            expiresDate: now,
            autoRenewStatus: false,
            cancellationDate: now,
            updatedAt: now,
          })
          .where(eq(purchases.id, purchase.id));
        await tx
          .update(subscriberAccess)
          .set({ isActive: false, updatedAt: now })
          .where(eq(subscriberAccess.purchaseId, purchase.id));
        await tx.insert(outboxEvents).values({
          aggregateId: purchase.id,
          aggregateType: "purchase",
          eventType: "revenue_event",
          payload: {
            type: "CANCELLATION",
            projectId: purchase.projectId,
            subscriberId: purchase.subscriberId,
            purchaseId: purchase.id,
            store: "MANUAL",
            occurredAt: now.toISOString(),
          },
        });
      } else {
        await tx
          .update(purchases)
          .set({
            autoRenewStatus: false,
            cancellationDate: now,
            updatedAt: now,
          })
          .where(eq(purchases.id, purchase.id));
      }
      break;
    }
    case "STRIPE": {
      // Local marker; the real cancel-at-period-end call goes to Stripe.
      // The Stripe SDK lives somewhere like apps/api/src/services/stripe/client.ts
      // — adjust the import after grepping the codebase.
      const { stripe } = await import("../services/stripe/client");
      await stripe.subscriptions.update(purchase.originalTransactionId, {
        cancel_at_period_end: true,
      });
      await tx
        .update(purchases)
        .set({
          autoRenewStatus: false,
          cancellationDate: now,
          updatedAt: now,
        })
        .where(eq(purchases.id, purchase.id));
      break;
    }
    case "APP_STORE":
    case "PLAY_STORE": {
      await tx
        .update(purchases)
        .set({ cancellationDate: now, updatedAt: now })
        .where(eq(purchases.id, purchase.id));
      await tx.insert(outgoingWebhooks).values({
        projectId: purchase.projectId,
        eventType: "subscription.cancel_requested",
        payload: {
          purchaseId: purchase.id,
          subscriberId: purchase.subscriberId,
          store: purchase.store,
          requestedAt: now.toISOString(),
        },
        status: "PENDING",
      });
      break;
    }
  }

  await audit(
    {
      projectId: purchase.projectId,
      actorUserId: row.createdBy,
      action: "subscription.cancel_executed",
      resource: "purchase",
      resourceId: purchase.id,
      before: null,
      after: { revokeImmediately: revokeNow, store: purchase.store },
      metadata: { scheduledActionId: row.id },
    },
    tx,
  );
}
```

**Adjust to reality:** `redisConnection`, `logger`, `outgoingWebhooks` insert shape, Stripe client export name, and audit-entry field names all need to match what the codebase actually exports. Grep + match — do not invent.

- [ ] **Step 3: Run tests, expect PASS**

```bash
pnpm --filter @rovenue/api test scheduled-actions.integration -- --run
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/workers/scheduled-actions.ts
git commit -m "feat(api): scheduled-actions worker (cancel sweep)"
```

---

## Task 14: Register the worker on API boot

**Files:**
- Modify: `apps/api/src/index.ts`

- [ ] **Step 1: Read** the existing boot-time worker registration block (search for `expiry-checker` initialisation; the new one slots in beside it).

- [ ] **Step 2: Add**

```ts
import {
  ensureRepeatable as ensureScheduledActionsRepeatable,
  getScheduledActionsWorker,
} from "./workers/scheduled-actions";

// Inside the existing boot sequence, next to the expiry-checker init:
await ensureScheduledActionsRepeatable();
getScheduledActionsWorker();
```

Also add to the graceful shutdown block (mirror what the expiry-checker worker does).

- [ ] **Step 3: Boot the API locally**

```bash
pnpm --filter @rovenue/api dev
```

Expected: logs include `scheduled-actions` worker started; no errors. Stop with Ctrl-C.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/index.ts
git commit -m "feat(api): register scheduled-actions worker on boot"
```

---

## Task 15: CSV export service — tests first

**Files:**
- Create: `apps/api/src/services/subscriptions/export-csv.test.ts`

- [ ] **Step 1: Write unit tests**

```ts
import { describe, it, expect } from "vitest";
import { csvEscape, formatHeader, formatRow } from "./export-csv";
import type { SubscriptionRow } from "@rovenue/shared";

describe("csvEscape", () => {
  it("wraps and doubles quotes when needed", () => {
    expect(csvEscape("hello")).toBe("hello");
    expect(csvEscape('a,b')).toBe('"a,b"');
    expect(csvEscape('a"b')).toBe('"a""b"');
    expect(csvEscape("line1\nline2")).toBe('"line1\nline2"');
    expect(csvEscape(null)).toBe("");
  });
});

describe("formatHeader", () => {
  it("emits a single trailing newline", () => {
    expect(formatHeader().endsWith("\n")).toBe(true);
    expect(formatHeader().split("\n")).toHaveLength(2);
  });
});

describe("formatRow", () => {
  it("renders the full column set in declared order", () => {
    const row = makeRow();
    const out = formatRow(row);
    expect(out.endsWith("\n")).toBe(true);
    expect(out.startsWith(`${row.id},${row.subscriberId},`)).toBe(true);
  });
});

function makeRow(): SubscriptionRow {
  return {
    id: "p_1",
    subscriberId: "s_1",
    productId: "prod_1",
    productIdentifier: "pro_monthly",
    productName: "Pro Monthly",
    store: "STRIPE",
    status: "active",
    priceAmount: "9.99",
    priceCurrency: "USD",
    purchaseDate: "2026-01-01T00:00:00.000Z",
    expiresDate: "2026-02-01T00:00:00.000Z",
    autoRenew: true,
    isTrial: false,
    isIntroOffer: false,
    cancellationDate: null,
    gracePeriodExpires: null,
    hasIssue: false,
  } as unknown as SubscriptionRow;
}
```

- [ ] **Step 2: Run, expect FAIL.**

```bash
pnpm --filter @rovenue/api test export-csv -- --run
```

- [ ] **Step 3: Commit failing tests.**

```bash
git add apps/api/src/services/subscriptions/export-csv.test.ts
git commit -m "test(api): failing tests for CSV export formatting"
```

---

## Task 16: Implement CSV export service

**Files:**
- Create: `apps/api/src/services/subscriptions/export-csv.ts`

- [ ] **Step 1: Write the file**

```ts
import type { SubscriptionRow } from "@rovenue/shared";
import {
  listSubscriptions,
  decodeSubsCursor,
  __subscriptionsConstants,
} from "../metrics/subscriptions";

const COLUMNS = [
  "id",
  "subscriber_id",
  "product",
  "status",
  "store",
  "price_amount",
  "price_currency",
  "purchase_date",
  "expires_date",
  "auto_renew",
  "is_trial",
  "cancellation_date",
] as const;

const PAGE = 1000;
const HARD_CAP = 1_000_000;

export function csvEscape(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

export function formatHeader(): string {
  return `${COLUMNS.join(",")}\n`;
}

export function formatRow(r: SubscriptionRow): string {
  const cells = [
    r.id,
    r.subscriberId,
    r.productName ?? r.productIdentifier ?? r.productId,
    r.status,
    r.store,
    r.priceAmount ?? "",
    r.priceCurrency ?? "",
    r.purchaseDate,
    r.expiresDate ?? "",
    r.autoRenew ?? false,
    r.isTrial,
    r.cancellationDate ?? "",
  ].map(csvEscape);
  return `${cells.join(",")}\n`;
}

export type ExportParams = {
  projectId: string;
  scope: Parameters<typeof listSubscriptions>[0]["scope"];
  search: string | null;
};

export async function* streamSubscriptionsCsv(
  params: ExportParams,
): AsyncGenerator<string, { rowCount: number; truncated: boolean }, void> {
  yield formatHeader();
  let cursor: ReturnType<typeof decodeSubsCursor> | null = null;
  let rowCount = 0;
  let truncated = false;

  while (true) {
    const page = await listSubscriptions({
      projectId: params.projectId,
      scope: params.scope,
      limit: PAGE,
      cursor,
      search: params.search,
    });
    for (const row of page.rows) {
      yield formatRow(row);
      rowCount += 1;
      if (rowCount >= HARD_CAP) {
        yield `# truncated at ${HARD_CAP} rows\n`;
        truncated = true;
        return { rowCount, truncated };
      }
    }
    if (!page.nextCursor) break;
    cursor = decodeSubsCursor(page.nextCursor);
    if (!cursor) break;
  }

  return { rowCount, truncated };
}
```

- [ ] **Step 2: Run tests, expect PASS.**

```bash
pnpm --filter @rovenue/api test export-csv -- --run
```

- [ ] **Step 3: Commit.**

```bash
git add apps/api/src/services/subscriptions/export-csv.ts
git commit -m "feat(api): CSV export service with streaming generator"
```

---

## Task 17: Wire `GET /export.csv` route

**Files:**
- Modify: `apps/api/src/routes/dashboard/subscriptions.ts`

- [ ] **Step 1: Add a route test** that asserts the response has `Content-Type: text/csv`, the body starts with the header row, and the audit row is written.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Add the route**

```ts
import { streamSubscriptionsCsv } from "../../services/subscriptions/export-csv";

const exportQuerySchema = z.object({
  scope: z.enum(subscriptionScopes).default("all"),
  search: z.string().trim().min(1).optional(),
});

// inside subscriptionsRoute chain:
.get("/export.csv", zValidator("query", exportQuerySchema), async (c) => {
  const projectId = c.req.param("projectId");
  if (!projectId) throw new HTTPException(400, { message: "Missing projectId" });
  const user = c.get("user");
  await assertProjectAccess(projectId, user.id, MemberRole.VIEWER);

  const { scope, search } = c.req.valid("query");
  const generator = streamSubscriptionsCsv({
    projectId,
    scope,
    search: search ?? null,
  });

  const filename = `subscriptions-${projectId}-${new Date()
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, "")}.csv`;

  c.header("Content-Type", "text/csv; charset=utf-8");
  c.header("Content-Disposition", `attachment; filename="${filename}"`);

  return c.body(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        const enc = new TextEncoder();
        let summary: { rowCount: number; truncated: boolean } = {
          rowCount: 0,
          truncated: false,
        };
        try {
          for await (const chunk of generator) {
            controller.enqueue(enc.encode(chunk));
          }
          // Generator return value lives in the final iterator result;
          // grab it via a tiny helper below.
          summary = (await collectReturn(generator)) ?? summary;
        } finally {
          controller.close();
          await audit({
            projectId,
            actorUserId: user.id,
            action: "subscriptions.exported",
            resource: "project",
            resourceId: projectId,
            before: null,
            after: null,
            metadata: {
              scope,
              search: search ?? null,
              rowCount: summary.rowCount,
              truncated: summary.truncated,
            },
          });
        }
      },
    }),
  );
})
```

Add the small helper at the bottom of the route file:

```ts
async function collectReturn<T>(
  gen: AsyncGenerator<unknown, T, void>,
): Promise<T | null> {
  // The generator is fully consumed by the for-await loop above; the
  // next call returns { value: <return>, done: true }.
  const result = await gen.next();
  return result.done ? (result.value as T) : null;
}
```

- [ ] **Step 4: Run tests, expect PASS.**

- [ ] **Step 5: Commit.**

```bash
git add apps/api/src/routes/dashboard/subscriptions.ts apps/api/src/routes/dashboard/subscriptions.integration.test.ts
git commit -m "feat(api): GET /subscriptions/export.csv streaming endpoint"
```

---

## Task 18: Add MANUAL switch-case to existing store-aware code paths

- [ ] **Step 1: Re-run the pre-flight grep.**

```bash
grep -rn -E '"(APP_STORE|PLAY_STORE|STRIPE)"' apps/api/src packages/db/src 2>/dev/null
```

- [ ] **Step 2: Run typecheck** to see which files now break.

```bash
pnpm typecheck
```

- [ ] **Step 3: For each TS exhaustiveness error**, add an explicit `case "MANUAL":` arm. For most lifecycle / reconcile / receipt-verify paths the right behavior is "do nothing" (manual subs are not store-backed), so a `return` or `break` with a one-line comment is fine. Do NOT silently fall through to a store-specific branch.

- [ ] **Step 4: Confirm `workers/expiry-checker.ts` tolerates `MANUAL`** (it should — it sweeps purely on `expiresDate`). If it filters by store, add `MANUAL` to the allow-list.

- [ ] **Step 5: Run all tests.**

```bash
pnpm test
```

- [ ] **Step 6: Commit.**

```bash
git add -A
git commit -m "chore(api): handle MANUAL store in existing store-switches"
```

---

## Task 19: Dashboard — hooks

**Files:**
- Modify: `apps/dashboard/src/lib/hooks/useProjectSubscriptions.ts`

- [ ] **Step 1: Read the existing file** to match its conventions (it already uses React Query). Mirror `useProjectSubscriptionsKpis` style for queries and find one mutation hook elsewhere (e.g., `useProjectProducts.ts`) to copy mutation style.

- [ ] **Step 2: Add**

```ts
import type {
  GrantSubscriptionRequest,
  ScheduleActionRequest,
  ListScheduledActionsResponse,
  ScheduledActionRow,
} from "@rovenue/shared";

export function useGrantSubscription(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (body: GrantSubscriptionRequest) => {
      const res = await api.post(
        `/v1/dashboard/projects/${projectId}/subscriptions`,
        body,
      );
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["projectSubscriptions", projectId],
      });
      queryClient.invalidateQueries({
        queryKey: ["projectSubscriptionsKpis", projectId],
      });
      queryClient.invalidateQueries({
        queryKey: ["projectSubscriptionsComposition", projectId],
      });
    },
  });
}

export function useScheduleAction(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      purchaseId: string;
      body: ScheduleActionRequest;
    }) => {
      const res = await api.post(
        `/v1/dashboard/projects/${projectId}/subscriptions/${vars.purchaseId}/schedule`,
        vars.body,
      );
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["projectScheduledActions", projectId],
      });
    },
  });
}

export function useScheduledActions(projectId: string) {
  return useQuery({
    queryKey: ["projectScheduledActions", projectId],
    queryFn: async (): Promise<ListScheduledActionsResponse> => {
      const res = await api.get(
        `/v1/dashboard/projects/${projectId}/subscriptions/scheduled`,
      );
      return res.data;
    },
  });
}

export function useDeleteScheduledAction(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string): Promise<ScheduledActionRow> => {
      const res = await api.delete(
        `/v1/dashboard/projects/${projectId}/subscriptions/scheduled/${id}`,
      );
      return res.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["projectScheduledActions", projectId],
      });
    },
  });
}

export function buildExportSubscriptionsUrl(
  projectId: string,
  scope: string,
  search: string,
): string {
  const params = new URLSearchParams({ scope });
  const trimmed = search.trim();
  if (trimmed) params.set("search", trimmed);
  return `/v1/dashboard/projects/${projectId}/subscriptions/export.csv?${params.toString()}`;
}
```

Replace `api.post / api.get / api.delete` with whatever HTTP wrapper the file already uses (probably a fetch-based helper — match exactly).

- [ ] **Step 3: Build dashboard typecheck**

```bash
pnpm --filter @rovenue/dashboard typecheck
```

Expected: exits 0.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/lib/hooks/useProjectSubscriptions.ts
git commit -m "feat(dashboard): hooks for grant/schedule/export subscriptions"
```

---

## Task 20: Grant modal

**Files:**
- Create: `apps/dashboard/src/components/subscriptions/grant-modal.tsx`

- [ ] **Step 1: Read** an existing modal in the codebase (e.g. `apps/dashboard/src/components/products/product-form-modal.tsx`) to copy structure, dialog primitive imports, and validation pattern.

- [ ] **Step 2: Write the modal**

```tsx
import { useState, useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/button";
import { Modal } from "../../ui/modal"; // adjust to actual primitive
import { useGrantSubscription } from "../../lib/hooks/useProjectSubscriptions";
import { useProjectProducts } from "../../lib/hooks/useProjectProducts";
import { useProjectSubscribers } from "../../lib/hooks/useProjectSubscribers";
import type { GrantSubscriptionRequest } from "@rovenue/shared";

type Props = {
  projectId: string;
  open: boolean;
  onClose: () => void;
};

const PRESETS = ["1mo", "3mo", "6mo", "1yr", "lifetime", "custom"] as const;
type Preset = typeof PRESETS[number];

export function GrantSubscriptionModal({ projectId, open, onClose }: Props) {
  const { t } = useTranslation();
  const [subscriberId, setSubscriberId] = useState("");
  const [subscriberSearch, setSubscriberSearch] = useState("");
  const [productId, setProductId] = useState("");
  const [preset, setPreset] = useState<Preset>("1mo");
  const [customDate, setCustomDate] = useState("");
  const [note, setNote] = useState("");

  const subscribers = useProjectSubscribers({ projectId, search: subscriberSearch });
  const products = useProjectProducts(projectId);
  const grant = useGrantSubscription(projectId);

  const duration = useMemo((): GrantSubscriptionRequest["duration"] => {
    if (preset === "custom") {
      return { kind: "custom", expiresAt: new Date(customDate).toISOString() };
    }
    return { kind: "preset", preset };
  }, [preset, customDate]);

  const canSubmit =
    subscriberId &&
    productId &&
    (preset !== "custom" || (customDate && new Date(customDate) > new Date()));

  return (
    <Modal open={open} onClose={onClose} title={t("subscriptions.grant.title", { defaultValue: "Grant subscription" })}>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          grant.mutate(
            { subscriberId, productId, duration, note: note || undefined },
            { onSuccess: onClose },
          );
        }}
      >
        <label className="flex flex-col gap-1">
          <span className="text-sm">{t("subscriptions.grant.subscriber", { defaultValue: "Subscriber" })}</span>
          <input
            type="text"
            value={subscriberSearch}
            onChange={(e) => setSubscriberSearch(e.target.value)}
            placeholder={t("subscriptions.grant.searchSubscriber", { defaultValue: "Search by id or alias" })}
            className="input"
          />
          <select value={subscriberId} onChange={(e) => setSubscriberId(e.target.value)} className="input">
            <option value="">—</option>
            {(subscribers.data?.rows ?? []).map((s) => (
              <option key={s.id} value={s.id}>{s.id}</option>
            ))}
          </select>
        </label>

        <label className="flex flex-col gap-1">
          <span className="text-sm">{t("subscriptions.grant.product", { defaultValue: "Product" })}</span>
          <select value={productId} onChange={(e) => setProductId(e.target.value)} className="input">
            <option value="">—</option>
            {(products.data ?? []).map((p) => (
              <option key={p.id} value={p.id}>{p.name ?? p.identifier}</option>
            ))}
          </select>
        </label>

        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm">{t("subscriptions.grant.duration", { defaultValue: "Duration" })}</legend>
          <div className="flex flex-wrap gap-1">
            {PRESETS.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setPreset(p)}
                className={preset === p ? "btn btn-primary" : "btn"}
              >
                {p}
              </button>
            ))}
          </div>
          {preset === "custom" ? (
            <input
              type="date"
              value={customDate}
              min={new Date(Date.now() + 86400_000).toISOString().slice(0, 10)}
              onChange={(e) => setCustomDate(e.target.value)}
              className="input mt-2"
            />
          ) : null}
        </fieldset>

        <label className="flex flex-col gap-1">
          <span className="text-sm">{t("subscriptions.grant.note", { defaultValue: "Note (optional)" })}</span>
          <textarea
            value={note}
            maxLength={200}
            onChange={(e) => setNote(e.target.value)}
            className="input"
          />
          <span className="text-xs text-rv-mute-500">{note.length}/200</span>
        </label>

        {grant.isError ? (
          <div className="text-rv-danger text-sm">{(grant.error as Error).message}</div>
        ) : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="flat" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="solid-primary" disabled={!canSubmit || grant.isPending}>
            {grant.isPending ? t("common.saving") : t("subscriptions.grant.submit", { defaultValue: "Grant" })}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
```

The `Modal`, `input`, `btn`, etc. primitives must match the actual exports in `apps/dashboard/src/ui/`. Replace `useProjectSubscribers` import with whatever hook exists; if no subscriber search hook exists, write the simplest one in the same file.

- [ ] **Step 3: Add export to barrel.**

Edit `apps/dashboard/src/components/subscriptions/index.ts`:

```ts
export { GrantSubscriptionModal } from "./grant-modal";
```

- [ ] **Step 4: Commit.**

```bash
git add apps/dashboard/src/components/subscriptions/grant-modal.tsx apps/dashboard/src/components/subscriptions/index.ts
git commit -m "feat(dashboard): grant subscription modal"
```

---

## Task 21: Schedule modal

**Files:**
- Create: `apps/dashboard/src/components/subscriptions/schedule-modal.tsx`
- Modify: `apps/dashboard/src/components/subscriptions/index.ts`

- [ ] **Step 1: Write the modal**

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/button";
import { Modal } from "../../ui/modal";
import { useScheduleAction } from "../../lib/hooks/useProjectSubscriptions";
import type { Subscription } from "./types";

type Props = {
  projectId: string;
  open: boolean;
  selected: ReadonlyArray<Subscription>;
  onClose: () => void;
};

export function ScheduleCancelModal({ projectId, open, selected, onClose }: Props) {
  const { t } = useTranslation();
  const [date, setDate] = useState("");
  const [revokeImmediately, setRevokeImmediately] = useState(false);
  const schedule = useScheduleAction(projectId);

  const anyManual = selected.some((s) => (s as Subscription & { store: string }).store === "manual");

  const canSubmit = !!date && new Date(date).getTime() > Date.now() + 60_000;

  const submit = async () => {
    const dueAt = new Date(date).toISOString();
    const results = await Promise.allSettled(
      selected.map((s) =>
        schedule.mutateAsync({
          purchaseId: s.id,
          body: { action: "CANCEL", dueAt, revokeImmediately: anyManual ? revokeImmediately : false },
        }),
      ),
    );
    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length === 0) onClose();
    else alert(`${failures.length} of ${results.length} failed`);
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={t("subscriptions.schedule.title", {
        defaultValue: `Schedule cancel (${selected.length})`,
        count: selected.length,
      })}
    >
      <div className="flex flex-col gap-4">
        <label className="flex flex-col gap-1">
          <span className="text-sm">{t("subscriptions.schedule.dueAt", { defaultValue: "When" })}</span>
          <input
            type="datetime-local"
            value={date}
            min={new Date(Date.now() + 60_000).toISOString().slice(0, 16)}
            onChange={(e) => setDate(e.target.value)}
            className="input"
          />
        </label>

        {anyManual ? (
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={revokeImmediately}
              onChange={(e) => setRevokeImmediately(e.target.checked)}
            />
            <span className="text-sm">
              {t("subscriptions.schedule.revokeImmediately", { defaultValue: "Revoke access immediately on cancel" })}
            </span>
          </label>
        ) : null}

        <div className="text-xs text-rv-mute-500">
          {t("subscriptions.schedule.storeNote", {
            defaultValue:
              "App Store and Play Store cancellations are requested via webhook; the final state will sync from the store.",
          })}
        </div>

        <div className="flex justify-end gap-2">
          <Button type="button" variant="flat" onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            type="button"
            variant="solid-primary"
            disabled={!canSubmit || schedule.isPending}
            onClick={submit}
          >
            {t("subscriptions.schedule.submit", { defaultValue: "Schedule cancel" })}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
```

- [ ] **Step 2: Add to barrel.**

```ts
export { ScheduleCancelModal } from "./schedule-modal";
```

- [ ] **Step 3: Commit.**

```bash
git add apps/dashboard/src/components/subscriptions/schedule-modal.tsx apps/dashboard/src/components/subscriptions/index.ts
git commit -m "feat(dashboard): schedule cancel modal"
```

---

## Task 22: Show pending scheduled actions in expanded row

**Files:**
- Modify: `apps/dashboard/src/components/subscriptions/expanded-row.tsx`

- [ ] **Step 1: Read current expanded-row.tsx** to see its prop shape.

- [ ] **Step 2: Inject pending-actions section**

Add a small section near the bottom of the expanded row:

```tsx
import { useScheduledActions, useDeleteScheduledAction } from "../../lib/hooks/useProjectSubscriptions";

// inside the component, given `projectId` + `subscription.id`:
const scheduled = useScheduledActions(projectId);
const del = useDeleteScheduledAction(projectId);
const mine = (scheduled.data?.rows ?? []).filter(
  (r) => r.purchaseId === subscription.id && r.status === "PENDING",
);

{mine.length > 0 ? (
  <div className="mt-3 rounded-md border border-rv-divider p-2 text-xs">
    <div className="mb-1 font-medium">Scheduled</div>
    <ul className="flex flex-col gap-1">
      {mine.map((r) => (
        <li key={r.id} className="flex items-center justify-between">
          <span>
            Cancel on {new Date(r.dueAt).toLocaleString()}
            {r.payload.revokeImmediately ? " (revoke immediately)" : ""}
          </span>
          <button
            type="button"
            onClick={() => del.mutate(r.id)}
            className="text-rv-danger"
            disabled={del.isPending}
          >
            Remove
          </button>
        </li>
      ))}
    </ul>
  </div>
) : null}
```

You'll need to thread `projectId` into `ExpandedRow` if it doesn't already accept it. If the prop drilling is awkward, accept that small refactor as part of this task.

- [ ] **Step 3: Commit.**

```bash
git add apps/dashboard/src/components/subscriptions/expanded-row.tsx
git commit -m "feat(dashboard): show pending scheduled cancels in expanded row"
```

---

## Task 23: Wire the three header buttons

**Files:**
- Modify: `apps/dashboard/src/routes/_authed/projects/$projectId/subscriptions.tsx`

- [ ] **Step 1: Read** the current header block (lines 337-360).

- [ ] **Step 2: Edit**

Add state + imports at the top of `SubscriptionsPage`:

```tsx
import {
  GrantSubscriptionModal,
  ScheduleCancelModal,
} from "../../../../components/subscriptions";
import { buildExportSubscriptionsUrl } from "../../../../lib/hooks/useProjectSubscriptions";

const [grantOpen, setGrantOpen] = useState(false);
const [scheduleOpen, setScheduleOpen] = useState(false);

const selectedSubs = useMemo(
  () => filtered.filter((s) => selectedIds.has(s.id)),
  [filtered, selectedIds],
);
const canSchedule = selectedSubs.length > 0;

const onExport = () => {
  window.location.assign(
    buildExportSubscriptionsUrl(projectId, scope, search),
  );
};
```

Replace the three buttons (lines 347-359) with wired versions:

```tsx
<Button
  variant="flat"
  size="sm"
  disabled={!canSchedule}
  onClick={() => setScheduleOpen(true)}
  title={!canSchedule ? t("subscriptions.actions.scheduleHint", { defaultValue: "Select at least one row" }) : undefined}
>
  <CalendarDays size={13} />
  {t("subscriptions.actions.schedule")}
</Button>
<Button variant="flat" size="sm" onClick={onExport}>
  <Download size={13} />
  {t("subscriptions.actions.exportCsv")}
</Button>
<Button variant="solid-primary" size="sm" onClick={() => setGrantOpen(true)}>
  <Plus size={13} />
  {t("subscriptions.actions.newSubscription")}
</Button>
```

And before the closing `</>` of the component, mount the modals:

```tsx
<GrantSubscriptionModal
  projectId={projectId}
  open={grantOpen}
  onClose={() => setGrantOpen(false)}
/>
<ScheduleCancelModal
  projectId={projectId}
  open={scheduleOpen}
  selected={selectedSubs}
  onClose={() => setScheduleOpen(false)}
/>
```

- [ ] **Step 3: Boot dashboard locally** (`pnpm --filter @rovenue/dashboard dev`), open the subscriptions page, exercise all three:
  - Export CSV → download triggers, CSV opens in a spreadsheet.
  - New subscription → fill form, save, see the new row appear.
  - Select rows → Schedule → set due date 2min in future → wait → row in expanded view shows up; after the worker tick (≤60s), purchase state reflects the action.
- [ ] **Step 4: Commit.**

```bash
git add apps/dashboard/src/routes/_authed/projects/$projectId/subscriptions.tsx
git commit -m "feat(dashboard): wire subscriptions header buttons (schedule/export/grant)"
```

---

## Task 24: Full test pass + manual smoke + PR

- [ ] **Step 1: Run full test suite.**

```bash
pnpm test
```

Expected: all green.

- [ ] **Step 2: Typecheck the whole repo.**

```bash
pnpm typecheck
```

- [ ] **Step 3: Manual smoke** — same flows as Task 23 step 3, plus:
  - Cancel a scheduled action via the expanded row → verify status flips and the worker no longer touches it.
  - Trigger a duplicate schedule → expect 409 toast.
  - Try a STRIPE purchase (seed one or use a real one if available) → confirm the worker calls Stripe (or returns FAILED gracefully if Stripe creds are missing).

- [ ] **Step 4: Commit anything outstanding, push, open PR.**

---

## Self-review checklist (run after writing this plan)

- Spec §2 decisions all map to tasks: MANUAL enum (Task 1), table (Task 2), grant + presets/custom (Tasks 6-8), schedule cancel-only (Tasks 9-13), MANUAL semantics keep-vs-revoke (Task 13), store-specific cancel branches (Task 13), CSV export (Tasks 15-17). ✓
- Each task has either a code block or an exact command. No "TBD" / "appropriate error handling" placeholders. ✓
- Type names consistent: `GrantSubscriptionRequest`, `ScheduleActionRequest`, `ScheduledActionRow` defined once in Task 5 and reused verbatim. ✓
- `scheduledActionsRepo` methods used in Task 10 + Task 13 match those defined in Task 4 (`insertScheduledAction`, `findPendingForPurchase`, `listForProject`, `cancelPending`, `claimDueBatch`, `markExecuted`, `markFailed`). ✓
- One known soft spot: several "adjust to actual exports" notes (audit field names, outbox column names, redis connection symbol, Stripe client, modal primitives). These are intentional — the codebase ships the canonical names, and inventing them here would be worse than telling the engineer to grep. The notes are explicit about what to look for.
