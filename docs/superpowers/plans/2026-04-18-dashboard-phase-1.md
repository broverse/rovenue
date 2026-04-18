# Dashboard Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up the Rovenue dashboard from the empty Vite scaffold through its first shippable surface area — OAuth login, project CRUD, and a subscriber list + detail view — by first landing the missing backend endpoints and then building the frontend that consumes them.

**Architecture:** Backend-first delivery. Part A lands two new Hono route groups (`/dashboard/projects` + `/dashboard/projects/:projectId/subscribers`) plus a cursor-pagination helper, all behind the existing Better Auth session guard and `assertProjectAccess` role gate. Part B upgrades `apps/dashboard` to React 19 / Tailwind 4 / Hero UI 3, wires TanStack Router + Query + Table, Better Auth client, and builds the login / projects / subscribers surfaces against typed API hooks.

**Tech Stack:**
- Backend: Hono, Prisma 6, Zod, Vitest, ioredis, BullMQ (already in place)
- Frontend: React 19, Vite 5, TanStack Router / Query / Table, @heroui/react 3, Tailwind 4, better-auth client, next-themes, Vitest + @testing-library/react + MSW

**Source of truth:** `docs/superpowers/specs/2026-04-18-dashboard-phase-1-design.md`

---

## File Map

### Part A — Backend

**New:**
- `apps/api/src/lib/pagination.ts` — `encodeCursor`, `decodeCursor`, cursor types
- `apps/api/src/routes/dashboard/projects.ts` — 6 endpoints for project CRUD + rotate
- `apps/api/src/routes/dashboard/subscribers.ts` — list + detail
- `apps/api/tests/pagination.test.ts`
- `apps/api/tests/dashboard-projects.test.ts`
- `apps/api/tests/dashboard-subscribers.test.ts`
- `packages/shared/src/dashboard.ts` — request/response types shared with the frontend

**Modified:**
- `apps/api/src/routes/dashboard/index.ts` — mount the two new route groups
- `packages/shared/src/index.ts` — re-export `./dashboard`

### Part B — Frontend

**New:**
- `apps/dashboard/src/index.css`
- `apps/dashboard/src/router.tsx`
- `apps/dashboard/src/lib/api.ts`
- `apps/dashboard/src/lib/auth.ts`
- `apps/dashboard/src/lib/queryClient.ts`
- `apps/dashboard/src/lib/hooks/useProjects.ts`
- `apps/dashboard/src/lib/hooks/useProject.ts`
- `apps/dashboard/src/lib/hooks/useCreateProject.ts`
- `apps/dashboard/src/lib/hooks/useUpdateProject.ts`
- `apps/dashboard/src/lib/hooks/useRotateWebhookSecret.ts`
- `apps/dashboard/src/lib/hooks/useDeleteProject.ts`
- `apps/dashboard/src/lib/hooks/useSubscribers.ts`
- `apps/dashboard/src/lib/hooks/useSubscriber.ts`
- `apps/dashboard/src/routes/__root.tsx`
- `apps/dashboard/src/routes/index.tsx`
- `apps/dashboard/src/routes/login.tsx`
- `apps/dashboard/src/routes/_authed.tsx`
- `apps/dashboard/src/routes/_authed/projects.tsx`
- `apps/dashboard/src/routes/_authed/projects.new.tsx`
- `apps/dashboard/src/routes/_authed/projects.$projectId/route.tsx`
- `apps/dashboard/src/routes/_authed/projects.$projectId/index.tsx`
- `apps/dashboard/src/routes/_authed/projects.$projectId/settings.tsx`
- `apps/dashboard/src/routes/_authed/projects.$projectId/subscribers/index.tsx`
- `apps/dashboard/src/routes/_authed/projects.$projectId/subscribers/$id.tsx`
- `apps/dashboard/src/components/layout/TopNav.tsx`
- `apps/dashboard/src/components/layout/ProjectSwitcher.tsx`
- `apps/dashboard/src/components/auth/OAuthButton.tsx`
- `apps/dashboard/src/components/projects/ProjectCard.tsx`
- `apps/dashboard/src/components/projects/CreateProjectForm.tsx`
- `apps/dashboard/src/components/projects/SettingsForm.tsx`
- `apps/dashboard/src/components/projects/RotateSecretDialog.tsx`
- `apps/dashboard/src/components/projects/DeleteProjectDialog.tsx`
- `apps/dashboard/src/components/subscribers/SubscribersTable.tsx`
- `apps/dashboard/src/components/subscribers/SubscriberDetailPanel.tsx`
- `apps/dashboard/src/components/subscribers/AccessTable.tsx`
- `apps/dashboard/src/components/subscribers/PurchasesTable.tsx`
- `apps/dashboard/src/components/subscribers/CreditLedgerTable.tsx`
- `apps/dashboard/src/components/subscribers/AssignmentsList.tsx`
- `apps/dashboard/tests/setup.ts`
- `apps/dashboard/tests/msw/handlers.ts`
- `apps/dashboard/tests/msw/server.ts`
- `apps/dashboard/tests/routes/login.test.tsx`
- `apps/dashboard/tests/routes/projects.test.tsx`
- `apps/dashboard/tests/routes/projects.new.test.tsx`
- `apps/dashboard/tests/routes/subscribers.test.tsx`
- `apps/dashboard/tests/routes/subscriber-detail.test.tsx`
- `apps/dashboard/vitest.config.ts`

**Modified:**
- `apps/dashboard/package.json` — deps upgrade
- `apps/dashboard/vite.config.ts` — add `@tailwindcss/vite` and `@tanstack/router-vite-plugin`
- `apps/dashboard/tsconfig.json` — `strict: true`, module resolution, jsx runtime
- `apps/dashboard/src/main.tsx` — providers + router

---

# Part A — Backend

## Task A1: Cursor pagination helper

**Files:**
- Create: `apps/api/src/lib/pagination.ts`
- Test: `apps/api/tests/pagination.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/tests/pagination.test.ts
import { describe, expect, test } from "vitest";
import {
  encodeCursor,
  decodeCursor,
  type Cursor,
} from "../src/lib/pagination";

describe("pagination cursor", () => {
  test("round-trips a cursor", () => {
    const input: Cursor = {
      createdAt: new Date("2026-04-18T10:00:00.000Z"),
      id: "abc123",
    };
    const encoded = encodeCursor(input);
    expect(typeof encoded).toBe("string");
    const decoded = decodeCursor(encoded);
    expect(decoded?.createdAt.toISOString()).toBe(input.createdAt.toISOString());
    expect(decoded?.id).toBe(input.id);
  });

  test("returns null for undefined / empty input", () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor("")).toBeNull();
  });

  test("returns null for malformed base64", () => {
    expect(decodeCursor("not-base64!!!")).toBeNull();
  });

  test("returns null for JSON that doesn't match the shape", () => {
    const bad = Buffer.from(JSON.stringify({ foo: "bar" })).toString("base64url");
    expect(decodeCursor(bad)).toBeNull();
  });

  test("returns null for invalid date", () => {
    const bad = Buffer.from(
      JSON.stringify({ createdAt: "not-a-date", id: "x" }),
    ).toString("base64url");
    expect(decodeCursor(bad)).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

Run: `cd apps/api && pnpm exec vitest run tests/pagination.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the helper**

```ts
// apps/api/src/lib/pagination.ts

// Opaque cursor carrying the last row's (createdAt, id) so the
// next page of `ORDER BY createdAt DESC, id DESC` picks up exactly
// where the previous one left off. We encode with base64url so it's
// URL-safe without extra encoding.

export interface Cursor {
  createdAt: Date;
  id: string;
}

export function encodeCursor(cursor: Cursor): string {
  const payload = JSON.stringify({
    createdAt: cursor.createdAt.toISOString(),
    id: cursor.id,
  });
  return Buffer.from(payload, "utf8").toString("base64url");
}

export function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  let json: unknown;
  try {
    json = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (
    !json ||
    typeof json !== "object" ||
    typeof (json as { createdAt?: unknown }).createdAt !== "string" ||
    typeof (json as { id?: unknown }).id !== "string"
  ) {
    return null;
  }
  const parsed = json as { createdAt: string; id: string };
  const createdAt = new Date(parsed.createdAt);
  if (Number.isNaN(createdAt.getTime())) return null;
  return { createdAt, id: parsed.id };
}
```

- [ ] **Step 4: Run the test and verify it passes**

Run: `cd apps/api && pnpm exec vitest run tests/pagination.test.ts`
Expected: PASS — 5/5.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/pagination.ts apps/api/tests/pagination.test.ts
git commit -m "$(cat <<'EOF'
feat(api): cursor pagination helper

Opaque base64url cursor carrying (createdAt, id) so ORDER BY
createdAt DESC, id DESC list endpoints can paginate without skew
when rows share a millisecond timestamp.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task A2: Shared dashboard request/response types

**Files:**
- Create: `packages/shared/src/dashboard.ts`
- Modify: `packages/shared/src/index.ts`

- [ ] **Step 1: Write the shared types**

```ts
// packages/shared/src/dashboard.ts

// =============================================================
// Types shared between the API (Zod-validated inputs + Prisma
// outputs) and the dashboard (TanStack Query hooks).
// Kept hand-written instead of inferred so the wire contract
// is explicit and safe to evolve.
// =============================================================

export type MemberRoleName = "OWNER" | "ADMIN" | "VIEWER";

export interface ProjectSummary {
  id: string;
  name: string;
  role: MemberRoleName;
  createdAt: string; // ISO
}

export interface ProjectDetail {
  id: string;
  name: string;
  webhookUrl: string | null;
  hasWebhookSecret: boolean;
  settings: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  counts: {
    subscribers: number;
    experiments: number;
    featureFlags: number;
    activeApiKeys: number;
  };
  apiKeys: Array<{
    id: string;
    prefix: string;
    type: "PUBLIC" | "SECRET";
    createdAt: string;
  }>;
}

export interface CreateProjectRequest {
  name: string;
}

export interface CreateProjectResponse {
  project: ProjectDetail;
  apiKeys: {
    publicKey: string; // plaintext, shown once
    secretKey: string; // plaintext, shown once
  };
}

export interface UpdateProjectRequest {
  name?: string;
  webhookUrl?: string | null;
  settings?: Record<string, unknown>;
}

export interface RotateWebhookSecretResponse {
  webhookSecret: string; // plaintext, shown once
}

export interface SubscriberListItem {
  id: string;
  appUserId: string;
  attributes: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string;
  purchaseCount: number;
  activeEntitlementKeys: string[];
}

export interface SubscriberListResponse {
  subscribers: SubscriberListItem[];
  nextCursor: string | null;
}

export interface SubscriberPurchase {
  id: string;
  productId: string;
  productIdentifier: string;
  store: "APP_STORE" | "PLAY_STORE" | "STRIPE";
  status: string;
  priceAmount: string | null;
  priceCurrency: string | null;
  purchaseDate: string;
  expiresDate: string | null;
  autoRenewStatus: boolean | null;
}

export interface SubscriberAccessRow {
  entitlementKey: string;
  isActive: boolean;
  expiresDate: string | null;
  store: "APP_STORE" | "PLAY_STORE" | "STRIPE";
  purchaseId: string;
}

export interface SubscriberCreditLedgerRow {
  id: string;
  type: string;
  amount: string;
  balance: string;
  referenceType: string | null;
  description: string | null;
  createdAt: string;
}

export interface SubscriberAssignment {
  experimentId: string;
  experimentKey: string;
  variantId: string;
  assignedAt: string;
  convertedAt: string | null;
  revenue: string | null;
}

export interface SubscriberOutgoingWebhook {
  id: string;
  eventType: string;
  url: string;
  status: string;
  attempts: number;
  createdAt: string;
  sentAt: string | null;
  lastErrorMessage: string | null;
}

export interface SubscriberDetail {
  id: string;
  appUserId: string;
  attributes: Record<string, unknown>;
  firstSeenAt: string;
  lastSeenAt: string;
  deletedAt: string | null;
  mergedInto: string | null;
  access: SubscriberAccessRow[];
  purchases: SubscriberPurchase[];
  creditBalance: string;
  creditLedger: SubscriberCreditLedgerRow[];
  assignments: SubscriberAssignment[];
  outgoingWebhooks: SubscriberOutgoingWebhook[];
}
```

- [ ] **Step 2: Re-export from the package entrypoint**

Open `packages/shared/src/index.ts` and append:

```ts
// =============================================================
// Dashboard API request/response types
// =============================================================

export * from "./dashboard";
```

- [ ] **Step 3: Verify the shared package type-checks**

Run: `cd packages/shared && pnpm exec tsc --noEmit`
Expected: clean exit.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/dashboard.ts packages/shared/src/index.ts
git commit -m "$(cat <<'EOF'
feat(shared): dashboard API request/response types

Hand-written wire contract for every Phase 1 dashboard endpoint
(projects CRUD, webhook-secret rotate, subscribers list/detail).
API route files import these so request validation schemas and
response shapes stay aligned with the frontend hooks.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task A3: `/dashboard/projects` — list + detail

