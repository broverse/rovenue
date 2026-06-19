# Surface configured webhook + custom webhook detail — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a project's configured outgoing webhook visible on the Apps & integrations page, and add a full detail page showing its config, signing-secret status, and real delivery history.

**Architecture:** The webhook stays one-endpoint-per-project (three columns on `projects`). One new read-only API endpoint lists recent `outgoing_webhooks` rows (all statuses). The dashboard gets a "Configured webhook" card on the Apps page and a standalone detail route that reuses the existing edit modal + secret-rotate hook and renders the delivery list.

**Tech Stack:** Hono + Drizzle (API/DB), TanStack Router + TanStack Query + react-i18next (dashboard), Vitest (tests). Spec: `docs/superpowers/specs/2026-06-19-webhook-surfacing-design.md`.

## Global Constraints

- TypeScript strict mode everywhere.
- All API responses use the `{ data: T }` / `{ error }` envelope via the `ok()` helper (`apps/api/src/lib/response`).
- All Postgres access goes through Drizzle repositories under `packages/db/src/drizzle/repositories`; the route calls them via `drizzle.outgoingWebhookRepo.*`.
- Dashboard data fetching uses TanStack Query; the existing webhook hooks use the `api()` path-string shim from `apps/dashboard/src/lib/api.ts` (returns the unwrapped `data`). New hook follows the same shim.
- Conventional commits (`feat:`, `test:`, `chore:`). Stay on the current branch — do not create or switch branches/worktrees.
- No database schema/migration changes. No changes to the delivery worker, dedup, claim/retry, or `webhook_events`.
- Backend behavior is TDD'd with the existing mocked-drizzle route harness (no testcontainers needed) plus one Postgres integration test for the repo. Dashboard tasks are verified by the type-checked build (`tsc`), matching this app's convention (it has no component test suite; `vitest run --passWithNoTests`).

---

### Task 1: Shared wire types

**Files:**
- Modify: `packages/shared/src/dashboard.ts` (add after the existing `SubscriberOutgoingWebhook` interface, ~line 353)

**Interfaces:**
- Consumes: existing `OffsetPagination` interface (already defined in this file, ~line 1847).
- Produces: `WebhookDelivery`, `ListWebhookDeliveriesResponse` — consumed by Task 3 (API route response shape) and Task 4 (dashboard hook).

- [ ] **Step 1: Add the types**

In `packages/shared/src/dashboard.ts`, immediately after the `SubscriberOutgoingWebhook` interface (the block ending `}` at ~line 353), insert:

```typescript
/**
 * One outgoing webhook delivery attempt, project-scoped. Mirrors a
 * row from `outgoing_webhooks` with timestamps serialised to ISO
 * strings. Returned by GET /dashboard/webhooks/deliveries — covers
 * ALL statuses (PENDING/DELIVERING/SENT/FAILED/DEAD/DISMISSED), unlike
 * the dead-letter list.
 */
export interface WebhookDelivery {
  id: string;
  eventType: string;
  url: string;
  /** OutgoingWebhookStatus as a string. */
  status: string;
  /** HTTP status of the last attempt; null before the first attempt. */
  httpStatus: number | null;
  attempts: number;
  createdAt: string;
  sentAt: string | null;
  lastErrorMessage: string | null;
}

export interface ListWebhookDeliveriesResponse {
  webhooks: WebhookDelivery[];
  pagination: OffsetPagination;
}
```

- [ ] **Step 2: Verify it compiles**

Run: `pnpm --filter @rovenue/shared build`
Expected: PASS (tsc emits with no errors).

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/dashboard.ts
git commit -m "feat(shared): WebhookDelivery + ListWebhookDeliveriesResponse wire types"
```

---

### Task 2: DB repository — recent deliveries read

**Files:**
- Modify: `packages/db/src/drizzle/repositories/outgoing-webhooks.ts` (add after `countDeadWebhooks`, ~line 100)
- Test: `apps/api/tests/outgoing-webhooks-list.integration.test.ts` (new; needs dev Postgres)

**Interfaces:**
- Consumes: existing `ListFailedArgs` (`{ projectId, limit, offset }`), `outgoingWebhooks` table, `OutgoingWebhook` type, and the already-imported `and`, `count`, `desc`, `eq` from drizzle-orm — all in this file.
- Produces:
  - `listRecentOutgoingWebhooks(db: Db, args: ListFailedArgs): Promise<OutgoingWebhook[]>` — all statuses for the project, `createdAt DESC`, limit/offset.
  - `countOutgoingWebhooks(db: Db, projectId: string): Promise<number>`.
  - Both reachable as `drizzle.outgoingWebhookRepo.listRecentOutgoingWebhooks` / `.countOutgoingWebhooks` via the existing `export * as outgoingWebhookRepo` barrel (`packages/db/src/drizzle/index.ts:32`). Consumed by Task 3.

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/tests/outgoing-webhooks-list.integration.test.ts`:

```typescript
// =============================================================
// listRecentOutgoingWebhooks / countOutgoingWebhooks — integration
//
// Verifies the dashboard "recent deliveries" read: project-scoped,
// newest-first, ALL statuses (not just DEAD). Runs against dev
// Postgres (docker-compose host port 5433) configured in
// apps/api/tests/setup.ts. Rows keyed by a unique RUN_ID so parallel
// runs against the shared dev DB don't collide.
// =============================================================

import { afterAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getDb, outgoingWebhooks, projects, subscribers, drizzle } from "@rovenue/db";

const RUN_ID = Date.now();
const PROJECT_ID = `prj_whlist_${RUN_ID}`;
const OTHER_PROJECT_ID = `prj_whlist_other_${RUN_ID}`;
const SUBSCRIBER_ID = `sub_whlist_${RUN_ID}`;

async function seed(): Promise<void> {
  const db = getDb();
  await db.insert(projects).values([
    { id: PROJECT_ID, name: `Webhook List Test ${RUN_ID}` },
    { id: OTHER_PROJECT_ID, name: `Webhook List Other ${RUN_ID}` },
  ]);
  await db.insert(subscribers).values({
    id: SUBSCRIBER_ID,
    projectId: PROJECT_ID,
    rovenueId: `app_user_whlist_${RUN_ID}`,
    appUserId: `app_user_whlist_${RUN_ID}`,
  });
  // 3 for our project (mixed statuses), 1 for the other project.
  const statuses = ["SENT", "PENDING", "DEAD"] as const;
  for (let i = 0; i < statuses.length; i++) {
    await db.insert(outgoingWebhooks).values({
      id: `ogw_whlist_${RUN_ID}_${i}`,
      projectId: PROJECT_ID,
      eventType: `evt.${i}`,
      subscriberId: SUBSCRIBER_ID,
      purchaseId: null,
      payload: { i },
      url: "https://example.test/hook",
      status: statuses[i],
      attempts: i,
    });
  }
  await db.insert(outgoingWebhooks).values({
    id: `ogw_whlist_${RUN_ID}_other`,
    projectId: OTHER_PROJECT_ID,
    eventType: "evt.other",
    subscriberId: SUBSCRIBER_ID,
    purchaseId: null,
    payload: {},
    url: "https://example.test/hook",
    status: "SENT",
    attempts: 0,
  });
}

afterAll(async () => {
  const db = getDb();
  await db.delete(projects).where(eq(projects.id, PROJECT_ID));
  await db.delete(projects).where(eq(projects.id, OTHER_PROJECT_ID));
});

describe("listRecentOutgoingWebhooks / countOutgoingWebhooks", () => {
  it("returns all statuses for the project, newest first, scoped out other projects", async () => {
    await seed();
    const db = getDb();

    const rows = await drizzle.outgoingWebhookRepo.listRecentOutgoingWebhooks(db, {
      projectId: PROJECT_ID,
      limit: 50,
      offset: 0,
    });
    const ours = rows.filter((r) => r.id.startsWith(`ogw_whlist_${RUN_ID}_`) && !r.id.endsWith("other"));
    expect(ours).toHaveLength(3);
    expect(new Set(ours.map((r) => r.status))).toEqual(new Set(["SENT", "PENDING", "DEAD"]));
    expect(rows.every((r) => r.projectId === PROJECT_ID)).toBe(true);
    // newest first: createdAt is non-increasing
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i - 1].createdAt.getTime()).toBeGreaterThanOrEqual(rows[i].createdAt.getTime());
    }

    const total = await drizzle.outgoingWebhookRepo.countOutgoingWebhooks(db, PROJECT_ID);
    expect(total).toBe(3);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rovenue/api test outgoing-webhooks-list`
Expected: FAIL — `drizzle.outgoingWebhookRepo.listRecentOutgoingWebhooks is not a function`.

- [ ] **Step 3: Implement the repository functions**

In `packages/db/src/drizzle/repositories/outgoing-webhooks.ts`, after `countDeadWebhooks` (the block ending at ~line 100), add:

```typescript
/**
 * Recent outgoing webhook deliveries for a project — ALL statuses,
 * newest first. Powers the dashboard webhook-detail delivery history.
 * (listDeadWebhooks is the dead-letter-only counterpart.)
 */
export async function listRecentOutgoingWebhooks(
  db: Db,
  args: ListFailedArgs,
): Promise<OutgoingWebhook[]> {
  return db
    .select()
    .from(outgoingWebhooks)
    .where(eq(outgoingWebhooks.projectId, args.projectId))
    .orderBy(desc(outgoingWebhooks.createdAt))
    .limit(args.limit)
    .offset(args.offset);
}

export async function countOutgoingWebhooks(
  db: Db,
  projectId: string,
): Promise<number> {
  const rows = await db
    .select({ total: count() })
    .from(outgoingWebhooks)
    .where(eq(outgoingWebhooks.projectId, projectId));
  return Number(rows[0]?.total ?? 0);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rovenue/api test outgoing-webhooks-list`