**Files:**
- Create: `apps/api/src/routes/dashboard/projects.ts` (partial — list + detail only; POST, PATCH, rotate, DELETE land in Tasks A4–A5)
- Create: `apps/api/tests/dashboard-projects.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/tests/dashboard-projects.test.ts
import { beforeEach, describe, expect, test, vi } from "vitest";

const { prismaMock, authMock } = vi.hoisted(() => {
  const prismaMock = {
    projectMember: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
    },
    project: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    audience: {
      create: vi.fn(),
    },
    apiKey: {
      create: vi.fn(),
      findMany: vi.fn(async () => []),
    },
    subscriber: {
      count: vi.fn(async () => 0),
    },
    experiment: {
      count: vi.fn(async () => 0),
    },
    featureFlag: {
      count: vi.fn(async () => 0),
    },
    auditLog: {
      create: vi.fn(),
    },
    $transaction: vi.fn(async <T>(fn: (tx: unknown) => Promise<T>) => fn(prismaMock)),
  };
  const authMock = {
    api: {
      getSession: vi.fn(),
    },
  };
  return { prismaMock, authMock };
});

vi.mock("@rovenue/db", () => ({
  default: prismaMock,
  MemberRole: { OWNER: "OWNER", ADMIN: "ADMIN", VIEWER: "VIEWER" },
  ApiKeyType: { PUBLIC: "PUBLIC", SECRET: "SECRET" },
}));

vi.mock("../src/lib/auth", () => ({ auth: authMock }));

import { app } from "../src/app";

function signedIn(userId = "user_1") {
  authMock.api.getSession.mockResolvedValue({ user: { id: userId, email: "u@x" } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /dashboard/projects", () => {
  test("returns the caller's memberships with role", async () => {
    signedIn("user_1");
    prismaMock.projectMember.findMany.mockResolvedValue([
      {
        role: "OWNER",
        project: {
          id: "proj_1",
          name: "Acme",
          createdAt: new Date("2026-04-01T00:00:00Z"),
        },
      },
      {
        role: "VIEWER",
        project: {
          id: "proj_2",
          name: "Beta",
          createdAt: new Date("2026-04-10T00:00:00Z"),
        },
      },
    ]);

    const res = await app.request("/dashboard/projects");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { projects: Array<{ id: string; role: string }> } };
    expect(body.data.projects).toHaveLength(2);
    expect(body.data.projects[0]).toMatchObject({ id: "proj_1", role: "OWNER" });
    expect(body.data.projects[1]).toMatchObject({ id: "proj_2", role: "VIEWER" });
  });

  test("returns 401 when the session is missing", async () => {
    authMock.api.getSession.mockResolvedValue(null);
    const res = await app.request("/dashboard/projects");
    expect(res.status).toBe(401);
  });
});

describe("GET /dashboard/projects/:id", () => {
  test("returns project detail with counts + API key metadata", async () => {
    signedIn("user_1");
    prismaMock.projectMember.findUnique.mockResolvedValue({
      id: "pm_1",
      role: "OWNER",
    });
    prismaMock.project.findUnique.mockResolvedValue({
      id: "proj_1",
      name: "Acme",
      webhookUrl: "https://hook.example.com",
      webhookSecret: "topsecret",
      settings: {},
      createdAt: new Date("2026-04-01"),
      updatedAt: new Date("2026-04-10"),
    });
    prismaMock.apiKey.findMany.mockResolvedValue([
      {
        id: "k1",
        prefix: "rov_pk_abcd",
        type: "PUBLIC",
        revokedAt: null,
        createdAt: new Date("2026-04-01"),
      },
    ]);
    prismaMock.subscriber.count.mockResolvedValue(42);
    prismaMock.experiment.count.mockResolvedValue(3);
    prismaMock.featureFlag.count.mockResolvedValue(5);

    const res = await app.request("/dashboard/projects/proj_1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { project: { counts: Record<string, number>; hasWebhookSecret: boolean; apiKeys: Array<unknown> } } };
    expect(body.data.project.hasWebhookSecret).toBe(true);
    expect(body.data.project.counts).toEqual({
      subscribers: 42,
      experiments: 3,
      featureFlags: 5,
      activeApiKeys: 1,
    });
    expect(body.data.project.apiKeys).toHaveLength(1);
    // Plaintext never leaves the server.
    expect(JSON.stringify(body.data.project)).not.toContain("topsecret");
  });

  test("returns 403 when the user is not a member", async () => {
    signedIn("outsider");
    prismaMock.projectMember.findUnique.mockResolvedValue(null);
    const res = await app.request("/dashboard/projects/proj_1");
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd apps/api && pnpm exec vitest run tests/dashboard-projects.test.ts`
Expected: FAIL — route not registered (404) or module not found.

- [ ] **Step 3: Scaffold the route file with list + detail**

```ts
// apps/api/src/routes/dashboard/projects.ts
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import prisma, { MemberRole } from "@rovenue/db";
import type { ProjectDetail, ProjectSummary } from "@rovenue/shared";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { ok } from "../../lib/response";

export const projectsRoute = new Hono();

projectsRoute.use("*", requireDashboardAuth);

// ----- GET /dashboard/projects -----
projectsRoute.get("/", async (c) => {
  const user = c.get("user");
  const memberships = await prisma.projectMember.findMany({
    where: { userId: user.id },
    include: { project: true },
    orderBy: { createdAt: "desc" },
  });
  const projects: ProjectSummary[] = memberships.map((m) => ({
    id: m.project.id,
    name: m.project.name,
    role: m.role,
    createdAt: m.project.createdAt.toISOString(),
  }));
  return c.json(ok({ projects }));
});

// ----- GET /dashboard/projects/:id -----
projectsRoute.get("/:id", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  await assertProjectAccess(id, user.id, MemberRole.VIEWER);

  const [project, apiKeys, subscribers, experiments, featureFlags] = await Promise.all([
    prisma.project.findUnique({ where: { id } }),
    prisma.apiKey.findMany({
      where: { projectId: id, revokedAt: null },
      orderBy: { createdAt: "asc" },
      select: { id: true, prefix: true, type: true, createdAt: true },
    }),
    prisma.subscriber.count({ where: { projectId: id, deletedAt: null } }),
    prisma.experiment.count({ where: { projectId: id } }),
    prisma.featureFlag.count({ where: { projectId: id } }),
  ]);

  if (!project) {
    throw new HTTPException(404, { message: "Project not found" });
  }

  const payload: ProjectDetail = {
    id: project.id,
    name: project.name,
    webhookUrl: project.webhookUrl,
    hasWebhookSecret: Boolean(project.webhookSecret),
    settings: (project.settings as Record<string, unknown> | null) ?? {},
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    counts: {
      subscribers,
      experiments,
      featureFlags,
      activeApiKeys: apiKeys.length,
    },
    apiKeys: apiKeys.map((k) => ({
      id: k.id,
      prefix: k.prefix,
      type: k.type,
      createdAt: k.createdAt.toISOString(),
    })),
  };

  return c.json(ok({ project: payload }));
});
```

- [ ] **Step 4: Mount the route group**

Open `apps/api/src/routes/dashboard/index.ts` and add the import + mount:

```ts
import { projectsRoute } from "./projects";
// ... existing imports ...

// ... existing mounts ...
dashboardRoute.route("/projects", projectsRoute);
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `cd apps/api && pnpm exec vitest run tests/dashboard-projects.test.ts`
Expected: PASS — 4/4 (the POST/PATCH tests will be added in later tasks).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/dashboard/projects.ts apps/api/src/routes/dashboard/index.ts apps/api/tests/dashboard-projects.test.ts
git commit -m "$(cat <<'EOF'
feat(api): dashboard projects list + detail endpoints

GET /dashboard/projects returns the caller's memberships scoped
through ProjectMember. GET /dashboard/projects/:id returns the
project record plus counts (subscribers, experiments, feature
flags, active API keys) and redacted webhookSecret presence flag.
Plaintext secrets never leave the server.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task A4: `POST /dashboard/projects` — create with defaults

**Files:**
- Modify: `apps/api/src/routes/dashboard/projects.ts`
- Modify: `apps/api/tests/dashboard-projects.test.ts`

Creating a project must atomically: insert the `Project` row, add the caller as `OWNER` in `ProjectMember`, create the "All Users" default audience, and mint one public + one secret API key. All inside a single Prisma `$transaction`. The plaintext API keys + webhookSecret are returned once in the response.

- [ ] **Step 1: Write the failing test**

Append to `apps/api/tests/dashboard-projects.test.ts`:

```ts
describe("POST /dashboard/projects", () => {
  test("creates project + owner membership + default audience + both API keys atomically", async () => {
    signedIn("user_1");
    prismaMock.project.create.mockResolvedValue({
      id: "proj_new",
      name: "Alpha",
      webhookUrl: null,
      webhookSecret: null,
      settings: {},
      createdAt: new Date("2026-04-18"),
      updatedAt: new Date("2026-04-18"),
    });
    prismaMock.projectMember.create.mockResolvedValue({ id: "pm_new", role: "OWNER" });
    prismaMock.audience.create.mockResolvedValue({ id: "aud_default", isDefault: true });
    prismaMock.apiKey.create
      .mockResolvedValueOnce({
        id: "k_pub",
        prefix: "rov_pk_abcd",
        type: "PUBLIC",
        createdAt: new Date("2026-04-18"),
      })
      .mockResolvedValueOnce({
        id: "k_sec",
        prefix: "rov_sk_wxyz",
        type: "SECRET",
        createdAt: new Date("2026-04-18"),
      });
    prismaMock.apiKey.findMany.mockResolvedValue([
      {
        id: "k_pub",
        prefix: "rov_pk_abcd",
        type: "PUBLIC",
        revokedAt: null,
        createdAt: new Date("2026-04-18"),
      },
      {
        id: "k_sec",
        prefix: "rov_sk_wxyz",
        type: "SECRET",
        revokedAt: null,
        createdAt: new Date("2026-04-18"),
      },
    ]);

    const res = await app.request("/dashboard/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Alpha" }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        project: { id: string; name: string };
        apiKeys: { publicKey: string; secretKey: string };
      };
    };
    expect(body.data.project.id).toBe("proj_new");
    expect(body.data.apiKeys.publicKey).toMatch(/^rov_pk_/);
    expect(body.data.apiKeys.secretKey).toMatch(/^rov_sk_/);

    expect(prismaMock.$transaction).toHaveBeenCalledTimes(1);
    expect(prismaMock.project.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.projectMember.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ role: "OWNER", userId: "user_1" }) }),
    );
    expect(prismaMock.audience.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ isDefault: true, name: "All Users" }) }),
    );
    expect(prismaMock.apiKey.create).toHaveBeenCalledTimes(2);
  });

  test("returns 400 when name is missing or empty", async () => {
    signedIn("user_1");
    const res = await app.request("/dashboard/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd apps/api && pnpm exec vitest run tests/dashboard-projects.test.ts`
Expected: FAIL — POST handler not registered.

- [ ] **Step 3: Implement the POST handler**

Add imports to `apps/api/src/routes/dashboard/projects.ts`:

```ts
import { z } from "zod";
import { randomBytes, createHash } from "node:crypto";
import { ApiKeyType } from "@rovenue/db";
import type { CreateProjectResponse } from "@rovenue/shared";
```

Add helpers near the top of the file (below imports):

```ts
const createSchema = z.object({
  name: z.string().min(2).max(80),
});

// API key format: rov_{pk|sk}_{12 url-safe chars} + 32 secret chars.
// We store sha256(secret) and show the full plaintext once.
function mintApiKey(type: "PUBLIC" | "SECRET"): {
  prefix: string;
  plaintext: string;
  hashed: string;
} {
  const label = type === "PUBLIC" ? "pk" : "sk";
  const prefixTail = randomBytes(6).toString("base64url").slice(0, 12);
  const prefix = `rov_${label}_${prefixTail}`;
  const secret = randomBytes(24).toString("base64url");
  const plaintext = `${prefix}_${secret}`;
  const hashed = createHash("sha256").update(plaintext).digest("hex");
  return { prefix, plaintext, hashed };
}
```

Add the POST handler (below the GET list route):

```ts
// ----- POST /dashboard/projects -----
projectsRoute.post("/", async (c) => {
  const body = createSchema.parse(await c.req.json());
  const user = c.get("user");

  const pub = mintApiKey("PUBLIC");
  const sec = mintApiKey("SECRET");

  const result = await prisma.$transaction(async (tx) => {
    const project = await tx.project.create({
      data: { name: body.name, settings: {} },
    });
    await tx.projectMember.create({
      data: { projectId: project.id, userId: user.id, role: MemberRole.OWNER },
    });
    await tx.audience.create({
      data: {
        projectId: project.id,
        name: "All Users",
        description: "Matches every subscriber",
        rules: {},
        isDefault: true,
      },
    });
    await tx.apiKey.create({
      data: {
        projectId: project.id,
        type: ApiKeyType.PUBLIC,
        prefix: pub.prefix,
        hashedKey: pub.hashed,
      },
    });
    await tx.apiKey.create({
      data: {
        projectId: project.id,
        type: ApiKeyType.SECRET,
        prefix: sec.prefix,
        hashedKey: sec.hashed,
      },
    });
    return project;
  });

  // Re-read detail shape so the response matches GET /:id.
  const apiKeys = await prisma.apiKey.findMany({
    where: { projectId: result.id, revokedAt: null },
    orderBy: { createdAt: "asc" },
    select: { id: true, prefix: true, type: true, createdAt: true },
  });

  const payload: CreateProjectResponse = {
    project: {
      id: result.id,
      name: result.name,
      webhookUrl: result.webhookUrl,
      hasWebhookSecret: false,
      settings: (result.settings as Record<string, unknown> | null) ?? {},
      createdAt: result.createdAt.toISOString(),
      updatedAt: result.updatedAt.toISOString(),
      counts: { subscribers: 0, experiments: 0, featureFlags: 0, activeApiKeys: apiKeys.length },
      apiKeys: apiKeys.map((k) => ({
        id: k.id,
        prefix: k.prefix,
        type: k.type,
        createdAt: k.createdAt.toISOString(),
      })),
    },
    apiKeys: {
      publicKey: pub.plaintext,
      secretKey: sec.plaintext,
    },
  };

  return c.json(ok(payload));
});
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd apps/api && pnpm exec vitest run tests/dashboard-projects.test.ts`
Expected: PASS — both new cases.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/dashboard/projects.ts apps/api/tests/dashboard-projects.test.ts
git commit -m "$(cat <<'EOF'
feat(api): POST /dashboard/projects with atomic defaults

Creating a project now wires the caller as OWNER, seeds the All
Users default audience, and mints one PUBLIC + one SECRET API key
inside a single Prisma transaction. Plaintext keys are returned
once; only sha256 hashes persist.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task A5: Project update + rotate webhook secret + delete

**Files:**
- Modify: `apps/api/src/routes/dashboard/projects.ts`
- Modify: `apps/api/tests/dashboard-projects.test.ts`

- [ ] **Step 1: Write the failing tests**

Append to `apps/api/tests/dashboard-projects.test.ts`:

```ts
describe("PATCH /dashboard/projects/:id", () => {
  test("requires ADMIN role — VIEWER gets 403", async () => {
    signedIn("viewer");
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm_1", role: "VIEWER" });
    const res = await app.request("/dashboard/projects/proj_1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "New Name" }),
    });
    expect(res.status).toBe(403);
  });

  test("ADMIN can rename and update webhookUrl", async () => {
    signedIn("admin");
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm_1", role: "ADMIN" });
    prismaMock.project.update.mockResolvedValue({
      id: "proj_1",
      name: "Renamed",
      webhookUrl: "https://new.example.com",
      webhookSecret: null,
      settings: {},
      createdAt: new Date("2026-04-01"),
      updatedAt: new Date(),
    });
    prismaMock.apiKey.findMany.mockResolvedValue([]);
    prismaMock.subscriber.count.mockResolvedValue(0);
    prismaMock.experiment.count.mockResolvedValue(0);
    prismaMock.featureFlag.count.mockResolvedValue(0);

    const res = await app.request("/dashboard/projects/proj_1", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "Renamed", webhookUrl: "https://new.example.com" }),
    });
    expect(res.status).toBe(200);
    expect(prismaMock.project.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: "proj_1" },
        data: expect.objectContaining({ name: "Renamed", webhookUrl: "https://new.example.com" }),
      }),
    );
    expect(prismaMock.auditLog.create).toHaveBeenCalled();
  });
});

describe("POST /dashboard/projects/:id/webhook-secret/rotate", () => {
  test("requires OWNER", async () => {
    signedIn("admin");
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm_1", role: "ADMIN" });
    const res = await app.request("/dashboard/projects/proj_1/webhook-secret/rotate", {
      method: "POST",
    });
    expect(res.status).toBe(403);
  });

  test("OWNER rotates the secret and audit entry is redacted", async () => {
    signedIn("owner");
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm_1", role: "OWNER" });
    prismaMock.project.update.mockResolvedValue({
      id: "proj_1",
      webhookSecret: "new_secret_placeholder",
    });

    const res = await app.request("/dashboard/projects/proj_1/webhook-secret/rotate", {
      method: "POST",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { webhookSecret: string } };
    expect(body.data.webhookSecret).toMatch(/^whsec_/);

    const auditCall = prismaMock.auditLog.create.mock.calls[0]?.[0] as {
      data: { before: unknown; after: unknown };
    };
    expect(auditCall.data.before).toEqual({ webhookSecret: "[REDACTED]" });
    expect(auditCall.data.after).toEqual({ webhookSecret: "[REDACTED]" });
  });
});

describe("DELETE /dashboard/projects/:id", () => {
  test("requires OWNER", async () => {
    signedIn("admin");
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm_1", role: "ADMIN" });
    const res = await app.request("/dashboard/projects/proj_1", { method: "DELETE" });
    expect(res.status).toBe(403);
  });

  test("OWNER deletes the project", async () => {
    signedIn("owner");
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm_1", role: "OWNER" });
    prismaMock.project.delete.mockResolvedValue({ id: "proj_1" });
    const res = await app.request("/dashboard/projects/proj_1", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(prismaMock.project.delete).toHaveBeenCalledWith({ where: { id: "proj_1" } });
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd apps/api && pnpm exec vitest run tests/dashboard-projects.test.ts`
Expected: FAIL — PATCH / rotate / DELETE handlers not registered.

- [ ] **Step 3: Implement the handlers**

Add imports (if missing) to `apps/api/src/routes/dashboard/projects.ts`:

```ts
import { audit, redactCredentials, extractRequestContext } from "../../lib/audit";
import type { RotateWebhookSecretResponse } from "@rovenue/shared";
```

Add schemas near the other schemas:

```ts
const updateSchema = z.object({
  name: z.string().min(2).max(80).optional(),
  webhookUrl: z.string().url().nullable().optional(),
  settings: z.record(z.unknown()).optional(),
});
```

Add the PATCH, rotate, and DELETE handlers below the POST handler:

```ts
// ----- PATCH /dashboard/projects/:id -----
projectsRoute.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  await assertProjectAccess(id, user.id, MemberRole.ADMIN);

  const body = updateSchema.parse(await c.req.json());
  const before = await prisma.project.findUnique({
    where: { id },
    select: { name: true, webhookUrl: true, settings: true },
  });
  if (!before) throw new HTTPException(404, { message: "Project not found" });

  const project = await prisma.project.update({
    where: { id },
    data: {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.webhookUrl !== undefined && { webhookUrl: body.webhookUrl }),
      ...(body.settings !== undefined && { settings: body.settings }),
    },
  });

  await audit({
    projectId: id,
    userId: user.id,
    action: "project.updated",
    resource: "project",
    resourceId: id,
    before: before as Record<string, unknown>,
    after: body as Record<string, unknown>,
    ...extractRequestContext(c),
  });

  return c.json(ok({ project: { id: project.id, name: project.name } }));
});

// ----- POST /dashboard/projects/:id/webhook-secret/rotate -----
projectsRoute.post("/:id/webhook-secret/rotate", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  await assertProjectAccess(id, user.id, MemberRole.OWNER);

  const webhookSecret = `whsec_${randomBytes(32).toString("base64url")}`;
  await prisma.project.update({
    where: { id },
    data: { webhookSecret },
  });

  await audit({
    projectId: id,
    userId: user.id,
    action: "credential.updated",
    resource: "credential",
    resourceId: id,
    before: redactCredentials({ webhookSecret: "*" }),
    after: redactCredentials({ webhookSecret: "*" }),
    ...extractRequestContext(c),
  });

  const payload: RotateWebhookSecretResponse = { webhookSecret };
  return c.json(ok(payload));
});

// ----- DELETE /dashboard/projects/:id -----
projectsRoute.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  await assertProjectAccess(id, user.id, MemberRole.OWNER);

  // Audit first so the row has a projectId fk that still exists.
  await audit({
    projectId: id,
    userId: user.id,
    action: "project.deleted",
    resource: "project",
    resourceId: id,
    ...extractRequestContext(c),
  });

  await prisma.project.delete({ where: { id } });

  return c.json(ok({ id }));
});
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd apps/api && pnpm exec vitest run tests/dashboard-projects.test.ts`
Expected: PASS — every case.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/dashboard/projects.ts apps/api/tests/dashboard-projects.test.ts
git commit -m "$(cat <<'EOF'
feat(api): dashboard project PATCH + webhook rotate + DELETE

PATCH is ADMIN+, webhook-secret rotation and DELETE are OWNER.
Every mutation writes an awaited audit entry; credential mutations
redact both before and after snapshots so cleartext secrets never
reach audit_logs.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task A6: `/dashboard/projects/:projectId/subscribers` — list with cursor + search

**Files:**
- Create: `apps/api/src/routes/dashboard/subscribers.ts` (list handler only; detail in Task A7)
- Create: `apps/api/tests/dashboard-subscribers.test.ts`
- Modify: `apps/api/src/routes/dashboard/index.ts` — mount

- [ ] **Step 1: Write the failing tests**

```ts
// apps/api/tests/dashboard-subscribers.test.ts
import { beforeEach, describe, expect, test, vi } from "vitest";

const { prismaMock, authMock } = vi.hoisted(() => {
  const prismaMock = {
    projectMember: { findUnique: vi.fn() },
    subscriber: {
      findMany: vi.fn(async () => []),
      findUnique: vi.fn(),
      count: vi.fn(async () => 0),
    },
    purchase: {
      findMany: vi.fn(async () => []),
      groupBy: vi.fn(async () => []),
    },
    subscriberAccess: { findMany: vi.fn(async () => []) },
    creditLedger: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(),
    },
    experimentAssignment: { findMany: vi.fn(async () => []) },
    outgoingWebhook: { findMany: vi.fn(async () => []) },
  };
  const authMock = { api: { getSession: vi.fn() } };
  return { prismaMock, authMock };
});

vi.mock("@rovenue/db", () => ({
  default: prismaMock,
  MemberRole: { OWNER: "OWNER", ADMIN: "ADMIN", VIEWER: "VIEWER" },
}));
vi.mock("../src/lib/auth", () => ({ auth: authMock }));

import { app } from "../src/app";

function signedIn(userId = "user_1") {
  authMock.api.getSession.mockResolvedValue({ user: { id: userId, email: "u@x" } });
}

beforeEach(() => vi.clearAllMocks());

describe("GET /dashboard/projects/:projectId/subscribers", () => {
  test("forbidden when the user is not a project member", async () => {
    signedIn("outsider");
    prismaMock.projectMember.findUnique.mockResolvedValue(null);
    const res = await app.request("/dashboard/projects/proj_1/subscribers");
    expect(res.status).toBe(403);
  });

  test("returns a page + nextCursor when more rows exist", async () => {
    signedIn("user_1");
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "VIEWER" });

    const rows = Array.from({ length: 51 }, (_, i) => ({
      id: `sub_${i}`,
      appUserId: `user_${i}`,
      attributes: {},
      firstSeenAt: new Date("2026-04-10"),
      lastSeenAt: new Date(`2026-04-${10 + (i % 8)}`),
      createdAt: new Date(`2026-04-${10 + (i % 8)}T12:00:00Z`),
      _count: { purchases: 0 },
      access: [],
    }));
    // findMany is called with take: limit + 1 to detect "more"; return 51 when limit=50.
    prismaMock.subscriber.findMany.mockResolvedValue(rows);

    const res = await app.request("/dashboard/projects/proj_1/subscribers?limit=50");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { subscribers: Array<{ id: string }>; nextCursor: string | null };
    };
    expect(body.data.subscribers).toHaveLength(50);
    expect(body.data.nextCursor).not.toBeNull();
  });

  test("hides soft-deleted subscribers", async () => {
    signedIn("user_1");
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "VIEWER" });
    prismaMock.subscriber.findMany.mockResolvedValue([]);

    await app.request("/dashboard/projects/proj_1/subscribers");
    const call = prismaMock.subscriber.findMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
    };
    expect(call.where).toMatchObject({ projectId: "proj_1", deletedAt: null });
  });

  test("applies ILIKE search on appUserId + attributes when ?q is set", async () => {
    signedIn("user_1");
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "VIEWER" });
    prismaMock.subscriber.findMany.mockResolvedValue([]);

    await app.request("/dashboard/projects/proj_1/subscribers?q=alice");
    const call = prismaMock.subscriber.findMany.mock.calls[0]?.[0] as {
      where: Record<string, unknown>;
    };
    expect(JSON.stringify(call.where)).toContain("alice");
    expect(JSON.stringify(call.where)).toContain("insensitive");
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd apps/api && pnpm exec vitest run tests/dashboard-subscribers.test.ts`
Expected: FAIL — route not registered.

- [ ] **Step 3: Implement the route**

```ts
// apps/api/src/routes/dashboard/subscribers.ts
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import prisma, { MemberRole, type Prisma } from "@rovenue/db";
import type { SubscriberListItem, SubscriberListResponse } from "@rovenue/shared";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { ok } from "../../lib/response";
import { encodeCursor, decodeCursor } from "../../lib/pagination";

export const subscribersRoute = new Hono();

subscribersRoute.use("*", requireDashboardAuth);

const listQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  q: z.string().trim().min(1).max(200).optional(),
});

subscribersRoute.get("/", async (c) => {
  const projectId = c.req.param("projectId");
  const user = c.get("user");
  await assertProjectAccess(projectId, user.id, MemberRole.VIEWER);

  const query = listQuerySchema.parse({
    cursor: c.req.query("cursor"),
    limit: c.req.query("limit"),
    q: c.req.query("q"),
  });

  const cursor = decodeCursor(query.cursor);
  const where: Prisma.SubscriberWhereInput = {
    projectId,
    deletedAt: null,
  };

  if (query.q) {
    where.OR = [
      { appUserId: { contains: query.q, mode: "insensitive" } },
      {
        attributes: {
          // Prisma's JSON string_contains is case-sensitive; fall back to
          // a raw text cast + ILIKE via `path: []` + `string_contains`.
          string_contains: query.q,
        } as Prisma.JsonFilter,
      },
    ];
  }

  if (cursor) {
    // (createdAt, id) is unique-ish and monotone; build a strict "less than"
    // comparator matching ORDER BY createdAt DESC, id DESC.
    where.OR = [
      ...(where.OR ?? []),
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ];
  }

  const rows = await prisma.subscriber.findMany({
    where,
    take: query.limit + 1,
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    include: {
      _count: { select: { purchases: true } },
      access: {
        where: { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
        select: { entitlementKey: true },
      },
    },
  });

  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;
  const last = page[page.length - 1];
  const nextCursor = hasMore && last
    ? encodeCursor({ createdAt: last.createdAt, id: last.id })
    : null;

  const subscribers: SubscriberListItem[] = page.map((s) => ({
    id: s.id,
    appUserId: s.appUserId,
    attributes: (s.attributes as Record<string, unknown> | null) ?? {},
    firstSeenAt: s.firstSeenAt.toISOString(),
    lastSeenAt: s.lastSeenAt.toISOString(),
    purchaseCount: s._count.purchases,
    activeEntitlementKeys: [
      ...new Set(s.access.map((a: { entitlementKey: string }) => a.entitlementKey)),
    ],
  }));

  const response: SubscriberListResponse = { subscribers, nextCursor };
  return c.json(ok(response));
});
```

- [ ] **Step 4: Mount the route**

In `apps/api/src/routes/dashboard/index.ts`:

```ts
import { subscribersRoute } from "./subscribers";
// ...
dashboardRoute.route("/projects/:projectId/subscribers", subscribersRoute);
```

- [ ] **Step 5: Run the tests and verify they pass**

Run: `cd apps/api && pnpm exec vitest run tests/dashboard-subscribers.test.ts`
Expected: PASS — 4/4.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/dashboard/subscribers.ts apps/api/src/routes/dashboard/index.ts apps/api/tests/dashboard-subscribers.test.ts
git commit -m "$(cat <<'EOF'
feat(api): dashboard subscribers list with cursor pagination + search

GET /dashboard/projects/:projectId/subscribers paginates via opaque
(createdAt, id) cursors, supports ILIKE search over appUserId and
attributes, and filters out soft-deleted rows. Includes purchase
count and active entitlement keys per row so the list view can
render without a follow-up fetch.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task A7: Subscriber detail endpoint

**Files:**
- Modify: `apps/api/src/routes/dashboard/subscribers.ts`
- Modify: `apps/api/tests/dashboard-subscribers.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `apps/api/tests/dashboard-subscribers.test.ts`:

```ts
describe("GET /dashboard/projects/:projectId/subscribers/:id", () => {
  test("forbidden when not a member", async () => {
    signedIn("outsider");
    prismaMock.projectMember.findUnique.mockResolvedValue(null);
    const res = await app.request("/dashboard/projects/proj_1/subscribers/sub_1");
    expect(res.status).toBe(403);
  });

  test("returns 404 when subscriber isn't in project", async () => {
    signedIn("user_1");
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "VIEWER" });
    prismaMock.subscriber.findUnique.mockResolvedValue(null);
    const res = await app.request("/dashboard/projects/proj_1/subscribers/sub_missing");
    expect(res.status).toBe(404);
  });

  test("assembles subscriber + purchases + access + ledger + assignments + webhooks", async () => {
    signedIn("user_1");
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "VIEWER" });
    prismaMock.subscriber.findUnique.mockResolvedValue({
      id: "sub_1",
      projectId: "proj_1",
      appUserId: "user_abc",
      attributes: { country: "TR" },
      firstSeenAt: new Date("2026-04-01"),
      lastSeenAt: new Date("2026-04-18"),
      deletedAt: null,
      mergedInto: null,
    });
    prismaMock.purchase.findMany.mockResolvedValue([
      {
        id: "pur_1",
        productId: "prod_1",
        product: { identifier: "pro_monthly" },
        store: "APP_STORE",
        status: "ACTIVE",
        priceAmount: "9.99",
        priceCurrency: "USD",
        purchaseDate: new Date("2026-04-10"),
        expiresDate: new Date("2026-05-10"),
        autoRenewStatus: true,
      },
    ]);
    prismaMock.subscriberAccess.findMany.mockResolvedValue([
      { entitlementKey: "premium", isActive: true, expiresDate: null, store: "APP_STORE", purchaseId: "pur_1" },
    ]);
    prismaMock.creditLedger.findFirst.mockResolvedValue({ balance: "42" });
    prismaMock.creditLedger.findMany.mockResolvedValue([
      {
        id: "led_1",
        type: "PURCHASE",
        amount: "100",
        balance: "100",
        referenceType: "purchase",
        description: null,
        createdAt: new Date("2026-04-12"),
      },
    ]);
    prismaMock.experimentAssignment.findMany.mockResolvedValue([
      {
        experimentId: "exp_1",
        variantId: "v_a",
        assignedAt: new Date("2026-04-12"),
        convertedAt: null,
        revenue: null,
        experiment: { key: "paywall_test" },
      },
    ]);
    prismaMock.outgoingWebhook.findMany.mockResolvedValue([
      {
        id: "ow_1",
        eventType: "purchase",
        url: "https://example.com/hook",
        status: "SENT",
        attempts: 1,
        createdAt: new Date("2026-04-12"),
        sentAt: new Date("2026-04-12"),
        lastErrorMessage: null,
      },
    ]);

    const res = await app.request("/dashboard/projects/proj_1/subscribers/sub_1");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { subscriber: Record<string, unknown> } };
    const s = body.data.subscriber as Record<string, unknown>;
    expect(s.appUserId).toBe("user_abc");
    expect(Array.isArray(s.purchases)).toBe(true);
    expect(Array.isArray(s.access)).toBe(true);
    expect(s.creditBalance).toBe("42");
    expect(Array.isArray(s.assignments)).toBe(true);
    expect(Array.isArray(s.outgoingWebhooks)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the tests and verify they fail**

Run: `cd apps/api && pnpm exec vitest run tests/dashboard-subscribers.test.ts`
Expected: FAIL — detail handler not registered.

- [ ] **Step 3: Implement the detail handler**

Add the import to `apps/api/src/routes/dashboard/subscribers.ts`:

```ts
import type { SubscriberDetail } from "@rovenue/shared";
```

Append the handler:

```ts
subscribersRoute.get("/:id", async (c) => {
  const projectId = c.req.param("projectId");
  const id = c.req.param("id");
  const user = c.get("user");
  await assertProjectAccess(projectId, user.id, MemberRole.VIEWER);

  const subscriber = await prisma.subscriber.findUnique({
    where: { id },
    select: {
      id: true,
      projectId: true,
      appUserId: true,
      attributes: true,
      firstSeenAt: true,
      lastSeenAt: true,
      deletedAt: true,
      mergedInto: true,
    },
  });
  if (!subscriber || subscriber.projectId !== projectId) {
    throw new HTTPException(404, { message: "Subscriber not found" });
  }

  const [purchases, access, latestLedger, ledger, assignments, outgoingWebhooks] =
    await Promise.all([
      prisma.purchase.findMany({
        where: { subscriberId: id },
        orderBy: { purchaseDate: "desc" },
        take: 50,
        include: { product: { select: { identifier: true } } },
      }),
      prisma.subscriberAccess.findMany({
        where: { subscriberId: id },
        orderBy: { entitlementKey: "asc" },
      }),
      prisma.creditLedger.findFirst({
        where: { subscriberId: id },
        orderBy: { createdAt: "desc" },
        select: { balance: true },
      }),
      prisma.creditLedger.findMany({
        where: { subscriberId: id },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
      prisma.experimentAssignment.findMany({
        where: { subscriberId: id },
        orderBy: { assignedAt: "desc" },
        include: { experiment: { select: { key: true } } },
      }),
      prisma.outgoingWebhook.findMany({
        where: { subscriberId: id },
        orderBy: { createdAt: "desc" },
        take: 20,
      }),
    ]);

  const payload: SubscriberDetail = {
    id: subscriber.id,
    appUserId: subscriber.appUserId,
    attributes: (subscriber.attributes as Record<string, unknown> | null) ?? {},
    firstSeenAt: subscriber.firstSeenAt.toISOString(),
    lastSeenAt: subscriber.lastSeenAt.toISOString(),
    deletedAt: subscriber.deletedAt?.toISOString() ?? null,
    mergedInto: subscriber.mergedInto,
    access: access.map((a) => ({
      entitlementKey: a.entitlementKey,
      isActive: a.isActive,
      expiresDate: a.expiresDate?.toISOString() ?? null,
      store: a.store,
      purchaseId: a.purchaseId,
    })),
    purchases: purchases.map((p) => ({
      id: p.id,
      productId: p.productId,
      productIdentifier: p.product.identifier,
      store: p.store,
      status: p.status,
      priceAmount: p.priceAmount?.toString() ?? null,
      priceCurrency: p.priceCurrency,
      purchaseDate: p.purchaseDate.toISOString(),
      expiresDate: p.expiresDate?.toISOString() ?? null,
      autoRenewStatus: p.autoRenewStatus,
    })),
    creditBalance: latestLedger?.balance.toString() ?? "0",
    creditLedger: ledger.map((l) => ({
      id: l.id,
      type: l.type,
      amount: l.amount.toString(),
      balance: l.balance.toString(),
      referenceType: l.referenceType,
      description: l.description,
      createdAt: l.createdAt.toISOString(),
    })),
    assignments: assignments.map((a) => ({
      experimentId: a.experimentId,
      experimentKey: a.experiment.key,
      variantId: a.variantId,
      assignedAt: a.assignedAt.toISOString(),
      convertedAt: a.convertedAt?.toISOString() ?? null,
      revenue: a.revenue?.toString() ?? null,
    })),
    outgoingWebhooks: outgoingWebhooks.map((w) => ({
      id: w.id,
      eventType: w.eventType,
      url: w.url,
      status: w.status,
      attempts: w.attempts,
      createdAt: w.createdAt.toISOString(),
      sentAt: w.sentAt?.toISOString() ?? null,
      lastErrorMessage: w.lastErrorMessage,
    })),
  };

  return c.json(ok({ subscriber: payload }));
});
```

- [ ] **Step 4: Run the tests and verify they pass**

Run: `cd apps/api && pnpm exec vitest run tests/dashboard-subscribers.test.ts`
Expected: PASS — 7 cases total across this file.

- [ ] **Step 5: Run the full API test suite**

Run: `cd apps/api && pnpm exec vitest run`
Expected: every prior test file still passes.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/dashboard/subscribers.ts apps/api/tests/dashboard-subscribers.test.ts
git commit -m "$(cat <<'EOF'
feat(api): dashboard subscriber detail endpoint

GET /dashboard/projects/:projectId/subscribers/:id fans out via
Promise.all to gather active access, last 50 purchases, credit
balance + last 20 ledger entries, experiment assignments, and the
last 20 outgoing webhooks in a single response. Cross-project
lookups 404 explicitly.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

# Part B — Frontend

## Task B1: Upgrade dashboard dependencies

**Files:**
- Modify: `apps/dashboard/package.json`
- Modify: `pnpm-lock.yaml` (auto-regenerated)

- [ ] **Step 1: Rewrite package.json**

Replace `apps/dashboard/package.json` with:

```json
{
  "name": "@rovenue/dashboard",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview",
    "test": "vitest"
  },
  "dependencies": {
    "@heroui/react": "^3.0.3",
    "@rovenue/shared": "workspace:*",
    "@tanstack/react-query": "^5.59.0",
    "@tanstack/react-router": "^1.130.0",
    "@tanstack/react-table": "^8.20.0",
    "better-auth": "^1.0.0",
    "framer-motion": "^11.5.0",
    "next-themes": "^0.4.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0"
  },
  "devDependencies": {
    "@tailwindcss/vite": "^4.0.0",
    "@tanstack/router-plugin": "^1.130.0",
    "@testing-library/jest-dom": "^6.6.0",
    "@testing-library/react": "^16.1.0",
    "@testing-library/user-event": "^14.5.0",
    "@types/react": "^19.0.0",
    "@types/react-dom": "^19.0.0",
    "@vitejs/plugin-react": "^4.3.0",
    "jsdom": "^25.0.0",
    "msw": "^2.6.0",
    "tailwindcss": "^4.0.0",
    "typescript": "^5.4.0",
    "vite": "^5.1.0",
    "vitest": "^1.3.0"
  }
}
```

Rationale on the few non-obvious picks:
- `framer-motion` is a Hero UI 3 peer (used by its transitions).
- `jsdom` is Vitest's default browser env and we need it explicitly when the root project doesn't pin one.
- `@tanstack/router-plugin` is the Vite plugin that generates the type-safe `routeTree.gen.ts`.

- [ ] **Step 2: Reinstall**

Run: `pnpm install`
Expected: install succeeds (peer warnings from react-native 0.85 on root are pre-existing, ignore).

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/package.json pnpm-lock.yaml
git commit -m "$(cat <<'EOF'
chore(dashboard): upgrade to React 19 + Hero UI 3 + Tailwind 4 + TanStack

Pins the Phase 1 stack: React 19 (required by Hero UI 3), Tailwind
4 (CSS-first config), Hero UI 3.0.3, TanStack Router/Query/Table,
Better Auth client, next-themes, MSW, Testing Library. Resolves
existing pnpm peer warnings from packages/sdk-rn which already
targeted React 19.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task B2: Vite / Vitest / TypeScript configuration

**Files:**
- Modify: `apps/dashboard/vite.config.ts`
- Modify: `apps/dashboard/tsconfig.json`
- Create: `apps/dashboard/vitest.config.ts`
- Create: `apps/dashboard/src/index.css`
- Create: `apps/dashboard/tests/setup.ts`

- [ ] **Step 1: Rewrite `vite.config.ts`**

```ts
// apps/dashboard/vite.config.ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";

export default defineConfig({
  plugins: [
    TanStackRouterVite({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  server: { port: 5173 },
});
```

- [ ] **Step 2: Create `vitest.config.ts`**

```ts
// apps/dashboard/vitest.config.ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./tests/setup.ts"],
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx", "src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
```

- [ ] **Step 3: Rewrite `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": true,
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "skipLibCheck": true,
    "moduleResolution": "bundler",
    "allowImportingTsExtensions": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "react-jsx",
    "strict": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noFallthroughCasesInSwitch": true,
    "types": ["vitest/globals", "@testing-library/jest-dom"]
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 4: Create Tailwind v4 entrypoint**

```css
/* apps/dashboard/src/index.css */
@import "tailwindcss";

@plugin "@heroui/react";

@theme {
  --color-brand-500: oklch(0.66 0.19 151);
  --color-brand-600: oklch(0.57 0.19 151);
}
```

- [ ] **Step 5: Create `tests/setup.ts`**

```ts
// apps/dashboard/tests/setup.ts
import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll } from "vitest";
import { server } from "./msw/server";

beforeAll(() => server.listen({ onUnhandledRequest: "error" }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());
```

- [ ] **Step 6: Run the build (skeleton only)**

Run: `cd apps/dashboard && pnpm exec tsc --noEmit`
Expected: clean exit. (Build will fail until `tests/msw/server.ts` lands in Task B9; that's OK — we only care about TS compile here.)

- [ ] **Step 7: Commit**

```bash
git add apps/dashboard/vite.config.ts apps/dashboard/vitest.config.ts apps/dashboard/tsconfig.json apps/dashboard/src/index.css apps/dashboard/tests/setup.ts
git commit -m "$(cat <<'EOF'
chore(dashboard): Vite + Vitest + Tailwind 4 + strict TS config

Wires the Tailwind v4 Vite plugin and TanStack Router codegen
plugin, plus a strict tsconfig with jsx: react-jsx. Establishes
Vitest jsdom setup for component tests with MSW lifecycle hooks.
Tailwind entry lives in src/index.css using the v4 @plugin +
@theme syntax instead of a tailwind.config.js.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task B3: Providers + Better Auth client + QueryClient

**Files:**
- Rewrite: `apps/dashboard/src/main.tsx`
- Create: `apps/dashboard/src/lib/auth.ts`
- Create: `apps/dashboard/src/lib/queryClient.ts`
- Create: `apps/dashboard/src/lib/api.ts`

- [ ] **Step 1: Create the auth client**

```ts
// apps/dashboard/src/lib/auth.ts
import { createAuthClient } from "better-auth/react";

const baseURL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export const authClient = createAuthClient({ baseURL });

export const { useSession, signIn, signOut, getSession } = authClient;
```

- [ ] **Step 2: Create the QueryClient**

```ts
// apps/dashboard/src/lib/queryClient.ts
import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "./api";

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      gcTime: 5 * 60_000,
      refetchOnWindowFocus: false,
      retry: (count, err) => {
        if (err instanceof ApiError && err.status === 401) return false;
        return count < 2;
      },
    },
  },
});
```

- [ ] **Step 3: Create the typed fetch wrapper**

```ts
// apps/dashboard/src/lib/api.ts
const BASE_URL = import.meta.env.VITE_API_URL ?? "http://localhost:3000";

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface Envelope<T> {
  data?: T;
  error?: { code: string; message: string };
}

export async function api<TResponse>(
  path: string,
  init?: RequestInit,
): Promise<TResponse> {
  const headers = new Headers(init?.headers);
  if (init?.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    credentials: "include",
    ...init,
    headers,
  });

  const envelope = (await res.json().catch(() => null)) as Envelope<TResponse> | null;

  if (!res.ok) {
    const code = envelope?.error?.code ?? `HTTP_${res.status}`;
    const message = envelope?.error?.message ?? res.statusText;
    throw new ApiError(code, message, res.status);
  }

  if (!envelope || envelope.data === undefined) {
    throw new ApiError("MALFORMED_RESPONSE", "Missing data envelope", res.status);
  }

  return envelope.data;
}
```

- [ ] **Step 4: Rewrite `main.tsx`**

```tsx
// apps/dashboard/src/main.tsx
import React from "react";
import ReactDOM from "react-dom/client";
import { HeroUIProvider } from "@heroui/react";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { ThemeProvider } from "next-themes";
import { router } from "./router";
import { queryClient } from "./lib/queryClient";
import "./index.css";

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ThemeProvider attribute="class" defaultTheme="dark">
      <HeroUIProvider>
        <QueryClientProvider client={queryClient}>
          <RouterProvider router={router} />
        </QueryClientProvider>
      </HeroUIProvider>
    </ThemeProvider>
  </React.StrictMode>,
);
```

- [ ] **Step 5: TypeScript check**

Run: `cd apps/dashboard && pnpm exec tsc --noEmit`
Expected: errors only from the missing `./router` import — that's resolved in Task B4.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/lib/auth.ts apps/dashboard/src/lib/queryClient.ts apps/dashboard/src/lib/api.ts apps/dashboard/src/main.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): providers, Better Auth client, typed API wrapper

Root mounts HeroUIProvider + ThemeProvider (dark default) +
QueryClientProvider + RouterProvider. api() unwraps the server's
{ data }/{ error } envelope, throwing ApiError(code, message,
status); 401 short-circuits query retries.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task B4: Router scaffold + root route

**Files:**
- Create: `apps/dashboard/src/router.tsx`
- Create: `apps/dashboard/src/routes/__root.tsx`
- Create: `apps/dashboard/src/routes/index.tsx`

- [ ] **Step 1: Create `__root.tsx`**

```tsx
// apps/dashboard/src/routes/__root.tsx
import { createRootRoute, Outlet } from "@tanstack/react-router";

export const Route = createRootRoute({
  component: () => (
    <div className="min-h-screen bg-background text-foreground">
      <Outlet />
    </div>
  ),
});
```

- [ ] **Step 2: Create the index redirect**

```tsx
// apps/dashboard/src/routes/index.tsx
import { createFileRoute, redirect } from "@tanstack/react-router";
import { getSession } from "../lib/auth";

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    const session = await getSession();
    if (!session.data) throw redirect({ to: "/login" });
    const lastProjectId = localStorage.getItem("lastProjectId");
    throw redirect({
      to: lastProjectId ? "/projects/$projectId" : "/projects",
      params: lastProjectId ? { projectId: lastProjectId } : undefined,
    });
  },
});
```

- [ ] **Step 3: Create `router.tsx`**

```tsx
// apps/dashboard/src/router.tsx
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
});
```

The TanStack Router Vite plugin generates `routeTree.gen.ts` on `pnpm dev` / `pnpm build`. It's not committed to git — add to `.gitignore` later if needed; the CI build regenerates.

- [ ] **Step 4: Run the dev server briefly to generate `routeTree.gen.ts`**

Run: `cd apps/dashboard && pnpm exec vite build` (this runs the plugin even in non-dev)
Expected: `src/routeTree.gen.ts` appears; build may fail at later missing routes — that's OK here.

- [ ] **Step 5: Add `routeTree.gen.ts` to `.gitignore`**

Append to repo root `.gitignore`:

```
apps/dashboard/src/routeTree.gen.ts
```

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/router.tsx apps/dashboard/src/routes/__root.tsx apps/dashboard/src/routes/index.tsx .gitignore
git commit -m "$(cat <<'EOF'
feat(dashboard): TanStack Router scaffold + root + index redirect

Root route is an Outlet wrapped in the themed shell. / checks the
Better Auth session and redirects to /login (signed out) or the
last-visited project (signed in). routeTree.gen.ts is generated
by the Vite plugin and git-ignored.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task B5: Login route with OAuth buttons

**Files:**
- Create: `apps/dashboard/src/routes/login.tsx`
- Create: `apps/dashboard/src/components/auth/OAuthButton.tsx`

- [ ] **Step 1: Create `OAuthButton.tsx`**

```tsx
// apps/dashboard/src/components/auth/OAuthButton.tsx
import { Button } from "@heroui/react";
import { signIn } from "../../lib/auth";

type Provider = "github" | "google";

interface Props {
  provider: Provider;
  children: React.ReactNode;
}

export function OAuthButton({ provider, children }: Props) {
  return (
    <Button
      variant="bordered"
      className="w-full justify-center"
      onPress={() =>
        signIn.social({
          provider,
          callbackURL: "/projects",
        })
      }
    >
      {children}
    </Button>
  );
}
```

- [ ] **Step 2: Create `login.tsx`**

```tsx
// apps/dashboard/src/routes/login.tsx
import { createFileRoute } from "@tanstack/react-router";
import { Card, CardBody, CardHeader } from "@heroui/react";
import { OAuthButton } from "../components/auth/OAuthButton";

export const Route = createFileRoute("/login")({
  component: LoginPage,
  validateSearch: (search: Record<string, unknown>) => ({
    error: typeof search.error === "string" ? search.error : undefined,
  }),
});

function LoginPage() {
  const { error } = Route.useSearch();
  return (
    <div className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-md">
        <CardHeader className="flex flex-col items-start gap-1">
          <h1 className="text-xl font-semibold">Sign in to Rovenue</h1>
          <p className="text-sm text-default-500">
            Continue with GitHub or Google to manage your projects.
          </p>
        </CardHeader>
        <CardBody className="flex flex-col gap-3">
          {error && (
            <div
              role="alert"
              className="rounded-md bg-danger-100 px-3 py-2 text-sm text-danger-700"
            >
              {error}
            </div>
          )}
          <OAuthButton provider="github">Continue with GitHub</OAuthButton>
          <OAuthButton provider="google">Continue with Google</OAuthButton>
        </CardBody>
      </Card>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/routes/login.tsx apps/dashboard/src/components/auth/OAuthButton.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): /login with GitHub + Google OAuth

Centered Hero UI card with two provider buttons. Reads ?error=
from the Better Auth callback so failed redirects render as a
banner above the buttons.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task B6: Authed gate + project hooks

**Files:**
- Create: `apps/dashboard/src/routes/_authed.tsx`
- Create: `apps/dashboard/src/lib/hooks/useProjects.ts`
- Create: `apps/dashboard/src/lib/hooks/useProject.ts`
- Create: `apps/dashboard/src/lib/hooks/useCreateProject.ts`
- Create: `apps/dashboard/src/lib/hooks/useUpdateProject.ts`
- Create: `apps/dashboard/src/lib/hooks/useRotateWebhookSecret.ts`
- Create: `apps/dashboard/src/lib/hooks/useDeleteProject.ts`

- [ ] **Step 1: Authed gate**

```tsx
// apps/dashboard/src/routes/_authed.tsx
import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { getSession } from "../lib/auth";

export const Route = createFileRoute("/_authed")({
  beforeLoad: async () => {
    const session = await getSession();
    if (!session.data) throw redirect({ to: "/login" });
  },
  component: Outlet,
});
```

- [ ] **Step 2: Project hooks**

```ts
// apps/dashboard/src/lib/hooks/useProjects.ts
import { useQuery } from "@tanstack/react-query";
import type { ProjectSummary } from "@rovenue/shared";
import { api } from "../api";

export function useProjects() {
  return useQuery({
    queryKey: ["projects"],
    queryFn: () => api<{ projects: ProjectSummary[] }>("/dashboard/projects"),
    select: (res) => res.projects,
  });
}
```

```ts
// apps/dashboard/src/lib/hooks/useProject.ts
import { useQuery } from "@tanstack/react-query";
import type { ProjectDetail } from "@rovenue/shared";
import { api } from "../api";

export function useProject(id: string | undefined) {
  return useQuery({
    queryKey: ["project", id],
    enabled: Boolean(id),
    queryFn: () => api<{ project: ProjectDetail }>(`/dashboard/projects/${id}`),
    select: (res) => res.project,
  });
}
```

```ts
// apps/dashboard/src/lib/hooks/useCreateProject.ts
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateProjectRequest, CreateProjectResponse } from "@rovenue/shared";
import { api } from "../api";

export function useCreateProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateProjectRequest) =>
      api<CreateProjectResponse>("/dashboard/projects", {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}
```

```ts
// apps/dashboard/src/lib/hooks/useUpdateProject.ts
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { UpdateProjectRequest } from "@rovenue/shared";
import { api } from "../api";

export function useUpdateProject(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateProjectRequest) =>
      api<{ project: { id: string } }>(`/dashboard/projects/${projectId}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["project", projectId] });
      qc.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}
```

```ts
// apps/dashboard/src/lib/hooks/useRotateWebhookSecret.ts
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { RotateWebhookSecretResponse } from "@rovenue/shared";
import { api } from "../api";

export function useRotateWebhookSecret(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () =>
      api<RotateWebhookSecretResponse>(
        `/dashboard/projects/${projectId}/webhook-secret/rotate`,
        { method: "POST" },
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", projectId] }),
  });
}
```

```ts
// apps/dashboard/src/lib/hooks/useDeleteProject.ts
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";

export function useDeleteProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (projectId: string) =>
      api<{ id: string }>(`/dashboard/projects/${projectId}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["projects"] }),
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/routes/_authed.tsx apps/dashboard/src/lib/hooks/useProjects.ts apps/dashboard/src/lib/hooks/useProject.ts apps/dashboard/src/lib/hooks/useCreateProject.ts apps/dashboard/src/lib/hooks/useUpdateProject.ts apps/dashboard/src/lib/hooks/useRotateWebhookSecret.ts apps/dashboard/src/lib/hooks/useDeleteProject.ts
git commit -m "$(cat <<'EOF'
feat(dashboard): authed gate + project TanStack Query hooks

_authed layout redirects to /login when no session. Hook set
covers list, detail, create, update, rotate webhook secret, and
delete with consistent query key conventions (["projects"] for
the list, ["project", id] for detail).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task B7: Projects list + project card + create flow

**Files:**
- Create: `apps/dashboard/src/components/layout/TopNav.tsx`
- Create: `apps/dashboard/src/components/projects/ProjectCard.tsx`
- Create: `apps/dashboard/src/routes/_authed/projects.tsx`
- Create: `apps/dashboard/src/components/projects/CreateProjectForm.tsx`
- Create: `apps/dashboard/src/routes/_authed/projects.new.tsx`

- [ ] **Step 1: Basic TopNav**

```tsx
// apps/dashboard/src/components/layout/TopNav.tsx
import { Button, Navbar, NavbarBrand, NavbarContent } from "@heroui/react";
import { Link, useNavigate } from "@tanstack/react-router";
import { signOut, useSession } from "../../lib/auth";

export function TopNav() {
  const { data } = useSession();
  const navigate = useNavigate();

  return (
    <Navbar maxWidth="full" isBordered>
      <NavbarBrand>
        <Link to="/projects" className="text-lg font-semibold">
          Rovenue
        </Link>
      </NavbarBrand>
      <NavbarContent justify="end">
        <span className="text-sm text-default-500">{data?.user.email}</span>
        <Button
          size="sm"
          variant="light"
          onPress={async () => {
            await signOut();
            await navigate({ to: "/login" });
          }}
        >
          Sign out
        </Button>
      </NavbarContent>
    </Navbar>
  );
}
```

- [ ] **Step 2: ProjectCard**

```tsx
// apps/dashboard/src/components/projects/ProjectCard.tsx
import { Card, CardBody, CardHeader, Chip } from "@heroui/react";
import { Link } from "@tanstack/react-router";
import type { ProjectSummary } from "@rovenue/shared";

const roleColor = {
  OWNER: "success",
  ADMIN: "primary",
  VIEWER: "default",
} as const;

export function ProjectCard({ project }: { project: ProjectSummary }) {
  return (
    <Link
      to="/projects/$projectId"
      params={{ projectId: project.id }}
      className="block"
    >
      <Card isPressable isHoverable className="h-full w-full">
        <CardHeader className="flex items-center justify-between">
          <span className="text-base font-medium">{project.name}</span>
          <Chip size="sm" color={roleColor[project.role]}>
            {project.role}
          </Chip>
        </CardHeader>
        <CardBody className="text-xs text-default-500">
          Created {new Date(project.createdAt).toLocaleDateString()}
        </CardBody>
      </Card>
    </Link>
  );
}
```

- [ ] **Step 3: Projects list route**

```tsx
// apps/dashboard/src/routes/_authed/projects.tsx
import { createFileRoute, Link } from "@tanstack/react-router";
import { Button, Spinner } from "@heroui/react";
import { TopNav } from "../../components/layout/TopNav";
import { ProjectCard } from "../../components/projects/ProjectCard";
import { useProjects } from "../../lib/hooks/useProjects";

export const Route = createFileRoute("/_authed/projects")({
  component: ProjectsList,
});

function ProjectsList() {
  const { data, isLoading, error } = useProjects();

  return (
    <>
      <TopNav />
      <div className="mx-auto max-w-6xl px-6 py-8">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-semibold">Projects</h1>
          <Button as={Link} to="/projects/new" color="primary">
            New project
          </Button>
        </div>

        {isLoading && <Spinner label="Loading..." />}
        {error && (
          <div role="alert" className="text-danger-500">
            {error.message}
          </div>
        )}
        {data?.length === 0 && (
          <div className="rounded-lg border border-dashed border-default-300 p-12 text-center text-default-500">
            No projects yet. Create your first one to get started.
          </div>
        )}
        {data && data.length > 0 && (
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {data.map((p) => (
              <ProjectCard key={p.id} project={p} />
            ))}
          </div>
        )}
      </div>
    </>
  );
}
```

- [ ] **Step 4: CreateProjectForm**

```tsx
// apps/dashboard/src/components/projects/CreateProjectForm.tsx
import { useState } from "react";
import { Button, Input } from "@heroui/react";
import type { CreateProjectResponse } from "@rovenue/shared";
import { useCreateProject } from "../../lib/hooks/useCreateProject";

interface Props {
  onCreated: (result: CreateProjectResponse) => void;
}

export function CreateProjectForm({ onCreated }: Props) {
  const [name, setName] = useState("");
  const { mutate, isPending, error } = useCreateProject();

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        mutate({ name }, { onSuccess: onCreated });
      }}
      className="flex flex-col gap-4"
    >
      <Input
        label="Project name"
        placeholder="Acme"
        value={name}
        onValueChange={setName}
        minLength={2}
        maxLength={80}
        isRequired
      />
      {error && (
        <div role="alert" className="text-sm text-danger-500">
          {error.message}
        </div>
      )}
      <Button type="submit" color="primary" isLoading={isPending} isDisabled={name.length < 2}>
        Create project
      </Button>
    </form>
  );
}
```

- [ ] **Step 5: `/projects/new` route with API key reveal dialog**

```tsx
// apps/dashboard/src/routes/_authed/projects.new.tsx
import { useState } from "react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import {
  Card,
  CardBody,
  CardHeader,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Button,
  Snippet,
} from "@heroui/react";
import { TopNav } from "../../components/layout/TopNav";
import { CreateProjectForm } from "../../components/projects/CreateProjectForm";
import type { CreateProjectResponse } from "@rovenue/shared";

export const Route = createFileRoute("/_authed/projects/new")({
  component: NewProjectPage,
});

function NewProjectPage() {
  const navigate = useNavigate();
  const [result, setResult] = useState<CreateProjectResponse | null>(null);

  return (
    <>
      <TopNav />
      <div className="mx-auto max-w-md px-6 py-8">
        <Card>
          <CardHeader>
            <h1 className="text-xl font-semibold">New project</h1>
          </CardHeader>
          <CardBody>
            <CreateProjectForm onCreated={setResult} />
          </CardBody>
        </Card>
      </div>

      <Modal isOpen={result !== null} isDismissable={false} hideCloseButton>
        <ModalContent>
          <ModalHeader>Save your API keys</ModalHeader>
          <ModalBody className="gap-4">
            <p className="text-sm text-default-500">
              These are shown only once. Copy them now — you can always
              rotate them later from project settings.
            </p>
            <div>
              <div className="text-xs font-medium text-default-500">Public key</div>
              <Snippet size="sm" symbol="">
                {result?.apiKeys.publicKey ?? ""}
              </Snippet>
            </div>
            <div>
              <div className="text-xs font-medium text-default-500">Secret key</div>
              <Snippet size="sm" symbol="">
                {result?.apiKeys.secretKey ?? ""}
              </Snippet>
            </div>
          </ModalBody>
          <ModalFooter>
            <Button
              color="primary"
              onPress={() => {
                if (!result) return;
                localStorage.setItem("lastProjectId", result.project.id);
                navigate({
                  to: "/projects/$projectId",
                  params: { projectId: result.project.id },
                });
              }}
            >
              I've copied them, take me to the project
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
}
```

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/components/layout/TopNav.tsx apps/dashboard/src/components/projects/ProjectCard.tsx apps/dashboard/src/components/projects/CreateProjectForm.tsx apps/dashboard/src/routes/_authed/projects.tsx apps/dashboard/src/routes/_authed/projects.new.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): projects list + create flow