Expected: PASS.
(If Docker/dev Postgres is not running, start it with `docker compose up -d postgres` first — this is an integration test.)

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/drizzle/repositories/outgoing-webhooks.ts apps/api/tests/outgoing-webhooks-list.integration.test.ts
git commit -m "feat(db): listRecentOutgoingWebhooks + countOutgoingWebhooks repo reads"
```

---

### Task 3: API route — GET /dashboard/webhooks/deliveries

**Files:**
- Modify: `apps/api/src/routes/dashboard/webhooks.ts` (insert a new chained `.get("/deliveries", …)` between the `/failed` handler and `.post("/:id/retry", …)`, i.e. after the `})` that currently closes `/failed` at ~line 64)
- Test: `apps/api/tests/dashboard-webhook-deliveries.test.ts` (new; mocked drizzle, no DB)

**Interfaces:**
- Consumes: `drizzle.outgoingWebhookRepo.listRecentOutgoingWebhooks` + `.countOutgoingWebhooks` (Task 2); `ListWebhookDeliveriesResponse`/`WebhookDelivery` (Task 1); existing `requireDashboardAuth`, `assertProjectAccess`, `ok`, `HTTPException` already imported in this file.
- Produces: `GET /dashboard/webhooks/deliveries?projectId=&limit=&offset=` → `{ data: ListWebhookDeliveriesResponse }`. Consumed by Task 4. Because the route is part of the chained `webhooksDashboardRoute`, it also flows into the exported `AppType`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/tests/dashboard-webhook-deliveries.test.ts`:

```typescript
import { beforeEach, describe, expect, it, vi } from "vitest";

// =============================================================
// GET /dashboard/webhooks/deliveries — recent deliveries list.
// Mocked drizzle (no DB), mirroring dashboard-webhook-retry-guard.
// =============================================================

const auditMock = vi.hoisted(() => ({
  audit: vi.fn(async () => undefined),
  extractRequestContext: vi.fn(() => ({ ipAddress: null, userAgent: null })),
  redactCredentials: vi.fn((obj: Record<string, unknown> | null | undefined) => obj ?? null),
  verifyAuditChain: vi.fn(async () => ({
    projectId: "", rowCount: 0, firstVerifiedAt: null, lastVerifiedAt: null, errors: [],
  })),
}));
vi.mock("../src/lib/audit", () => auditMock);

const { dbMock, drizzleMock, authMock } = vi.hoisted(() => {
  const dbMock = { projectMember: { findUnique: vi.fn() } };
  const drizzleMock = {
    db: {} as unknown,
    projectRepo: {
      findMembership: vi.fn(async (_db: unknown, projectId: string, userId: string) =>
        dbMock.projectMember.findUnique({
          where: { projectId_userId: { projectId, userId } },
          select: { id: true, role: true },
        }),
      ),
    },
    outgoingWebhookRepo: {
      listRecentOutgoingWebhooks: vi.fn(async () => []),
      countOutgoingWebhooks: vi.fn(async () => 0),
    },
    shadowRead: vi.fn(async <T>(primary: () => Promise<T>): Promise<T> => primary()),
  };
  const authMock = { auth: { api: { getSession: vi.fn() } } };
  return { dbMock, drizzleMock, authMock };
});

vi.mock("@rovenue/db", () => ({
  default: dbMock,
  drizzle: drizzleMock,
  MemberRole: { OWNER: "OWNER", ADMIN: "ADMIN", VIEWER: "VIEWER" },
  OutgoingWebhookStatus: {
    PENDING: "PENDING", SENT: "SENT", FAILED: "FAILED", DEAD: "DEAD", DISMISSED: "DISMISSED",
  },
}));

vi.mock("../src/lib/auth", () => authMock);

import { app } from "../src/app";

function authedHeaders(): Record<string, string> {
  return { cookie: "session=test-session" };
}

beforeEach(() => {
  vi.clearAllMocks();
  authMock.auth.api.getSession.mockResolvedValue({
    user: { id: "user_1" }, session: { id: "sess_1" },
  });
  dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm_1", role: "OWNER" });
});

describe("GET /dashboard/webhooks/deliveries", () => {
  it("returns 400 when projectId is missing", async () => {
    const res = await app.request("http://localhost/dashboard/webhooks/deliveries", {
      headers: authedHeaders(),
    });
    expect(res.status).toBe(400);
    expect(drizzleMock.outgoingWebhookRepo.listRecentOutgoingWebhooks).not.toHaveBeenCalled();
  });

  it("maps rows to ISO-stringed wire shape and computes pagination", async () => {
    const created = new Date("2026-06-19T10:00:00.000Z");
    drizzleMock.outgoingWebhookRepo.listRecentOutgoingWebhooks.mockResolvedValue([
      {
        id: "ogw_1", projectId: "proj_1", eventType: "purchase.created",
        url: "https://x.test/hook", status: "SENT", httpStatus: 200, attempts: 1,
        createdAt: created, sentAt: created, lastErrorMessage: null,
      },
    ]);
    drizzleMock.outgoingWebhookRepo.countOutgoingWebhooks.mockResolvedValue(42);

    const res = await app.request(
      "http://localhost/dashboard/webhooks/deliveries?projectId=proj_1&limit=20&offset=0",
      { headers: authedHeaders() },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { webhooks: Array<Record<string, unknown>>; pagination: Record<string, unknown> };
    };
    expect(body.data.webhooks[0]).toEqual({
      id: "ogw_1", eventType: "purchase.created", url: "https://x.test/hook",
      status: "SENT", httpStatus: 200, attempts: 1,
      createdAt: "2026-06-19T10:00:00.000Z", sentAt: "2026-06-19T10:00:00.000Z",
      lastErrorMessage: null,
    });
    expect(body.data.pagination).toEqual({ total: 42, limit: 20, offset: 0, hasMore: true });
    expect(drizzleMock.outgoingWebhookRepo.listRecentOutgoingWebhooks).toHaveBeenCalledWith(
      expect.anything(), { projectId: "proj_1", limit: 20, offset: 0 },
    );
  });

  it("caps limit at 100 and defaults to 20", async () => {
    await app.request(
      "http://localhost/dashboard/webhooks/deliveries?projectId=proj_1&limit=9999",
      { headers: authedHeaders() },
    );
    expect(drizzleMock.outgoingWebhookRepo.listRecentOutgoingWebhooks).toHaveBeenCalledWith(
      expect.anything(), { projectId: "proj_1", limit: 100, offset: 0 },
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rovenue/api test dashboard-webhook-deliveries`
Expected: FAIL — 404 (route not found) / `listRecentOutgoingWebhooks` not called.