/projects shows a responsive grid of ProjectCards with role chips
and an empty-state CTA. /projects/new posts the form and opens a
non-dismissable modal that reveals both API keys once before
navigating into the new project.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task B8: Project layout + project switcher + overview + settings

**Files:**
- Create: `apps/dashboard/src/components/layout/ProjectSwitcher.tsx`
- Create: `apps/dashboard/src/routes/_authed/projects.$projectId/route.tsx`
- Create: `apps/dashboard/src/routes/_authed/projects.$projectId/index.tsx`
- Create: `apps/dashboard/src/components/projects/SettingsForm.tsx`
- Create: `apps/dashboard/src/components/projects/RotateSecretDialog.tsx`
- Create: `apps/dashboard/src/components/projects/DeleteProjectDialog.tsx`
- Create: `apps/dashboard/src/routes/_authed/projects.$projectId/settings.tsx`

- [ ] **Step 1: ProjectSwitcher**

```tsx
// apps/dashboard/src/components/layout/ProjectSwitcher.tsx
import { Select, SelectItem } from "@heroui/react";
import { useNavigate } from "@tanstack/react-router";
import { useProjects } from "../../lib/hooks/useProjects";

export function ProjectSwitcher({ currentProjectId }: { currentProjectId: string }) {
  const { data } = useProjects();
  const navigate = useNavigate();
  if (!data) return null;
  return (
    <Select
      size="sm"
      className="min-w-[200px]"
      selectedKeys={new Set([currentProjectId])}
      onSelectionChange={(keys) => {
        const next = Array.from(keys)[0] as string | undefined;
        if (!next || next === currentProjectId) return;
        localStorage.setItem("lastProjectId", next);
        navigate({ to: "/projects/$projectId", params: { projectId: next } });
      }}
    >
      {data.map((p) => (
        <SelectItem key={p.id}>{p.name}</SelectItem>
      ))}
    </Select>
  );
}
```

- [ ] **Step 2: Project layout route**

```tsx
// apps/dashboard/src/routes/_authed/projects.$projectId/route.tsx
import { createFileRoute, Link, Outlet, useParams } from "@tanstack/react-router";
import { TopNav } from "../../../components/layout/TopNav";
import { ProjectSwitcher } from "../../../components/layout/ProjectSwitcher";
import { useProject } from "../../../lib/hooks/useProject";
import { Spinner } from "@heroui/react";

export const Route = createFileRoute("/_authed/projects/$projectId")({
  component: ProjectLayout,
});

function ProjectLayout() {
  const { projectId } = useParams({ from: "/_authed/projects/$projectId" });
  const { data, isLoading, error } = useProject(projectId);

  if (isLoading) return <Spinner label="Loading..." />;
  if (error || !data) {
    return <div className="p-6 text-danger-500">Project not found</div>;
  }

  return (
    <>
      <TopNav />
      <div className="border-b border-default-200 bg-content1 px-6 py-3 flex items-center gap-4">
        <ProjectSwitcher currentProjectId={projectId} />
        <nav className="flex gap-4 text-sm">
          <Link
            to="/projects/$projectId"
            params={{ projectId }}
            activeProps={{ className: "font-semibold text-primary" }}
          >
            Overview
          </Link>
          <Link
            to="/projects/$projectId/subscribers"
            params={{ projectId }}
            activeProps={{ className: "font-semibold text-primary" }}
          >
            Subscribers
          </Link>
          <Link
            to="/projects/$projectId/settings"
            params={{ projectId }}
            activeProps={{ className: "font-semibold text-primary" }}
          >
            Settings
          </Link>
        </nav>
      </div>
      <div className="mx-auto max-w-6xl px-6 py-8">
        <Outlet />
      </div>
    </>
  );
}
```