- [ ] **Step 3: Implement the route**

In `apps/api/src/routes/dashboard/webhooks.ts`, insert this handler into the chain immediately after the `/failed` handler's closing `})` (~line 64) and before `.post("/:id/retry", …)`:

```typescript
  // ----- GET /dashboard/webhooks/deliveries?projectId= -----
  // List recent outgoing webhook deliveries (ALL statuses), newest
  // first. Powers the custom-webhook detail page's delivery history.
  .get("/deliveries", async (c) => {
    const projectId = c.req.query("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "projectId query param required" });
    }
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id);

    const rawLimit = c.req.query("limit");
    const rawOffset = c.req.query("offset");
    const limit = Math.min(rawLimit ? parseInt(rawLimit, 10) || 20 : 20, 100);
    const offset = rawOffset ? parseInt(rawOffset, 10) || 0 : 0;

    const [rows, total] = await Promise.all([
      drizzle.outgoingWebhookRepo.listRecentOutgoingWebhooks(drizzle.db, {
        projectId,
        limit,
        offset,
      }),
      drizzle.outgoingWebhookRepo.countOutgoingWebhooks(drizzle.db, projectId),
    ]);

    const webhooks = rows.map((w) => ({
      id: w.id,
      eventType: w.eventType,
      url: w.url,
      status: w.status,
      httpStatus: w.httpStatus,
      attempts: w.attempts,
      createdAt: w.createdAt.toISOString(),
      sentAt: w.sentAt ? w.sentAt.toISOString() : null,
      lastErrorMessage: w.lastErrorMessage,
    }));

    return c.json(
      ok({
        webhooks,
        pagination: {
          total,
          limit,
          offset,
          hasMore: offset + limit < total,
        },
      }),
    );
  })
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rovenue/api test dashboard-webhook-deliveries`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/dashboard/webhooks.ts apps/api/tests/dashboard-webhook-deliveries.test.ts
git commit -m "feat(api): GET /dashboard/webhooks/deliveries recent deliveries list"
```

---

### Task 4: Dashboard hook — useWebhookDeliveries

**Files:**
- Create: `apps/dashboard/src/lib/hooks/useWebhookDeliveries.ts`

**Interfaces:**
- Consumes: `api()` from `../api`; `ListWebhookDeliveriesResponse` from `@rovenue/shared` (Task 1); the endpoint from Task 3.
- Produces: `useWebhookDeliveries(projectId: string, page?: number, limit?: number)` returning a TanStack Query result of `ListWebhookDeliveriesResponse`. Consumed by Task 6.

- [ ] **Step 1: Write the hook**

Create `apps/dashboard/src/lib/hooks/useWebhookDeliveries.ts`:

```typescript
import { useQuery } from "@tanstack/react-query";
import type { ListWebhookDeliveriesResponse } from "@rovenue/shared";
import { api } from "../api";

const PAGE_SIZE = 20;

/**
 * Recent outgoing webhook deliveries (all statuses) for a project,
 * paginated. Backs the custom-webhook detail page's history table.
 */