- [ ] **Step 3: Overview route**

```tsx
// apps/dashboard/src/routes/_authed/projects.$projectId/index.tsx
import { createFileRoute, useParams } from "@tanstack/react-router";
import { Card, CardBody, CardHeader } from "@heroui/react";
import { useProject } from "../../../lib/hooks/useProject";

export const Route = createFileRoute("/_authed/projects/$projectId/")({
  component: Overview,
});

function Overview() {
  const { projectId } = useParams({ from: "/_authed/projects/$projectId/" });
  const { data } = useProject(projectId);
  if (!data) return null;

  const stats = [
    { label: "Subscribers", value: data.counts.subscribers },
    { label: "Experiments", value: data.counts.experiments },
    { label: "Feature flags", value: data.counts.featureFlags },
    { label: "Active API keys", value: data.counts.activeApiKeys },
  ];

  return (
    <div>
      <h1 className="mb-6 text-2xl font-semibold">{data.name}</h1>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {stats.map((s) => (
          <Card key={s.label}>
            <CardHeader className="pb-0 text-xs uppercase text-default-500">
              {s.label}
            </CardHeader>
            <CardBody className="pt-1 text-3xl font-semibold">{s.value}</CardBody>
          </Card>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 4: SettingsForm (name + webhookUrl)**

```tsx
// apps/dashboard/src/components/projects/SettingsForm.tsx
import { useState } from "react";
import { Button, Input } from "@heroui/react";
import type { ProjectDetail } from "@rovenue/shared";
import { useUpdateProject } from "../../lib/hooks/useUpdateProject";

export function SettingsForm({ project }: { project: ProjectDetail }) {
  const [name, setName] = useState(project.name);
  const [webhookUrl, setWebhookUrl] = useState(project.webhookUrl ?? "");
  const { mutate, isPending, error } = useUpdateProject(project.id);

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        mutate({
          name: name !== project.name ? name : undefined,
          webhookUrl: webhookUrl !== (project.webhookUrl ?? "") ? webhookUrl || null : undefined,
        });
      }}
      className="flex flex-col gap-4"
    >
      <Input
        label="Project name"
        value={name}
        onValueChange={setName}
        minLength={2}
        maxLength={80}
      />
      <Input
        label="Webhook URL"
        placeholder="https://..."
        value={webhookUrl}
        onValueChange={setWebhookUrl}
        type="url"
      />
      {error && (
        <div role="alert" className="text-sm text-danger-500">
          {error.message}
        </div>
      )}
      <Button type="submit" color="primary" isLoading={isPending} className="self-start">
        Save changes
      </Button>
    </form>
  );
}
```

- [ ] **Step 5: RotateSecretDialog**

```tsx
// apps/dashboard/src/components/projects/RotateSecretDialog.tsx
import { useState } from "react";
import {
  Button,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
  Snippet,
} from "@heroui/react";
import { useRotateWebhookSecret } from "../../lib/hooks/useRotateWebhookSecret";

export function RotateSecretDialog({ projectId }: { projectId: string }) {
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const { mutate, isPending } = useRotateWebhookSecret(projectId);

  return (
    <>
      <Button color="warning" variant="flat" onPress={() => setOpen(true)}>
        Rotate webhook secret
      </Button>
      <Modal
        isOpen={open}
        isDismissable={secret === null}
        onOpenChange={(o) => {
          if (!o) {
            setOpen(false);
            setSecret(null);
          }
        }}
      >
        <ModalContent>
          <ModalHeader>
            {secret ? "Save your new secret" : "Rotate webhook secret?"}
          </ModalHeader>
          <ModalBody>
            {!secret && (
              <p className="text-sm text-default-500">
                The current secret will stop working immediately. Any endpoint
                that verifies signatures must be updated with the new value.
              </p>
            )}
            {secret && (
              <Snippet size="sm" symbol="">
                {secret}
              </Snippet>
            )}
          </ModalBody>
          <ModalFooter>
            {!secret ? (
              <>
                <Button variant="light" onPress={() => setOpen(false)}>
                  Cancel
                </Button>
                <Button
                  color="warning"
                  isLoading={isPending}
                  onPress={() =>
                    mutate(undefined, {
                      onSuccess: (res) => setSecret(res.webhookSecret),
                    })
                  }
                >
                  Rotate
                </Button>
              </>
            ) : (
              <Button
                color="primary"
                onPress={() => {
                  setOpen(false);
                  setSecret(null);
                }}
              >
                I've copied the new secret
              </Button>
            )}
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
}
```

- [ ] **Step 6: DeleteProjectDialog**

```tsx
// apps/dashboard/src/components/projects/DeleteProjectDialog.tsx
import { useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  Button,
  Input,
  Modal,
  ModalBody,
  ModalContent,
  ModalFooter,
  ModalHeader,
} from "@heroui/react";
import { useDeleteProject } from "../../lib/hooks/useDeleteProject";

export function DeleteProjectDialog({
  projectId,
  projectName,
}: {
  projectId: string;
  projectName: string;
}) {
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState("");
  const navigate = useNavigate();
  const { mutate, isPending } = useDeleteProject();
  const canDelete = confirm === projectName;

  return (
    <>
      <Button color="danger" variant="flat" onPress={() => setOpen(true)}>
        Delete project
      </Button>
      <Modal isOpen={open} onOpenChange={setOpen}>
        <ModalContent>
          <ModalHeader>Delete {projectName}?</ModalHeader>
          <ModalBody className="gap-3">
            <p className="text-sm">
              This deletes every subscriber, purchase, audit entry, and
              revenue record under this project. It cannot be undone.
            </p>
            <Input
              label={`Type "${projectName}" to confirm`}
              value={confirm}
              onValueChange={setConfirm}
            />
          </ModalBody>
          <ModalFooter>
            <Button variant="light" onPress={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              color="danger"
              isDisabled={!canDelete}
              isLoading={isPending}
              onPress={() =>
                mutate(projectId, {
                  onSuccess: () => {
                    localStorage.removeItem("lastProjectId");
                    navigate({ to: "/projects" });
                  },
                })
              }
            >
              Delete permanently
            </Button>
          </ModalFooter>
        </ModalContent>
      </Modal>
    </>
  );
}
```

- [ ] **Step 7: Settings route**

```tsx
// apps/dashboard/src/routes/_authed/projects.$projectId/settings.tsx
import { createFileRoute, useParams } from "@tanstack/react-router";
import { Card, CardBody, CardHeader, Divider } from "@heroui/react";
import { useProject } from "../../../lib/hooks/useProject";
import { SettingsForm } from "../../../components/projects/SettingsForm";
import { RotateSecretDialog } from "../../../components/projects/RotateSecretDialog";
import { DeleteProjectDialog } from "../../../components/projects/DeleteProjectDialog";

export const Route = createFileRoute("/_authed/projects/$projectId/settings")({
  component: Settings,
});

function Settings() {
  const { projectId } = useParams({ from: "/_authed/projects/$projectId/settings" });
  const { data } = useProject(projectId);
  if (!data) return null;

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">General</h2>
        </CardHeader>
        <CardBody>
          <SettingsForm project={data} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">Webhook secret</h2>
        </CardHeader>
        <CardBody className="gap-3">
          <p className="text-sm text-default-500">
            {data.hasWebhookSecret
              ? "A webhook secret is configured. You can rotate it below."
              : "No webhook secret configured yet. Rotate to mint the first one."}
          </p>
          <RotateSecretDialog projectId={data.id} />
        </CardBody>
      </Card>

      <Divider />

      <Card className="border border-danger-200">
        <CardHeader>
          <h2 className="text-lg font-semibold text-danger-500">Danger zone</h2>
        </CardHeader>
        <CardBody>
          <DeleteProjectDialog projectId={data.id} projectName={data.name} />
        </CardBody>
      </Card>
    </div>
  );
}
```

- [ ] **Step 8: Commit**

```bash
git add apps/dashboard/src/components/layout/ProjectSwitcher.tsx apps/dashboard/src/routes/_authed/projects.\$projectId/route.tsx apps/dashboard/src/routes/_authed/projects.\$projectId/index.tsx apps/dashboard/src/components/projects/SettingsForm.tsx apps/dashboard/src/components/projects/RotateSecretDialog.tsx apps/dashboard/src/components/projects/DeleteProjectDialog.tsx apps/dashboard/src/routes/_authed/projects.\$projectId/settings.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): project layout, overview, and settings

Layout renders the top nav with a project switcher and a sub-nav
for Overview/Subscribers/Settings. Overview shows four stat cards.
Settings has general (name + webhook URL), rotate-secret dialog
with a one-shot reveal, and a type-to-confirm delete dialog.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task B9: Subscribers list with TanStack Table + infinite query

**Files:**
- Create: `apps/dashboard/src/lib/hooks/useSubscribers.ts`
- Create: `apps/dashboard/src/components/subscribers/SubscribersTable.tsx`
- Create: `apps/dashboard/src/routes/_authed/projects.$projectId/subscribers/index.tsx`

- [ ] **Step 1: useSubscribers hook**

```ts
// apps/dashboard/src/lib/hooks/useSubscribers.ts
import { useInfiniteQuery } from "@tanstack/react-query";
import type { SubscriberListResponse } from "@rovenue/shared";
import { api } from "../api";

interface Params {
  projectId: string;
  q?: string;
  limit?: number;
}

export function useSubscribers({ projectId, q, limit = 50 }: Params) {
  return useInfiniteQuery<SubscriberListResponse>({
    queryKey: ["subscribers", projectId, { q, limit }],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) => {
      const params = new URLSearchParams();
      if (pageParam) params.set("cursor", pageParam);
      if (q) params.set("q", q);
      params.set("limit", String(limit));
      return api<SubscriberListResponse>(
        `/dashboard/projects/${projectId}/subscribers?${params.toString()}`,
      );
    },
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
}
```

- [ ] **Step 2: SubscribersTable**

```tsx
// apps/dashboard/src/components/subscribers/SubscribersTable.tsx
import {
  Chip,
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from "@heroui/react";
import { Link } from "@tanstack/react-router";
import type { SubscriberListItem } from "@rovenue/shared";

interface Props {
  projectId: string;
  rows: SubscriberListItem[];
}

export function SubscribersTable({ projectId, rows }: Props) {
  return (
    <Table aria-label="Subscribers" removeWrapper>
      <TableHeader>
        <TableColumn>APP USER ID</TableColumn>
        <TableColumn>LAST SEEN</TableColumn>
        <TableColumn>PURCHASES</TableColumn>
        <TableColumn>ACTIVE ACCESS</TableColumn>
      </TableHeader>
      <TableBody emptyContent="No subscribers">
        {rows.map((s) => (
          <TableRow key={s.id}>
            <TableCell>
              <Link
                to="/projects/$projectId/subscribers/$id"
                params={{ projectId, id: s.id }}
                className="text-primary"
              >
                {s.appUserId}
              </Link>
            </TableCell>
            <TableCell>{new Date(s.lastSeenAt).toLocaleString()}</TableCell>
            <TableCell>{s.purchaseCount}</TableCell>
            <TableCell className="flex flex-wrap gap-1">
              {s.activeEntitlementKeys.length === 0 && (
                <span className="text-default-400">—</span>
              )}
              {s.activeEntitlementKeys.map((k) => (
                <Chip key={k} size="sm" variant="flat" color="success">
                  {k}
                </Chip>
              ))}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
```

- [ ] **Step 3: Subscribers list route**

```tsx
// apps/dashboard/src/routes/_authed/projects.$projectId/subscribers/index.tsx
import { useEffect, useRef, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { Button, Input, Spinner } from "@heroui/react";
import { useSubscribers } from "../../../../lib/hooks/useSubscribers";
import { SubscribersTable } from "../../../../components/subscribers/SubscribersTable";

export const Route = createFileRoute("/_authed/projects/$projectId/subscribers/")({
  component: SubscribersPage,
});

function SubscribersPage() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/subscribers/",
  });
  const [q, setQ] = useState("");
  const [debouncedQ, setDebouncedQ] = useState("");

  useEffect(() => {
    const id = setTimeout(() => setDebouncedQ(q), 300);
    return () => clearTimeout(id);
  }, [q]);

  const {
    data,
    isLoading,
    isFetchingNextPage,
    hasNextPage,
    fetchNextPage,
    error,
  } = useSubscribers({ projectId, q: debouncedQ || undefined });

  const loaderRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = loaderRef.current;
    if (!el) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries[0]?.isIntersecting && hasNextPage && !isFetchingNextPage) {
        void fetchNextPage();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasNextPage, isFetchingNextPage, fetchNextPage]);

  const rows = data?.pages.flatMap((p) => p.subscribers) ?? [];

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Subscribers</h1>
        <Input
          size="sm"
          className="max-w-xs"
          placeholder="Search by app user id or attribute..."
          value={q}
          onValueChange={setQ}
          isClearable
        />
      </div>

      {isLoading && <Spinner label="Loading..." />}
      {error && (
        <div role="alert" className="text-danger-500">
          {error.message}
        </div>
      )}
      {!isLoading && !error && <SubscribersTable projectId={projectId} rows={rows} />}

      <div ref={loaderRef} className="h-8 flex items-center justify-center">
        {isFetchingNextPage && <Spinner size="sm" />}
        {!hasNextPage && rows.length > 0 && (
          <span className="text-xs text-default-400">End of list</span>
        )}
      </div>

      {hasNextPage && !isFetchingNextPage && (
        <Button
          variant="flat"
          size="sm"
          onPress={() => fetchNextPage()}
          className="self-center"
        >
          Load more
        </Button>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/lib/hooks/useSubscribers.ts apps/dashboard/src/components/subscribers/SubscribersTable.tsx apps/dashboard/src/routes/_authed/projects.\$projectId/subscribers/index.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): subscribers list with search + infinite scroll

useSubscribers is a useInfiniteQuery keyed on (projectId, q, limit)
that forwards the opaque cursor to the API. The list page
debounces search input (300ms), observes a loader sentinel with
IntersectionObserver for auto-pagination, and falls back to a
manual Load more button when the sentinel misses.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task B10: Subscriber detail page

**Files:**
- Create: `apps/dashboard/src/lib/hooks/useSubscriber.ts`
- Create: `apps/dashboard/src/components/subscribers/AccessTable.tsx`
- Create: `apps/dashboard/src/components/subscribers/PurchasesTable.tsx`
- Create: `apps/dashboard/src/components/subscribers/CreditLedgerTable.tsx`
- Create: `apps/dashboard/src/components/subscribers/AssignmentsList.tsx`
- Create: `apps/dashboard/src/components/subscribers/SubscriberDetailPanel.tsx`
- Create: `apps/dashboard/src/routes/_authed/projects.$projectId/subscribers/$id.tsx`

- [ ] **Step 1: Hook**

```ts
// apps/dashboard/src/lib/hooks/useSubscriber.ts
import { useQuery } from "@tanstack/react-query";
import type { SubscriberDetail } from "@rovenue/shared";
import { api } from "../api";