export function useWebhookDeliveries(
  projectId: string,
  page = 0,
  limit = PAGE_SIZE,
) {
  const offset = page * limit;
  return useQuery({
    queryKey: ["webhook-deliveries", projectId, limit, offset],
    enabled: Boolean(projectId),
    queryFn: () =>
      api<ListWebhookDeliveriesResponse>(
        `/dashboard/webhooks/deliveries?projectId=${encodeURIComponent(projectId)}&limit=${limit}&offset=${offset}`,
      ),
  });
}
```

- [ ] **Step 2: Verify it type-checks**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit`
Expected: PASS (no errors referencing the new file).

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/lib/hooks/useWebhookDeliveries.ts
git commit -m "feat(dashboard): useWebhookDeliveries query hook"
```

---

### Task 5: Configured-webhook card on the Apps & integrations page

**Files:**
- Create: `apps/dashboard/src/components/apps/configured-webhook-card.tsx`
- Modify: `apps/dashboard/src/components/apps/index.ts` (barrel export)
- Modify: `apps/dashboard/src/routes/_authed/projects/$projectId/apps.tsx` (render the card when a webhook is configured)
- Modify: `apps/dashboard/src/i18n/locales/en.json` (add `apps.configuredWebhook.*`)

**Interfaces:**
- Consumes: `ProjectDetail` fields `webhookUrl`, `webhookEventCategories`, `hasWebhookSecret` (from `useProject`); `Link` from `@tanstack/react-router`; UI `Chip` (`../../ui/chip`).
- Produces: `ConfiguredWebhookCard` component. Links to the detail route created in Task 6 (`/projects/$projectId/apps/webhooks`).

- [ ] **Step 1: Add i18n keys**

In `apps/dashboard/src/i18n/locales/en.json`, inside the top-level `"apps"` object (sibling of `"customWebhook"`), add:

```json
"configuredWebhook": {
  "title": "Custom webhook",
  "active": "Active",
  "allEvents": "All events",
  "secretSet": "Secret configured",
  "secretMissing": "No signing secret",
  "viewDetail": "View details"
}
```

- [ ] **Step 2: Write the component**

Create `apps/dashboard/src/components/apps/configured-webhook-card.tsx`:

```tsx
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ArrowUpRight, Webhook } from "lucide-react";
import type { WebhookEventCategory } from "@rovenue/shared";
import { Chip } from "../../ui/chip";

interface Props {
  projectId: string;
  url: string;
  categories: WebhookEventCategory[];
  hasSecret: boolean;
}

/**
 * Surfaces the project's single configured outgoing webhook on the
 * Apps & integrations page. Rendered only when a webhook URL is set;
 * links through to the detail route for config + delivery history.
 */
export function ConfiguredWebhookCard({ projectId, url, categories, hasSecret }: Props) {
  const { t } = useTranslation();
  const categoryLabel =
    categories.length === 0
      ? t("apps.configuredWebhook.allEvents")
      : categories.map((c) => t(`apps.customWebhook.categories.${c}`)).join(", ");

  return (
    <Link
      to="/projects/$projectId/apps/webhooks"
      params={{ projectId }}
      className="mb-4 flex items-center gap-3 rounded-lg border border-rv-divider bg-rv-c1 px-4 py-3.5 transition hover:border-rv-accent-500/40 hover:bg-rv-c2"
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-md border border-rv-divider bg-rv-c2 text-rv-accent-500">
        <Webhook size={16} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-[13px] font-semibold text-foreground">
            {t("apps.configuredWebhook.title")}
          </span>
          <Chip tone="success">{t("apps.configuredWebhook.active")}</Chip>
          <Chip tone={hasSecret ? "success" : "warning"}>
            {hasSecret
              ? t("apps.configuredWebhook.secretSet")
              : t("apps.configuredWebhook.secretMissing")}
          </Chip>
        </div>
        <div className="mt-0.5 truncate font-rv-mono text-[11.5px] text-rv-mute-500">{url}</div>
        <div className="mt-0.5 truncate text-[11.5px] text-rv-mute-500">{categoryLabel}</div>
      </div>
      <span className="inline-flex shrink-0 items-center gap-1 text-[11.5px] text-rv-accent-500">
        {t("apps.configuredWebhook.viewDetail")}
        <ArrowUpRight size={12} />
      </span>
    </Link>
  );
}
```

- [ ] **Step 3: Export from the barrel**

In `apps/dashboard/src/components/apps/index.ts`, add next to the other component exports (e.g. after the `ConnectedStrip` line):

```typescript
export { ConfiguredWebhookCard } from "./configured-webhook-card";
```

- [ ] **Step 4: Render it on the Apps page**

In `apps/dashboard/src/routes/_authed/projects/$projectId/apps.tsx`:

(a) Add `ConfiguredWebhookCard` to the import from `"../../../../components/apps"` (the existing multi-name import block, ~lines 6-22).

(b) Inside `AppsPage`, near the other hook calls (~line 76), add:

```tsx
  const { data: project } = useProject(projectId);
```

(c) Render the card between `<AppsHero … />` and the layout `<div className="grid …">` (~line 146-148):

```tsx
      <AppsHero totalApps={counts.all} connectedApps={counts.connected} />

      {project?.webhookUrl && (
        <ConfiguredWebhookCard
          projectId={projectId}
          url={project.webhookUrl}
          categories={project.webhookEventCategories}
          hasSecret={project.hasWebhookSecret}
        />
      )}

      <div className="grid items-start gap-4 grid-cols-1 lg:grid-cols-[220px_minmax(0,1fr)]">