export function useSubscriber(projectId: string, id: string) {
  return useQuery({
    queryKey: ["subscriber", projectId, id],
    queryFn: () =>
      api<{ subscriber: SubscriberDetail }>(
        `/dashboard/projects/${projectId}/subscribers/${id}`,
      ),
    select: (res) => res.subscriber,
  });
}
```

- [ ] **Step 2: AccessTable**

```tsx
// apps/dashboard/src/components/subscribers/AccessTable.tsx
import {
  Chip,
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from "@heroui/react";
import type { SubscriberAccessRow } from "@rovenue/shared";

export function AccessTable({ rows }: { rows: SubscriberAccessRow[] }) {
  return (
    <Table aria-label="Access" removeWrapper>
      <TableHeader>
        <TableColumn>ENTITLEMENT</TableColumn>
        <TableColumn>STATUS</TableColumn>
        <TableColumn>EXPIRES</TableColumn>
        <TableColumn>STORE</TableColumn>
        <TableColumn>PURCHASE</TableColumn>
      </TableHeader>
      <TableBody emptyContent="No active entitlements">
        {rows.map((r) => (
          <TableRow key={`${r.entitlementKey}-${r.purchaseId}`}>
            <TableCell>
              <Chip color="success" size="sm">{r.entitlementKey}</Chip>
            </TableCell>
            <TableCell>{r.isActive ? "Active" : "Inactive"}</TableCell>
            <TableCell>
              {r.expiresDate ? new Date(r.expiresDate).toLocaleString() : "Never"}
            </TableCell>
            <TableCell>{r.store}</TableCell>
            <TableCell>
              <span className="font-mono text-xs text-default-500">{r.purchaseId}</span>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
```

- [ ] **Step 3: PurchasesTable**

```tsx
// apps/dashboard/src/components/subscribers/PurchasesTable.tsx
import {
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from "@heroui/react";
import type { SubscriberPurchase } from "@rovenue/shared";

export function PurchasesTable({ rows }: { rows: SubscriberPurchase[] }) {
  return (
    <Table aria-label="Purchases" removeWrapper>
      <TableHeader>
        <TableColumn>PRODUCT</TableColumn>
        <TableColumn>STORE</TableColumn>
        <TableColumn>STATUS</TableColumn>
        <TableColumn>PRICE</TableColumn>
        <TableColumn>PURCHASED</TableColumn>
        <TableColumn>EXPIRES</TableColumn>
      </TableHeader>
      <TableBody emptyContent="No purchases">
        {rows.map((p) => (
          <TableRow key={p.id}>
            <TableCell className="font-medium">{p.productIdentifier}</TableCell>
            <TableCell>{p.store}</TableCell>
            <TableCell>{p.status}</TableCell>
            <TableCell>
              {p.priceAmount ? `${p.priceAmount} ${p.priceCurrency ?? ""}` : "—"}
            </TableCell>
            <TableCell>{new Date(p.purchaseDate).toLocaleDateString()}</TableCell>
            <TableCell>
              {p.expiresDate ? new Date(p.expiresDate).toLocaleDateString() : "—"}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
```

- [ ] **Step 4: CreditLedgerTable**

```tsx
// apps/dashboard/src/components/subscribers/CreditLedgerTable.tsx
import {
  Table,
  TableBody,
  TableCell,
  TableColumn,
  TableHeader,
  TableRow,
} from "@heroui/react";
import type { SubscriberCreditLedgerRow } from "@rovenue/shared";

export function CreditLedgerTable({ rows }: { rows: SubscriberCreditLedgerRow[] }) {
  return (
    <Table aria-label="Credit ledger" removeWrapper>
      <TableHeader>
        <TableColumn>WHEN</TableColumn>
        <TableColumn>TYPE</TableColumn>
        <TableColumn>AMOUNT</TableColumn>
        <TableColumn>BALANCE</TableColumn>
        <TableColumn>NOTE</TableColumn>
      </TableHeader>
      <TableBody emptyContent="No ledger entries">
        {rows.map((r) => (
          <TableRow key={r.id}>
            <TableCell>{new Date(r.createdAt).toLocaleString()}</TableCell>
            <TableCell>{r.type}</TableCell>
            <TableCell>{r.amount}</TableCell>
            <TableCell>{r.balance}</TableCell>
            <TableCell className="text-default-500">{r.description ?? ""}</TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
```

- [ ] **Step 5: AssignmentsList**

```tsx
// apps/dashboard/src/components/subscribers/AssignmentsList.tsx
import { Chip } from "@heroui/react";
import type { SubscriberAssignment } from "@rovenue/shared";

export function AssignmentsList({ rows }: { rows: SubscriberAssignment[] }) {
  if (rows.length === 0) {
    return (
      <div className="text-sm text-default-400">Not in any active experiments.</div>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {rows.map((a) => (
        <li
          key={`${a.experimentId}-${a.variantId}`}
          className="flex items-center justify-between rounded-md border border-default-200 px-3 py-2"
        >
          <div className="flex flex-col">
            <span className="text-sm font-medium">{a.experimentKey}</span>
            <span className="text-xs text-default-500">variant {a.variantId}</span>
          </div>
          <Chip size="sm" color={a.convertedAt ? "success" : "default"} variant="flat">
            {a.convertedAt ? "Converted" : "Active"}
          </Chip>
        </li>
      ))}
    </ul>
  );
}
```

- [ ] **Step 6: SubscriberDetailPanel (composition)**

```tsx
// apps/dashboard/src/components/subscribers/SubscriberDetailPanel.tsx
import { Card, CardBody, CardHeader } from "@heroui/react";
import type { SubscriberDetail } from "@rovenue/shared";
import { AccessTable } from "./AccessTable";
import { PurchasesTable } from "./PurchasesTable";
import { CreditLedgerTable } from "./CreditLedgerTable";
import { AssignmentsList } from "./AssignmentsList";

export function SubscriberDetailPanel({ data }: { data: SubscriberDetail }) {
  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader className="flex flex-col items-start">
          <h1 className="text-2xl font-semibold">{data.appUserId}</h1>
          <div className="mt-1 text-xs text-default-500">
            First seen {new Date(data.firstSeenAt).toLocaleDateString()} ·
            Last seen {new Date(data.lastSeenAt).toLocaleDateString()}
          </div>
        </CardHeader>
        <CardBody>
          <details>
            <summary className="cursor-pointer text-sm text-default-500">
              Attributes
            </summary>
            <pre className="mt-2 overflow-x-auto rounded bg-default-100 p-3 text-xs">
              {JSON.stringify(data.attributes, null, 2)}
            </pre>
          </details>
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">Access</h2>
        </CardHeader>
        <CardBody>
          <AccessTable rows={data.access} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">Purchases</h2>
        </CardHeader>
        <CardBody>
          <PurchasesTable rows={data.purchases} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Credits</h2>
          <span className="text-sm text-default-500">
            Balance: <span className="font-semibold">{data.creditBalance}</span>
          </span>
        </CardHeader>
        <CardBody>
          <CreditLedgerTable rows={data.creditLedger} />
        </CardBody>
      </Card>

      <Card>
        <CardHeader>
          <h2 className="text-lg font-semibold">Experiments</h2>
        </CardHeader>
        <CardBody>
          <AssignmentsList rows={data.assignments} />
        </CardBody>
      </Card>
    </div>
  );
}
```

- [ ] **Step 7: Detail route**

```tsx
// apps/dashboard/src/routes/_authed/projects.$projectId/subscribers/$id.tsx
import { createFileRoute, useParams } from "@tanstack/react-router";
import { Spinner } from "@heroui/react";
import { useSubscriber } from "../../../../lib/hooks/useSubscriber";
import { SubscriberDetailPanel } from "../../../../components/subscribers/SubscriberDetailPanel";

export const Route = createFileRoute("/_authed/projects/$projectId/subscribers/$id")({
  component: SubscriberDetailPage,
});

function SubscriberDetailPage() {
  const { projectId, id } = useParams({
    from: "/_authed/projects/$projectId/subscribers/$id",
  });
  const { data, isLoading, error } = useSubscriber(projectId, id);

  if (isLoading) return <Spinner label="Loading..." />;
  if (error) return <div className="text-danger-500">{error.message}</div>;
  if (!data) return null;
  return <SubscriberDetailPanel data={data} />;
}
```

- [ ] **Step 8: Commit**

```bash
git add apps/dashboard/src/lib/hooks/useSubscriber.ts apps/dashboard/src/components/subscribers/AccessTable.tsx apps/dashboard/src/components/subscribers/PurchasesTable.tsx apps/dashboard/src/components/subscribers/CreditLedgerTable.tsx apps/dashboard/src/components/subscribers/AssignmentsList.tsx apps/dashboard/src/components/subscribers/SubscriberDetailPanel.tsx apps/dashboard/src/routes/_authed/projects.\$projectId/subscribers/\$id.tsx
git commit -m "$(cat <<'EOF'
feat(dashboard): subscriber detail page

Read-only detail composed of five cards: identity/attributes,
access, purchases, credits (balance + ledger), and experiments.
Tables use removeWrapper for a compact look; long attribute JSON
lives behind a <details> to avoid cluttering the viewport.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task B11: MSW handlers + integration tests

**Files:**
- Create: `apps/dashboard/tests/msw/server.ts`
- Create: `apps/dashboard/tests/msw/handlers.ts`
- Create: `apps/dashboard/tests/routes/login.test.tsx`
- Create: `apps/dashboard/tests/routes/projects.test.tsx`
- Create: `apps/dashboard/tests/routes/projects.new.test.tsx`
- Create: `apps/dashboard/tests/routes/subscribers.test.tsx`
- Create: `apps/dashboard/tests/routes/subscriber-detail.test.tsx`

- [ ] **Step 1: MSW server**

```ts
// apps/dashboard/tests/msw/server.ts
import { setupServer } from "msw/node";
import { handlers } from "./handlers";

export const server = setupServer(...handlers);
```

- [ ] **Step 2: MSW handlers**

```ts
// apps/dashboard/tests/msw/handlers.ts
import { http, HttpResponse } from "msw";

const BASE = "http://localhost:3000";

export const handlers = [
  http.get(`${BASE}/api/auth/get-session`, () =>
    HttpResponse.json({ user: { id: "u1", email: "tester@example.com" } }),
  ),

  http.get(`${BASE}/dashboard/projects`, () =>
    HttpResponse.json({
      data: {
        projects: [
          { id: "proj_1", name: "Acme", role: "OWNER", createdAt: "2026-04-01T00:00:00Z" },
        ],
      },
    }),
  ),

  http.get(`${BASE}/dashboard/projects/:id`, ({ params }) =>
    HttpResponse.json({
      data: {
        project: {
          id: params.id,
          name: "Acme",
          webhookUrl: null,
          hasWebhookSecret: false,
          settings: {},
          createdAt: "2026-04-01T00:00:00Z",
          updatedAt: "2026-04-10T00:00:00Z",
          counts: { subscribers: 3, experiments: 1, featureFlags: 2, activeApiKeys: 2 },
          apiKeys: [],
        },
      },
    }),
  ),

  http.post(`${BASE}/dashboard/projects`, async ({ request }) => {
    const body = (await request.json()) as { name: string };
    return HttpResponse.json({
      data: {
        project: {
          id: "proj_new",
          name: body.name,
          webhookUrl: null,
          hasWebhookSecret: false,
          settings: {},
          createdAt: "2026-04-18T00:00:00Z",
          updatedAt: "2026-04-18T00:00:00Z",
          counts: { subscribers: 0, experiments: 0, featureFlags: 0, activeApiKeys: 2 },
          apiKeys: [],
        },
        apiKeys: { publicKey: "rov_pk_test_xxx", secretKey: "rov_sk_test_yyy" },
      },
    });
  }),

  http.get(`${BASE}/dashboard/projects/:id/subscribers`, ({ request }) => {
    const url = new URL(request.url);
    const q = url.searchParams.get("q");
    const subscribers = (q ? [] : [
      {
        id: "sub_1",
        appUserId: "alice",
        attributes: {},
        firstSeenAt: "2026-04-01T00:00:00Z",
        lastSeenAt: "2026-04-18T00:00:00Z",
        purchaseCount: 1,
        activeEntitlementKeys: ["premium"],
      },
      {
        id: "sub_2",
        appUserId: "bob",
        attributes: {},
        firstSeenAt: "2026-04-02T00:00:00Z",
        lastSeenAt: "2026-04-17T00:00:00Z",
        purchaseCount: 0,
        activeEntitlementKeys: [],
      },
    ]);
    return HttpResponse.json({ data: { subscribers, nextCursor: null } });
  }),

  http.get(`${BASE}/dashboard/projects/:projectId/subscribers/:id`, () =>
    HttpResponse.json({
      data: {
        subscriber: {
          id: "sub_1",
          appUserId: "alice",
          attributes: { country: "TR" },
          firstSeenAt: "2026-04-01T00:00:00Z",
          lastSeenAt: "2026-04-18T00:00:00Z",
          deletedAt: null,
          mergedInto: null,
          access: [
            { entitlementKey: "premium", isActive: true, expiresDate: null, store: "APP_STORE", purchaseId: "pur_1" },
          ],
          purchases: [],
          creditBalance: "42",
          creditLedger: [],
          assignments: [],
          outgoingWebhooks: [],
        },
      },
    }),
  ),
];
```

- [ ] **Step 3: Shared test helper for rendering under the router**

Append to `apps/dashboard/tests/setup.ts`:

```ts
// Below the existing imports
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import { HeroUIProvider } from "@heroui/react";
import { render as rtlRender } from "@testing-library/react";
import type { ReactElement } from "react";

export function renderWithRouter(ui: ReactElement, initialPath = "/") {
  const rootRoute = createRootRoute({ component: () => ui });
  const router = createRouter({
    routeTree: rootRoute,
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return rtlRender(
    <HeroUIProvider>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </HeroUIProvider>,
  );
}
```

- [ ] **Step 4: Login test**

```tsx
// apps/dashboard/tests/routes/login.test.tsx
import { describe, expect, test } from "vitest";
import { screen } from "@testing-library/react";
import { renderWithRouter } from "../setup";
import LoginPage from "../../src/routes/login";

describe("<Login />", () => {
  test("renders GitHub and Google buttons", () => {
    renderWithRouter(<LoginPage.Route.options.component />);
    expect(screen.getByRole("button", { name: /github/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /google/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 5: Projects list test**

```tsx
// apps/dashboard/tests/routes/projects.test.tsx
import { describe, expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithRouter } from "../setup";
import ProjectsList from "../../src/routes/_authed/projects";

describe("<ProjectsList />", () => {
  test("renders the project card from the API", async () => {
    renderWithRouter(<ProjectsList.Route.options.component />);
    await waitFor(() =>
      expect(screen.getByText("Acme")).toBeInTheDocument(),
    );
    expect(screen.getByText("OWNER")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: /new project/i })).toBeInTheDocument();
  });
});
```

- [ ] **Step 6: Create-project test**

```tsx
// apps/dashboard/tests/routes/projects.new.test.tsx
import { describe, expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRouter } from "../setup";
import NewProjectPage from "../../src/routes/_authed/projects.new";

describe("<NewProjectPage />", () => {
  test("submitting a valid name reveals both API keys", async () => {
    const user = userEvent.setup();
    renderWithRouter(<NewProjectPage.Route.options.component />);

    await user.type(screen.getByLabelText(/project name/i), "Alpha");
    await user.click(screen.getByRole("button", { name: /create project/i }));

    await waitFor(() =>
      expect(screen.getByText(/save your api keys/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/rov_pk_test_xxx/)).toBeInTheDocument();
    expect(screen.getByText(/rov_sk_test_yyy/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 7: Subscribers list test**

```tsx
// apps/dashboard/tests/routes/subscribers.test.tsx
import { describe, expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderWithRouter } from "../setup";
import SubscribersPage from "../../src/routes/_authed/projects.$projectId/subscribers/index";

describe("<SubscribersPage />", () => {
  test("renders subscribers + filters out when q is set", async () => {
    const user = userEvent.setup();
    renderWithRouter(
      <SubscribersPage.Route.options.component />,
      "/projects/proj_1/subscribers",
    );

    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());
    expect(screen.getByText("bob")).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText(/search/i), "nobody");
    await waitFor(() => expect(screen.queryByText("alice")).toBeNull());
  });
});
```

- [ ] **Step 8: Subscriber detail test**

```tsx
// apps/dashboard/tests/routes/subscriber-detail.test.tsx
import { describe, expect, test } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { renderWithRouter } from "../setup";
import SubscriberDetailPage from "../../src/routes/_authed/projects.$projectId/subscribers/$id";

describe("<SubscriberDetailPage />", () => {
  test("shows appUserId, balance, and the premium entitlement", async () => {
    renderWithRouter(
      <SubscriberDetailPage.Route.options.component />,
      "/projects/proj_1/subscribers/sub_1",
    );
    await waitFor(() => expect(screen.getByText("alice")).toBeInTheDocument());
    expect(screen.getByText(/Balance:/)).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
    expect(screen.getByText("premium")).toBeInTheDocument();
  });
});
```

- [ ] **Step 9: Run the whole dashboard test suite**

Run: `cd apps/dashboard && pnpm exec vitest run`
Expected: every test passes.

- [ ] **Step 10: Commit**

```bash
git add apps/dashboard/tests/
git commit -m "$(cat <<'EOF'
test(dashboard): MSW-backed integration tests for phase 1 routes

Handlers cover every Phase 1 endpoint; tests exercise login (OAuth
buttons render), projects list (card + role chip), project create
(API key reveal), subscribers list (search hides results), and
subscriber detail (balance + entitlement badges). Fast — no real
network, no browser — runs under jsdom in under a second.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task B12: Full-stack smoke verification

**Files:** none (manual verification).

- [ ] **Step 1: Run the whole monorepo build**

Run: `pnpm build`
Expected: `@rovenue/shared`, `@rovenue/api`, `@rovenue/dashboard` all build without type errors.

- [ ] **Step 2: Run every test suite**

```bash
pnpm --filter @rovenue/shared exec vitest run
pnpm --filter @rovenue/api    exec vitest run
pnpm --filter @rovenue/dashboard exec vitest run
```

Expected: all green. No pending or skipped cases.

- [ ] **Step 3: Manual smoke (recorded in the PR description)**

With `docker compose up -d` running the Postgres + Redis services:

```bash
pnpm db:migrate           # applies 2026*_init
pnpm --filter @rovenue/api dev &
pnpm --filter @rovenue/dashboard dev
```

1. Open `http://localhost:5173`
2. Sign in with GitHub
3. Create a project named "Smoke"; copy both API keys
4. From a second terminal, upsert a subscriber via the public SDK API:
   ```bash
   curl -X POST http://localhost:3000/v1/config \
     -H "authorization: Bearer $PUBLIC_KEY" \
     -H "x-rovenue-user-id: smoke_user_1" \
     -H "content-type: application/json" \
     -d '{"attributes":{"country":"TR"}}'
   ```
5. Refresh the dashboard → Subscribers tab → `smoke_user_1` should appear
6. Click through to the detail page; access / purchases / credits tabs render empty state gracefully
7. Rotate the webhook secret in Settings; confirm the new secret is revealed once
8. Delete the project via the danger zone; type the project name to confirm; the UI returns to `/projects`

If any of the above breaks, it's a regression — do NOT paper over it in a test; fix the root cause.

- [ ] **Step 4: Tag the milestone**

```bash
git tag -a dashboard-phase-1 -m "Dashboard Phase 1: auth, projects, subscribers"
```

(No `git push --tags` — the user decides when to share.)

---

## Self-Review Checklist

This section records the final in-plan sanity check so an executor knows what "done" looks like.

**Spec coverage:**
- Section 3.1 (Projects endpoints) — Tasks A3–A5 ✓
- Section 3.2 (Subscribers endpoints) — Tasks A6–A7 ✓
- Section 3.3 (Wire-up) — done inside Tasks A3 + A6 ✓
- Section 3.4 (Testing) — covered in Tasks A3–A7 ✓
- Section 4 (Frontend stack) — Task B1 ✓
- Section 5 (File layout) — Tasks B2–B10 ✓
- Section 6 (Data layer) — Task B3 (api + queryClient) + Task B6 (hooks) ✓
- Section 7 (Auth flow) — Task B5 + Task B6 (authed gate) ✓
- Section 8 (Project tenancy) — Task B4 (`/` redirect) + Task B8 (layout + switcher) ✓
- Section 9.1 (Login) — Task B5 ✓
- Section 9.2 (Project list) — Task B7 ✓
- Section 9.3 (Project create) — Task B7 ✓
- Section 9.4 (Project overview) — Task B8 ✓
- Section 9.5 (Project settings) — Task B8 ✓
- Section 9.6 (Subscribers list) — Task B9 ✓
- Section 9.7 (Subscriber detail) — Task B10 ✓
- Section 10 (Testing) — Task B11 ✓
- Section 12 (Deliverables + acceptance) — Task B12 ✓

**Placeholder scan:** every code block shows the full content to write; no "implement later" stubs.

**Type consistency:** `ProjectSummary`, `ProjectDetail`, `CreateProjectResponse`, `SubscriberListItem`, `SubscriberDetail` defined in Task A2; all hooks and components import from the same shared module. `MemberRole` string literals (`OWNER` / `ADMIN` / `VIEWER`) consistent across backend and shared types.

No gaps to fix.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-18-dashboard-phase-1.md`. Two execution options:

1. **Subagent-Driven (recommended)** — dispatch a fresh subagent per task, review between tasks, keeps the main context clean across the 19 tasks.
2. **Inline Execution** — execute tasks in this session using executing-plans with checkpoints every 3 tasks.