```

(`useProject` is already imported in this file at ~line 25.)

- [ ] **Step 5: Verify it type-checks**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit`
Expected: PASS. (TanStack Router types for `to="/projects/$projectId/apps/webhooks"` resolve once Task 6's route file exists and `routeTree.gen.ts` regenerates. If running this task before Task 6, expect a route-path type error here — implement Task 6 then re-run; the two tasks share the build gate.)

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/components/apps/configured-webhook-card.tsx apps/dashboard/src/components/apps/index.ts apps/dashboard/src/routes/_authed/projects/$projectId/apps.tsx apps/dashboard/src/i18n/locales/en.json
git commit -m "feat(dashboard/apps): surface configured webhook card on Apps & integrations"
```

---

### Task 6: Custom webhook detail route

**Files:**
- Create: `apps/dashboard/src/routes/_authed/projects/$projectId/apps_.webhooks.tsx`
- Modify: `apps/dashboard/src/i18n/locales/en.json` (add `apps.webhookDetail.*`)

**Interfaces:**
- Consumes: `useProject`, `useUpdateProjectWebhook` (unused for edit beyond modal), `useRotateWebhookSecret`, `useWebhookDeliveries` (Task 4); `CustomWebhookModal` (`../../../../components/apps/custom-webhook-modal`); `LoadingState` + `EmptyStateCard` (`../../../../components/dashboard/...`); `Chip`, `Button`/`buttonVariants`, `CopyButton` from `../../../../ui/*`.
- Produces: route at `/_authed/projects/$projectId/apps_/webhooks` (URL `/projects/$projectId/apps/webhooks`). The trailing-underscore on `apps_` opts the page out of nesting under the `apps` route (which renders no `<Outlet/>`), exactly like `refund-shield/responses_.$rid.tsx`.

- [ ] **Step 1: Add i18n keys**

In `apps/dashboard/src/i18n/locales/en.json`, inside the top-level `"apps"` object, add:

```json
"webhookDetail": {
  "back": "Apps & integrations",
  "title": "Custom webhook",
  "subtitle": "Outgoing webhook endpoint, signing secret, and recent deliveries.",
  "edit": "Edit",
  "endpointLabel": "Endpoint",
  "eventsLabel": "Subscribed events",
  "allEvents": "All events",
  "secretLabel": "Signing secret",
  "secretConfigured": "Configured",
  "secretMissing": "Not set",
  "rotate": "Rotate secret",
  "rotating": "Rotating…",
  "secretRevealWarning": "Copy this now — it is shown only once.",
  "deliveries": {
    "title": "Recent deliveries",
    "empty": "No deliveries yet",
    "emptyHint": "Deliveries appear here once subscription events start firing.",
    "colStatus": "Status",
    "colEvent": "Event",
    "colAttempts": "Attempts",
    "colCreated": "Created",
    "colSent": "Sent",
    "colError": "Last error",
    "prev": "Previous",
    "next": "Next"
  },
  "noWebhook": {
    "title": "No webhook configured",
    "description": "Create a custom webhook to receive subscription events on your server.",
    "cta": "New webhook"
  }
}
```

- [ ] **Step 2: Write the route**

Create `apps/dashboard/src/routes/_authed/projects/$projectId/apps_.webhooks.tsx`:

```tsx
import { useState } from "react";
import { createFileRoute, Link, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ArrowLeft, Pencil, Webhook } from "lucide-react";
import type { WebhookDelivery } from "@rovenue/shared";
import { Button } from "../../../../ui/button";
import { Chip, type ChipProps } from "../../../../ui/chip";
import { CopyButton } from "../../../../ui/copy-button";
import { CustomWebhookModal } from "../../../../components/apps/custom-webhook-modal";
import { LoadingState } from "../../../../components/dashboard/loading-state";
import { EmptyStateCard } from "../../../../components/dashboard/empty-state-card";
import { useProject } from "../../../../lib/hooks/useProject";
import { useRotateWebhookSecret } from "../../../../lib/hooks/useRotateWebhookSecret";
import { useWebhookDeliveries } from "../../../../lib/hooks/useWebhookDeliveries";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/apps_/webhooks",
)({
  component: WebhookDetailRoute,
});

function WebhookDetailRoute() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/apps_/webhooks",
  });
  return <WebhookDetailPage projectId={projectId} />;
}

// SENT → success; PENDING/DELIVERING/FAILED → warning; DEAD → danger;
// DISMISSED → neutral.
function statusTone(status: string): NonNullable<ChipProps["tone"]> {
  if (status === "SENT") return "success";
  if (status === "DEAD") return "danger";
  if (status === "DISMISSED") return "default";
  return "warning";
}

function WebhookDetailPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const { data: project } = useProject(projectId);
  const rotate = useRotateWebhookSecret(projectId);
  const [revealedSecret, setRevealedSecret] = useState<string | null>(null);
  const [page, setPage] = useState(0);
  const [editOpen, setEditOpen] = useState(false);
  const deliveries = useWebhookDeliveries(projectId, page);

  if (!project) return <LoadingState />;

  const hasWebhook = Boolean(project.webhookUrl);

  const handleRotate = async () => {
    try {
      const res = await rotate.mutateAsync();
      setRevealedSecret(res.webhookSecret);
    } catch {
      /* surfaced via rotate.isError */
    }
  };

  return (
    <>
      <header className="pb-5">
        <Link
          to="/projects/$projectId/apps"
          params={{ projectId }}
          className="inline-flex items-center gap-1 text-[12px] text-rv-mute-500 hover:text-foreground"
        >
          <ArrowLeft size={12} />
          {t("apps.webhookDetail.back")}
        </Link>
        <div className="mt-2 flex flex-wrap items-start justify-between gap-3">
          <div>
            <h1 className="text-[20px] font-semibold leading-7 tracking-tight">
              {t("apps.webhookDetail.title")}
            </h1>
            <p className="mt-1 text-[12.5px] text-rv-mute-500">
              {t("apps.webhookDetail.subtitle")}
            </p>
          </div>
          {hasWebhook && (
            <Button variant="flat" size="sm" onClick={() => setEditOpen(true)}>
              <Pencil size={13} />
              {t("apps.webhookDetail.edit")}
            </Button>
          )}
        </div>
      </header>

      {!hasWebhook ? (
        <EmptyStateCard
          icon={Webhook}
          title={t("apps.webhookDetail.noWebhook.title")}
          description={t("apps.webhookDetail.noWebhook.description")}
          actions={
            <Button variant="solid-primary" size="sm" onClick={() => setEditOpen(true)}>
              {t("apps.webhookDetail.noWebhook.cta")}
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-4">
          {/* Config + secret */}
          <section className="grid gap-3 rounded-lg border border-rv-divider bg-rv-c1 px-4 py-4 sm:grid-cols-2 sm:px-5">
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
                {t("apps.webhookDetail.endpointLabel")}
              </div>
              <div className="mt-1 flex items-center gap-2 rounded-md border border-rv-divider bg-rv-c2 px-3 py-1.5">
                <code className="truncate font-rv-mono text-[12px] text-foreground">
                  {project.webhookUrl}
                </code>
                <CopyButton size="xs" value={project.webhookUrl ?? ""} />
              </div>
              <div className="mt-3 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
                {t("apps.webhookDetail.eventsLabel")}
              </div>
              <div className="mt-1 flex flex-wrap gap-1.5">
                {project.webhookEventCategories.length === 0 ? (
                  <Chip tone="default">{t("apps.webhookDetail.allEvents")}</Chip>
                ) : (
                  project.webhookEventCategories.map((c) => (
                    <Chip key={c} tone="default">
                      {t(`apps.customWebhook.categories.${c}`)}
                    </Chip>
                  ))
                )}
              </div>
            </div>
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
                {t("apps.webhookDetail.secretLabel")}
              </div>
              {revealedSecret ? (
                <div className="mt-1 rounded-md border border-rv-divider bg-rv-c2 px-3 py-2">
                  <div className="flex items-center gap-2">
                    <code className="truncate font-rv-mono text-[12px] text-foreground">
                      {revealedSecret}
                    </code>
                    <CopyButton size="xs" value={revealedSecret} />
                  </div>
                  <p className="mt-1 text-[11px] text-rv-warning">
                    {t("apps.webhookDetail.secretRevealWarning")}
                  </p>
                </div>
              ) : (
                <div className="mt-1 flex items-center gap-2">
                  <Chip tone={project.hasWebhookSecret ? "success" : "warning"}>
                    {project.hasWebhookSecret
                      ? t("apps.webhookDetail.secretConfigured")
                      : t("apps.webhookDetail.secretMissing")}
                  </Chip>
                  <Button
                    variant="flat"
                    size="sm"
                    onClick={handleRotate}
                    disabled={rotate.isPending}
                    type="button"
                  >
                    {rotate.isPending
                      ? t("apps.webhookDetail.rotating")
                      : t("apps.webhookDetail.rotate")}
                  </Button>
                </div>
              )}
            </div>
          </section>

          {/* Delivery history */}
          <section className="rounded-lg border border-rv-divider bg-rv-c1">
            <header className="border-b border-rv-divider px-4 py-3 sm:px-5">
              <h3 className="text-[13px] font-semibold text-foreground">
                {t("apps.webhookDetail.deliveries.title")}
              </h3>
            </header>
            {deliveries.isLoading ? (
              <LoadingState />
            ) : (deliveries.data?.webhooks.length ?? 0) === 0 ? (
              <EmptyStateCard
                icon={Webhook}
                title={t("apps.webhookDetail.deliveries.empty")}
                description={t("apps.webhookDetail.deliveries.emptyHint")}
              />
            ) : (
              <>
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-[12px]">
                    <thead className="text-[11px] uppercase tracking-wider text-rv-mute-500">
                      <tr className="border-b border-rv-divider">
                        <th className="px-4 py-2 font-medium sm:px-5">
                          {t("apps.webhookDetail.deliveries.colStatus")}
                        </th>
                        <th className="px-4 py-2 font-medium">
                          {t("apps.webhookDetail.deliveries.colEvent")}
                        </th>
                        <th className="px-4 py-2 font-medium">
                          {t("apps.webhookDetail.deliveries.colAttempts")}
                        </th>
                        <th className="px-4 py-2 font-medium">
                          {t("apps.webhookDetail.deliveries.colCreated")}
                        </th>
                        <th className="px-4 py-2 font-medium">
                          {t("apps.webhookDetail.deliveries.colSent")}
                        </th>
                        <th className="px-4 py-2 font-medium">
                          {t("apps.webhookDetail.deliveries.colError")}
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {deliveries.data!.webhooks.map((d: WebhookDelivery) => (
                        <tr key={d.id} className="border-b border-rv-divider last:border-0">
                          <td className="px-4 py-2 sm:px-5">
                            <Chip tone={statusTone(d.status)}>{d.status}</Chip>
                          </td>
                          <td className="px-4 py-2 font-rv-mono text-[11.5px]">{d.eventType}</td>
                          <td className="px-4 py-2 tabular-nums">{d.attempts}</td>
                          <td className="px-4 py-2 text-rv-mute-600">
                            {new Date(d.createdAt).toLocaleString()}
                          </td>
                          <td className="px-4 py-2 text-rv-mute-600">
                            {d.sentAt ? new Date(d.sentAt).toLocaleString() : "—"}
                          </td>
                          <td className="max-w-[220px] truncate px-4 py-2 text-rv-danger">
                            {d.lastErrorMessage ?? "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <footer className="flex items-center justify-end gap-2 border-t border-rv-divider px-4 py-2.5 sm:px-5">
                  <Button
                    variant="flat"
                    size="sm"
                    disabled={page === 0}
                    onClick={() => setPage((p) => Math.max(0, p - 1))}
                  >
                    {t("apps.webhookDetail.deliveries.prev")}
                  </Button>
                  <Button
                    variant="flat"
                    size="sm"
                    disabled={!deliveries.data?.pagination.hasMore}
                    onClick={() => setPage((p) => p + 1)}
                  >
                    {t("apps.webhookDetail.deliveries.next")}
                  </Button>
                </footer>
              </>
            )}
          </section>
        </div>
      )}

      {editOpen && (
        <CustomWebhookModal open onClose={() => setEditOpen(false)} projectId={projectId} />
      )}
    </>
  );
}
```

- [ ] **Step 3: Regenerate the route tree + type-check**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit`
Expected: PASS. (The TanStack Router Vite plugin regenerates `routeTree.gen.ts` on `pnpm dev`/`build`. If `tsc` complains the new route id is unknown, run `pnpm --filter @rovenue/dashboard dev` briefly to regenerate the tree, stop it, then re-run `tsc`. `Chip`'s `tone` union is `success | danger | warning | default | primary` — all tones used here are valid.)

- [ ] **Step 4: Verify the build**

Run: `pnpm --filter @rovenue/dashboard build`
Expected: PASS (`tsc && vite build`).

- [ ] **Step 5: Commit**

```bash
git add "apps/dashboard/src/routes/_authed/projects/\$projectId/apps_.webhooks.tsx" apps/dashboard/src/i18n/locales/en.json
git commit -m "feat(dashboard/apps): custom webhook detail route with delivery history"
```

(`routeTree.gen.ts` is gitignored — it regenerates from the route files, so leave it out of the commit.)

---

### Task 7: Full verification

**Files:** none (verification only).

- [ ] **Step 1: API tests green**

Run: `pnpm --filter @rovenue/api test dashboard-webhook-deliveries outgoing-webhooks-list`
Expected: PASS (the integration test needs dev Postgres up; the route test runs standalone).

- [ ] **Step 2: Dashboard build green**

Run: `pnpm --filter @rovenue/dashboard build`
Expected: PASS.

- [ ] **Step 3: Shared + db build green**

Run: `pnpm --filter @rovenue/shared build && pnpm --filter @rovenue/db build`
Expected: PASS.

- [ ] **Step 4: Manual smoke (optional, requires full stack)**

Run `pnpm dev`, open a project with no webhook → Apps page shows no card; the detail route at `/projects/<id>/apps/webhooks` shows the empty/CTA state. Configure a webhook via "New webhook" → the card appears on the Apps page and links to the detail page showing config, secret status, and (once events fire) the delivery table.

---

## Notes for the implementer

- **Why `apps_.webhooks.tsx` and not `apps.webhooks.tsx`:** `apps.tsx` renders its content directly with no `<Outlet/>`, so a child route would have nowhere to render. The trailing underscore (`apps_`) makes the detail page a standalone sibling that still lives at the `/apps/webhooks` URL — the same pattern as `refund-shield/responses_.$rid.tsx`.
- **`encodeURIComponent` on projectId** in the hook guards against any path-unsafe id; ids are cuid2 today but the guard is free.
- **Do not touch** `apps/dashboard/src/components/sdk-api/webhook-card.tsx` or its `WEBHOOK_DELIVERIES` mock — wiring the SDK/API settings card to the real endpoint is explicitly out of scope (spec §"Out of scope"). It can reuse `useWebhookDeliveries` in a follow-up.
- **Chip tones:** the `ChipProps["tone"]` union is `success | danger | warning | default | primary` (confirmed in `apps/dashboard/src/ui/chip.tsx`) — all values used in `statusTone` and the chips are valid.
