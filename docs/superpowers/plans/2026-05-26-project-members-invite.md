# Project Members + Invite Flow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the five-role membership model (OWNER / ADMIN / DEVELOPER / GROWTH / CUSTOMER_SUPPORT) plus an end-to-end Amazon-SES-backed invitation flow.

**Architecture:** Replace the existing `OWNER/ADMIN/VIEWER` enum with five roles via a two-file Drizzle migration, introduce a capability-based access helper alongside the existing role-rank one, add a `project_invitations` table, build a reusable `Mailer` abstraction with an SES implementation + bounce webhook, and rebuild the dashboard members page with an invite dialog + public acceptance landing page.

**Tech Stack:**
- Backend: Hono + TypeScript, Drizzle ORM, Postgres 16, BullMQ + Redis
- Email: `@aws-sdk/client-sesv2` (SESv2 API)
- Frontend: React + TanStack Router/Query, TypeScript
- Tests: Vitest unit + integration (testcontainers)

**Source spec:** `docs/superpowers/specs/2026-05-26-project-members-invite-design.md`

---

## Phase ordering

The plan ships in eight phases. Each phase ends green (tests pass, app boots) so the work can be paused / reviewed between them:

1. **Phase 1 — Role enum migration.** Schema + audit-safe data migration. No behaviour change.
2. **Phase 2 — Capability model.** Add capability matrix alongside existing `assertProjectAccess`. Migrate call sites incrementally.
3. **Phase 3 — Member management upgrade.** Rewrite the existing `members.ts` for capability-based perms, self-lockout guard, transfer ownership endpoint.
4. **Phase 4 — Mailer foundation.** `@aws-sdk/client-sesv2`, env vars, `Mailer` transport, templates, BullMQ email queue/worker. No invitation wiring yet.
5. **Phase 5 — Invitations schema + repository.** `project_invitations` table, Drizzle migration, repo methods.
6. **Phase 6 — Invitation API + email send.** Create / list / revoke / resend / public preview + accept endpoints; email worker uses Phase 4 mailer.
7. **Phase 7 — SES bounce webhook + cross-project suppression.** SNS subscription, signature verifier, parser; pre-send suppression check.
8. **Phase 8 — Dashboard rewrite.** Members page redesign, invite dialog, kebab menus, acceptance landing page, hooks + i18n.

---

## Phase 1 — Role enum migration

### Task 1.1: Add new enum variants

**Files:**
- Modify: `packages/db/src/drizzle/enums.ts`
- Create: `packages/db/drizzle/migrations/0038_add_member_role_variants.sql`

- [ ] **Step 1: Update Drizzle enum definition**

Edit `packages/db/src/drizzle/enums.ts:11-15`:

```ts
export const memberRole = pgEnum("MemberRole", [
  "OWNER",
  "ADMIN",
  "DEVELOPER",
  "GROWTH",
  "CUSTOMER_SUPPORT",
  "VIEWER", // deprecated; removed in 0038
]);
```

(Keeping `VIEWER` in the TS enum during this phase so existing code compiles. We drop it in Task 1.3.)

- [ ] **Step 2: Generate baseline migration**

```bash
cd packages/db && pnpm db:migrate:generate
```

Drizzle will produce a stub. Replace its contents with the hand-rolled SQL below at `packages/db/drizzle/migrations/0038_add_member_role_variants.sql`:

```sql
-- ADD VALUE must run outside an explicit transaction block, but Postgres
-- already runs each migration in an implicit one. Splitting these
-- variants into a separate file (with `--> statement-breakpoint`) lets
-- drizzle-kit issue each in its own statement, which Postgres 16 accepts.

ALTER TYPE "MemberRole" ADD VALUE IF NOT EXISTS 'DEVELOPER';
--> statement-breakpoint
ALTER TYPE "MemberRole" ADD VALUE IF NOT EXISTS 'GROWTH';
--> statement-breakpoint
ALTER TYPE "MemberRole" ADD VALUE IF NOT EXISTS 'CUSTOMER_SUPPORT';
```

Also update `packages/db/drizzle/migrations/meta/_journal.json` (drizzle-kit will do this automatically when you regenerate; if you hand-edit, append the new entry).

- [ ] **Step 3: Run migration against local dev DB**

```bash
pnpm db:migrate
```

Expected output: `0038_add_member_role_variants` applied with no errors.

- [ ] **Step 4: Verify variants present**

```bash
psql "$DATABASE_URL" -c "SELECT enum_range(NULL::\"MemberRole\");"
```

Expected:
```
{OWNER,ADMIN,VIEWER,DEVELOPER,GROWTH,CUSTOMER_SUPPORT}
```

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/drizzle/enums.ts packages/db/drizzle/migrations/0038_add_member_role_variants.sql packages/db/drizzle/migrations/meta/
git commit -m "feat(db): add DEVELOPER, GROWTH, CUSTOMER_SUPPORT to MemberRole"
```

### Task 1.2: Backfill VIEWER → CUSTOMER_SUPPORT

**Files:**
- Create: `packages/db/drizzle/migrations/0039_backfill_viewer_to_customer_support.sql`

- [ ] **Step 1: Write the data migration**

Create `packages/db/drizzle/migrations/0039_backfill_viewer_to_customer_support.sql`:

```sql
UPDATE project_members
SET role = 'CUSTOMER_SUPPORT', "updatedAt" = NOW()
WHERE role = 'VIEWER';
```

Update `_journal.json` accordingly.

- [ ] **Step 2: Apply migration**

```bash
pnpm db:migrate
```

- [ ] **Step 3: Verify zero VIEWER rows remain**

```bash
psql "$DATABASE_URL" -c "SELECT role, COUNT(*) FROM project_members GROUP BY role;"
```

Expected: no row with `role = 'VIEWER'`.

- [ ] **Step 4: Commit**

```bash
git add packages/db/drizzle/migrations/0039_backfill_viewer_to_customer_support.sql packages/db/drizzle/migrations/meta/
git commit -m "feat(db): migrate VIEWER members to CUSTOMER_SUPPORT"
```

### Task 1.3: Drop VIEWER from enum

**Files:**
- Modify: `packages/db/src/drizzle/enums.ts`
- Create: `packages/db/drizzle/migrations/0040_drop_viewer_member_role.sql`
- Modify: every file currently referencing `MemberRole.VIEWER` (Task 1.4 maps these explicitly)

- [ ] **Step 1: Audit call sites**

```bash
grep -rln "MemberRole\.VIEWER\|'VIEWER'" apps packages | grep -v "\.test\." | grep -v dist
```

Expected files (current state):
- `apps/api/src/lib/project-access.ts`
- `apps/api/src/routes/dashboard/*.ts` (many)
- `apps/api/src/routes/dashboard/members.ts`
- `packages/shared/src/dashboard.ts`

DO NOT change these in this task — Task 1.4 rewrites them as one batch. Just confirm the list matches expectation.

- [ ] **Step 2: Write enum-swap migration**

Create `packages/db/drizzle/migrations/0040_drop_viewer_member_role.sql`:

```sql
-- Postgres cannot DROP VALUE from an enum, so we rebuild the type.
-- All consumers are migrated to CUSTOMER_SUPPORT in 0038, so this is
-- a clean swap.

CREATE TYPE "MemberRole_new" AS ENUM (
  'OWNER', 'ADMIN', 'DEVELOPER', 'GROWTH', 'CUSTOMER_SUPPORT'
);
--> statement-breakpoint
ALTER TABLE project_members
  ALTER COLUMN role TYPE "MemberRole_new"
  USING role::text::"MemberRole_new";
--> statement-breakpoint
DROP TYPE "MemberRole";
--> statement-breakpoint
ALTER TYPE "MemberRole_new" RENAME TO "MemberRole";
```

- [ ] **Step 3: Update Drizzle TS enum to drop VIEWER**

Edit `packages/db/src/drizzle/enums.ts`:

```ts
export const memberRole = pgEnum("MemberRole", [
  "OWNER",
  "ADMIN",
  "DEVELOPER",
  "GROWTH",
  "CUSTOMER_SUPPORT",
]);
```

- [ ] **Step 4: Run migration**

```bash
pnpm db:migrate
```

Expected: `0040_drop_viewer_member_role` applied. `psql ... -c "SELECT enum_range(NULL::\"MemberRole\");"` should output `{OWNER,ADMIN,DEVELOPER,GROWTH,CUSTOMER_SUPPORT}`.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/drizzle/enums.ts packages/db/drizzle/migrations/0040_drop_viewer_member_role.sql packages/db/drizzle/migrations/meta/
git commit -m "feat(db): drop VIEWER from MemberRole enum"
```

### Task 1.4: Update MemberRole call sites

**Files:**
- Modify (consolidated below, but be explicit on the diff per file):
  - `apps/api/src/lib/project-access.ts` — rank table
  - `apps/api/src/routes/dashboard/members.ts`
  - `apps/api/src/routes/dashboard/credits.ts`
  - `apps/api/src/routes/dashboard/feature-flags.ts`
  - `apps/api/src/routes/dashboard/product-groups.ts`
  - `apps/api/src/routes/dashboard/projects.ts`
  - `apps/api/src/routes/dashboard/queries.ts`
  - `apps/api/src/routes/dashboard/experiments.ts`
  - `apps/api/src/routes/dashboard/leaderboards.ts`
  - `apps/api/src/routes/dashboard/apps.ts`
  - `apps/api/src/routes/dashboard/audiences.ts`
  - `apps/api/src/routes/dashboard/subscribers.ts`
  - `apps/api/src/routes/dashboard/subscriptions.ts`
  - `apps/api/src/routes/dashboard/credentials.ts`
  - `apps/api/src/routes/dashboard/events-stream.ts`
  - `apps/api/src/routes/dashboard/metrics.ts`
  - `apps/api/src/routes/dashboard/webhooks.ts`
  - `apps/api/src/routes/dashboard/overview.ts`
  - `apps/api/src/routes/dashboard/products.ts`
  - `apps/api/src/routes/dashboard/transactions.ts`
  - `apps/api/src/routes/dashboard/charts.ts`
  - `apps/api/src/routes/dashboard/cohorts.ts`
  - `packages/shared/src/dashboard.ts`

- [ ] **Step 1: Update role-rank table**

Edit `apps/api/src/lib/project-access.ts:19-23`. Replace the `ROLE_RANK` block with:

```ts
// Numeric ordering: higher = more privileged. OWNER > ADMIN >
// DEVELOPER ≈ GROWTH ≈ CUSTOMER_SUPPORT (read-only callers get the
// same baseline rank — capability gates handle the per-feature splits;
// see Phase 2).
const ROLE_RANK: Record<MemberRole, number> = {
  [MemberRole.OWNER]: 4,
  [MemberRole.ADMIN]: 3,
  [MemberRole.DEVELOPER]: 2,
  [MemberRole.GROWTH]: 2,
  [MemberRole.CUSTOMER_SUPPORT]: 2,
};
```

Then update the `assertProjectAccess` default:

```ts
export async function assertProjectAccess(
  projectId: string,
  userId: string,
  // Any project member can pass the baseline check. Use capability
  // gates (Phase 2) for finer per-feature splits.
  minimumRole: MemberRole = MemberRole.CUSTOMER_SUPPORT,
): Promise<ProjectMembership> {
```

- [ ] **Step 2: Sweep VIEWER → CUSTOMER_SUPPORT in routes**

For each route file in the list above, replace any `MemberRole.VIEWER` with `MemberRole.CUSTOMER_SUPPORT`. This preserves "any member can read" semantics by default; Phase 2 narrows specific routes.

Use this exact command (verify the diff before commit):

```bash
grep -rln "MemberRole\.VIEWER" apps/api/src | xargs sed -i '' 's/MemberRole\.VIEWER/MemberRole.CUSTOMER_SUPPORT/g'
```

- [ ] **Step 3: Update `members.ts` enum literal list**

In `apps/api/src/routes/dashboard/members.ts:25-29`, replace the `memberRoleValues` array:

```ts
const memberRoleValues = [
  MemberRole.OWNER,
  MemberRole.ADMIN,
  MemberRole.DEVELOPER,
  MemberRole.GROWTH,
  MemberRole.CUSTOMER_SUPPORT,
] as const;
```

- [ ] **Step 4: Update shared types**

Edit `packages/shared/src/dashboard.ts:10`:

```ts
export type MemberRoleName =
  | "OWNER"
  | "ADMIN"
  | "DEVELOPER"
  | "GROWTH"
  | "CUSTOMER_SUPPORT";

/** Roles a user can be invited or reassigned to via the UI. */
export const ASSIGNABLE_ROLES = [
  "ADMIN",
  "DEVELOPER",
  "GROWTH",
  "CUSTOMER_SUPPORT",
] as const satisfies ReadonlyArray<MemberRoleName>;
export type AssignableRole = (typeof ASSIGNABLE_ROLES)[number];
```

And update `CreateInvitationRequest` already in the file to use `AssignableRole` once we add it in Phase 5 — for now `AssignableRole` is just exported so the rest of the code can import it.

- [ ] **Step 5: Run typechecks**

```bash
pnpm -r build
```

Expected: every workspace compiles. Address any leftover `VIEWER` references the sweep missed.

- [ ] **Step 6: Run tests**

```bash
pnpm test
```

Expected: all green. (Integration tests that use `MemberRole.VIEWER` should have been swept too — re-run the grep with `--include='*.test.ts'` if anything fails.)

- [ ] **Step 7: Commit**

```bash
git add apps packages
git commit -m "refactor: replace MemberRole.VIEWER with CUSTOMER_SUPPORT across call sites"
```

---

## Phase 2 — Capability model

### Task 2.1: Capability table + `assertProjectCapability`

**Files:**
- Create: `apps/api/src/lib/capabilities.ts`
- Modify: `apps/api/src/lib/project-access.ts`
- Test: `apps/api/src/lib/capabilities.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/lib/capabilities.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { roleHasCapability } from "./capabilities";

describe("roleHasCapability", () => {
  it("OWNER can do everything", () => {
    expect(roleHasCapability("OWNER", "project:delete")).toBe(true);
    expect(roleHasCapability("OWNER", "members:manage")).toBe(true);
    expect(roleHasCapability("OWNER", "credits:write")).toBe(true);
  });

  it("ADMIN can manage members but not delete project", () => {
    expect(roleHasCapability("ADMIN", "members:manage")).toBe(true);
    expect(roleHasCapability("ADMIN", "project:delete")).toBe(false);
    expect(roleHasCapability("ADMIN", "project:transfer")).toBe(false);
  });

  it("DEVELOPER can write to product/sdk/webhook routes", () => {
    expect(roleHasCapability("DEVELOPER", "products:write")).toBe(true);
    expect(roleHasCapability("DEVELOPER", "sdk:write")).toBe(true);
    expect(roleHasCapability("DEVELOPER", "webhooks:write")).toBe(true);
    expect(roleHasCapability("DEVELOPER", "members:manage")).toBe(false);
  });

  it("GROWTH can write to experiments + audiences but not credits", () => {
    expect(roleHasCapability("GROWTH", "experiments:write")).toBe(true);
    expect(roleHasCapability("GROWTH", "audiences:write")).toBe(true);
    expect(roleHasCapability("GROWTH", "credits:write")).toBe(false);
    expect(roleHasCapability("GROWTH", "products:write")).toBe(false);
  });

  it("CUSTOMER_SUPPORT can write to subscribers + credits only", () => {
    expect(roleHasCapability("CUSTOMER_SUPPORT", "subscribers:write")).toBe(
      true,
    );
    expect(roleHasCapability("CUSTOMER_SUPPORT", "credits:write")).toBe(true);
    expect(roleHasCapability("CUSTOMER_SUPPORT", "experiments:write")).toBe(
      false,
    );
  });

  it("every role can read", () => {
    for (const role of [
      "OWNER",
      "ADMIN",
      "DEVELOPER",
      "GROWTH",
      "CUSTOMER_SUPPORT",
    ] as const) {
      expect(roleHasCapability(role, "project:read")).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @rovenue/api test capabilities.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement capabilities**

Create `apps/api/src/lib/capabilities.ts`:

```ts
import { HTTPException } from "hono/http-exception";
import { drizzle, type MemberRole } from "@rovenue/db";

export type Capability =
  | "project:read"
  | "project:delete"
  | "project:transfer"
  | "project:settings:write"
  | "members:manage"
  | "products:write"
  | "sdk:write"
  | "webhooks:write"
  | "experiments:write"
  | "flags:write"
  | "audiences:write"
  | "leaderboards:write"
  | "subscribers:write"
  | "credits:write";

const CAPABILITY_ROLES: Record<Capability, ReadonlyArray<MemberRole>> = {
  "project:read": [
    "OWNER",
    "ADMIN",
    "DEVELOPER",
    "GROWTH",
    "CUSTOMER_SUPPORT",
  ],
  "project:delete": ["OWNER"],
  "project:transfer": ["OWNER"],
  "project:settings:write": ["OWNER", "ADMIN"],
  "members:manage": ["OWNER", "ADMIN"],
  "products:write": ["OWNER", "ADMIN", "DEVELOPER"],
  "sdk:write": ["OWNER", "ADMIN", "DEVELOPER"],
  "webhooks:write": ["OWNER", "ADMIN", "DEVELOPER"],
  "experiments:write": ["OWNER", "ADMIN", "DEVELOPER", "GROWTH"],
  "flags:write": ["OWNER", "ADMIN", "DEVELOPER", "GROWTH"],
  "audiences:write": ["OWNER", "ADMIN", "DEVELOPER", "GROWTH"],
  "leaderboards:write": ["OWNER", "ADMIN", "DEVELOPER", "GROWTH"],
  "subscribers:write": ["OWNER", "ADMIN", "DEVELOPER", "CUSTOMER_SUPPORT"],
  "credits:write": ["OWNER", "ADMIN", "DEVELOPER", "CUSTOMER_SUPPORT"],
};

export function roleHasCapability(
  role: MemberRole,
  cap: Capability,
): boolean {
  return CAPABILITY_ROLES[cap].includes(role);
}

export async function assertProjectCapability(
  projectId: string,
  userId: string,
  cap: Capability,
): Promise<{ id: string; role: MemberRole }> {
  const membership = await drizzle.projectRepo.findMembership(
    drizzle.db,
    projectId,
    userId,
  );
  if (!membership) {
    throw new HTTPException(403, {
      message: "Not a member of this project",
    });
  }
  if (!roleHasCapability(membership.role, cap)) {
    throw new HTTPException(403, {
      message: `Role ${membership.role} lacks capability ${cap}`,
    });
  }
  return membership;
}
```

- [ ] **Step 4: Run tests**

Run: `pnpm --filter @rovenue/api test capabilities.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/capabilities.ts apps/api/src/lib/capabilities.test.ts
git commit -m "feat(api): add capability matrix + assertProjectCapability"
```

### Task 2.2: Migrate write routes to capability gates

**Files:**
- Modify: `apps/api/src/routes/dashboard/{credits,feature-flags,product-groups,experiments,leaderboards,webhooks,products,audiences,credentials,subscribers,subscriptions,charts,cohorts,apps}.ts`

The current pattern is `assertProjectAccess(projectId, userId, MemberRole.ADMIN)` for write routes. We replace each call with the most specific capability available, leaving the existing `assertProjectAccess` for read-only routes (Phase 3 finishes the cleanup).

- [ ] **Step 1: Map each route to a capability**

Apply the following substitutions per file (each is `assertProjectAccess(..., MemberRole.ADMIN)` → `assertProjectCapability(..., "<cap>")`). All other lines stay identical.

| File | Substitute MemberRole.ADMIN with capability |
|---|---|
| `credits.ts` | `"credits:write"` |
| `feature-flags.ts` | `"flags:write"` |
| `product-groups.ts` | `"products:write"` |
| `products.ts` | `"products:write"` |
| `experiments.ts` | `"experiments:write"` |
| `webhooks.ts` | `"webhooks:write"` |
| `audiences.ts` | `"audiences:write"` |
| `leaderboards.ts` | `"leaderboards:write"` |
| `subscribers.ts` | `"subscribers:write"` |
| `subscriptions.ts` | `"subscribers:write"` |
| `credentials.ts` | `"project:settings:write"` |
| `charts.ts` | `"project:settings:write"` |
| `cohorts.ts` | `"audiences:write"` |
| `apps.ts` | `"sdk:write"` |

- [ ] **Step 2: Apply substitution per file**

For each file in the table above, open it, find the `assertProjectAccess(..., MemberRole.ADMIN)` call(s), replace with `assertProjectCapability(..., "<cap>")`, and update imports:

```ts
// Add to imports near top of file:
import { assertProjectCapability } from "../../lib/capabilities";
// Remove the MemberRole import if no longer used.
```

- [ ] **Step 3: Run tests**

```bash
pnpm test
```

Expected: all green. (The capability gates are at least as permissive as the old ADMIN-or-higher check; existing tests using OWNER/ADMIN sessions will continue to pass.)

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/routes/dashboard
git commit -m "refactor(api): migrate write routes to capability gates"
```

### Task 2.3: Integration test — capability enforcement

**Files:**
- Test: `apps/api/src/routes/dashboard/capabilities.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/dashboard/capabilities.integration.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { app } from "../../app";
import { drizzle } from "@rovenue/db";
import { createTestProject, createTestUser, sessionFor } from "../../test/factories";

// Smoke test: a CUSTOMER_SUPPORT member can credit a subscriber
// but cannot edit feature flags. A GROWTH member is the inverse.

describe("capability enforcement", () => {
  let projectId: string;
  let supportSession: string;
  let growthSession: string;

  beforeAll(async () => {
    const { projectId: pid, ownerSession } = await createTestProject();
    projectId = pid;

    const support = await createTestUser();
    const growth = await createTestUser();
    await drizzle.projectRepo.createProjectMember(drizzle.db, {
      projectId,
      userId: support.id,
      role: "CUSTOMER_SUPPORT",
    });
    await drizzle.projectRepo.createProjectMember(drizzle.db, {
      projectId,
      userId: growth.id,
      role: "GROWTH",
    });
    supportSession = await sessionFor(support.id);
    growthSession = await sessionFor(growth.id);
  });

  it("CUSTOMER_SUPPORT can write to credits:write routes", async () => {
    const res = await app.request(`/dashboard/credits/grant`, {
      method: "POST",
      headers: {
        cookie: supportSession,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        projectId,
        subscriberId: "sub_dummy",
        amount: 10,
        reason: "test",
      }),
    });
    // The body is invalid (subscriber doesn't exist) so we expect a
    // 4xx OTHER than 403. The point is the capability check passes.
    expect(res.status).not.toBe(403);
  });

  it("CUSTOMER_SUPPORT cannot edit feature flags", async () => {
    const res = await app.request(`/dashboard/feature-flags`, {
      method: "POST",
      headers: {
        cookie: supportSession,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        projectId,
        key: "f1",
        type: "BOOLEAN",
        defaultValue: { value: false },
      }),
    });
    expect(res.status).toBe(403);
  });

  it("GROWTH can edit feature flags but not credits", async () => {
    const ff = await app.request(`/dashboard/feature-flags`, {
      method: "POST",
      headers: {
        cookie: growthSession,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        projectId,
        key: "f2",
        type: "BOOLEAN",
        defaultValue: { value: true },
      }),
    });
    expect(ff.status).not.toBe(403);

    const credit = await app.request(`/dashboard/credits/grant`, {
      method: "POST",
      headers: {
        cookie: growthSession,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        projectId,
        subscriberId: "sub_dummy",
        amount: 10,
        reason: "test",
      }),
    });
    expect(credit.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run test**

```bash
pnpm --filter @rovenue/api test capabilities.integration.test.ts
```

Expected: PASS (or FAIL only if `createTestProject`/`createTestUser`/`sessionFor` factories don't exist yet — in that case, locate the existing test factory file the integration tests use and add the helpers).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/routes/dashboard/capabilities.integration.test.ts
git commit -m "test(api): capability enforcement integration test"
```

---

## Phase 3 — Member management upgrade

### Task 3.1: Rewrite member routes for capability + self-lockout

**Files:**
- Modify: `apps/api/src/routes/dashboard/members.ts`
- Test: `apps/api/src/routes/dashboard/members.integration.test.ts`

- [ ] **Step 1: Write the failing integration tests**

Append (or create) `apps/api/src/routes/dashboard/members.integration.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { app } from "../../app";
import { drizzle } from "@rovenue/db";
import { createTestProject, createTestUser, sessionFor } from "../../test/factories";

describe("members API", () => {
  it("ADMIN can patch another member's role (non-OWNER target)", async () => {
    const { projectId, ownerSession } = await createTestProject();
    const adminUser = await createTestUser();
    const targetUser = await createTestUser();
    await drizzle.projectRepo.createProjectMember(drizzle.db, {
      projectId, userId: adminUser.id, role: "ADMIN",
    });
    await drizzle.projectRepo.createProjectMember(drizzle.db, {
      projectId, userId: targetUser.id, role: "DEVELOPER",
    });
    const adminSession = await sessionFor(adminUser.id);

    const res = await app.request(
      `/dashboard/projects/${projectId}/members/${targetUser.id}`,
      {
        method: "PATCH",
        headers: { cookie: adminSession, "content-type": "application/json" },
        body: JSON.stringify({ role: "GROWTH" }),
      },
    );
    expect(res.status).toBe(200);
  });

  it("PATCH /members/:userId cannot set role to OWNER", async () => {
    const { projectId, ownerSession, ownerUserId } = await createTestProject();
    const target = await createTestUser();
    await drizzle.projectRepo.createProjectMember(drizzle.db, {
      projectId, userId: target.id, role: "DEVELOPER",
    });
    const res = await app.request(
      `/dashboard/projects/${projectId}/members/${target.id}`,
      {
        method: "PATCH",
        headers: { cookie: ownerSession, "content-type": "application/json" },
        body: JSON.stringify({ role: "OWNER" }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("caller cannot change own role", async () => {
    const { projectId, ownerSession, ownerUserId } = await createTestProject();
    const res = await app.request(
      `/dashboard/projects/${projectId}/members/${ownerUserId}`,
      {
        method: "PATCH",
        headers: { cookie: ownerSession, "content-type": "application/json" },
        body: JSON.stringify({ role: "ADMIN" }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("DELETE /members/:userId cannot remove an OWNER", async () => {
    const { projectId, ownerSession, ownerUserId } = await createTestProject();
    const res = await app.request(
      `/dashboard/projects/${projectId}/members/${ownerUserId}`,
      { method: "DELETE", headers: { cookie: ownerSession } },
    );
    expect(res.status).toBe(400);
  });

  it("POST /members/transfer: target becomes OWNER, caller becomes ADMIN", async () => {
    const { projectId, ownerSession, ownerUserId } = await createTestProject();
    const target = await createTestUser();
    await drizzle.projectRepo.createProjectMember(drizzle.db, {
      projectId, userId: target.id, role: "ADMIN",
    });

    const res = await app.request(
      `/dashboard/projects/${projectId}/members/transfer`,
      {
        method: "POST",
        headers: { cookie: ownerSession, "content-type": "application/json" },
        body: JSON.stringify({ toUserId: target.id }),
      },
    );
    expect(res.status).toBe(200);

    const newOwner = await drizzle.projectRepo.findMembership(
      drizzle.db, projectId, target.id,
    );
    const oldOwner = await drizzle.projectRepo.findMembership(
      drizzle.db, projectId, ownerUserId,
    );
    expect(newOwner?.role).toBe("OWNER");
    expect(oldOwner?.role).toBe("ADMIN");
  });

  it("POST /members/transfer: cannot transfer to self", async () => {
    const { projectId, ownerSession, ownerUserId } = await createTestProject();
    const res = await app.request(
      `/dashboard/projects/${projectId}/members/transfer`,
      {
        method: "POST",
        headers: { cookie: ownerSession, "content-type": "application/json" },
        body: JSON.stringify({ toUserId: ownerUserId }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("POST /members/transfer: target must be a member", async () => {
    const { projectId, ownerSession } = await createTestProject();
    const stranger = await createTestUser();
    const res = await app.request(
      `/dashboard/projects/${projectId}/members/transfer`,
      {
        method: "POST",
        headers: { cookie: ownerSession, "content-type": "application/json" },
        body: JSON.stringify({ toUserId: stranger.id }),
      },
    );
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run tests to confirm failures**

```bash
pnpm --filter @rovenue/api test members.integration.test.ts
```

Expected failures: `PATCH cannot set role to OWNER` (currently allowed), `caller cannot change own role` (no guard), `POST /members/transfer` (route doesn't exist), `ADMIN can patch` (ADMIN currently blocked by OWNER-only guard).

- [ ] **Step 3: Rewrite `members.ts`**

Replace the contents of `apps/api/src/routes/dashboard/members.ts` with the full implementation below:

```ts
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { MemberRole, drizzle } from "@rovenue/db";
import type {
  ListMembersResponse,
  ProjectMemberRow,
} from "@rovenue/shared";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectCapability } from "../../lib/capabilities";
import { audit, extractRequestContext } from "../../lib/audit";
import { ok } from "../../lib/response";

const ASSIGNABLE_ROLE_VALUES = [
  MemberRole.ADMIN,
  MemberRole.DEVELOPER,
  MemberRole.GROWTH,
  MemberRole.CUSTOMER_SUPPORT,
] as const;

export const updateMemberBodySchema = z.object({
  role: z.enum(ASSIGNABLE_ROLE_VALUES),
});

export const transferOwnershipBodySchema = z.object({
  toUserId: z.string().min(1),
});

function toMemberRow(m: {
  id: string;
  userId: string;
  role: MemberRole;
  createdAt: Date;
  user: { email: string; name: string | null; image: string | null };
}): ProjectMemberRow {
  return {
    id: m.id,
    userId: m.userId,
    email: m.user.email,
    name: m.user.name,
    image: m.user.image,
    role: m.role,
    createdAt: m.createdAt.toISOString(),
  };
}

async function countOwners(projectId: string): Promise<number> {
  return drizzle.projectRepo.countProjectOwners(drizzle.db, projectId);
}

export const membersRoute = new Hono()
  .use("*", requireDashboardAuth)

  // GET /dashboard/projects/:projectId/members
  .get("/", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId)
      throw new HTTPException(400, { message: "Missing projectId" });
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "project:read");

    const rows = await drizzle.projectRepo.listProjectMembers(
      drizzle.db, projectId,
    );
    const payload: ListMembersResponse = { members: rows.map(toMemberRow) };
    return c.json(ok(payload));
  })

  // PATCH /dashboard/projects/:projectId/members/:userId
  .patch(
    "/:userId",
    zValidator("json", updateMemberBodySchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      const targetUserId = c.req.param("userId");
      if (!projectId || !targetUserId)
        throw new HTTPException(400, { message: "Missing projectId or userId" });
      const user = c.get("user");
      await assertProjectCapability(projectId, user.id, "members:manage");
      const body = c.req.valid("json");

      if (targetUserId === user.id) {
        throw new HTTPException(400, {
          message: "Cannot change your own role",
        });
      }

      const target = await drizzle.projectRepo.findMembership(
        drizzle.db, projectId, targetUserId,
      );
      if (!target)
        throw new HTTPException(404, { message: "Member not found" });
      if (target.role === MemberRole.OWNER) {
        throw new HTTPException(400, {
          message: "Cannot modify an OWNER. Transfer ownership first.",
        });
      }

      const updated = await drizzle.db.transaction(async (tx) => {
        const row = await drizzle.projectRepo.updateProjectMemberRole(
          tx, projectId, targetUserId, body.role,
        );
        if (!row)
          throw new HTTPException(404, { message: "Member not found" });
        await audit(
          {
            projectId,
            userId: user.id,
            action: "member.role_changed",
            resource: "member",
            resourceId: row.id,
            before: { role: target.role },
            after: { role: body.role },
            ...extractRequestContext(c),
          },
          tx,
        );
        return row;
      });

      return c.json(ok({ member: toMemberRow(updated) }));
    },
  )

  // DELETE /dashboard/projects/:projectId/members/:userId
  .delete("/:userId", async (c) => {
    const projectId = c.req.param("projectId");
    const targetUserId = c.req.param("userId");
    if (!projectId || !targetUserId)
      throw new HTTPException(400, { message: "Missing projectId or userId" });
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "members:manage");

    if (targetUserId === user.id) {
      throw new HTTPException(400, {
        message: "Use POST /members/leave to remove yourself",
      });
    }

    const target = await drizzle.projectRepo.findMembership(
      drizzle.db, projectId, targetUserId,
    );
    if (!target)
      throw new HTTPException(404, { message: "Member not found" });
    if (target.role === MemberRole.OWNER) {
      throw new HTTPException(400, {
        message: "Cannot remove an OWNER. Transfer ownership first.",
      });
    }

    await drizzle.db.transaction(async (tx) => {
      await audit(
        {
          projectId,
          userId: user.id,
          action: "member.removed",
          resource: "member",
          resourceId: target.id,
          before: { userId: targetUserId, role: target.role },
          ...extractRequestContext(c),
        },
        tx,
      );
      await drizzle.projectRepo.deleteProjectMember(tx, projectId, targetUserId);
    });

    return c.json(ok({ id: target.id }));
  })

  // POST /dashboard/projects/:projectId/members/leave
  .post("/leave", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId)
      throw new HTTPException(400, { message: "Missing projectId" });
    const user = c.get("user");
    const membership = await assertProjectCapability(
      projectId, user.id, "project:read",
    );

    if (membership.role === MemberRole.OWNER) {
      const owners = await countOwners(projectId);
      if (owners <= 1) {
        throw new HTTPException(400, {
          message: "Cannot leave: you are the last OWNER",
        });
      }
    }

    await drizzle.db.transaction(async (tx) => {
      await audit(
        {
          projectId,
          userId: user.id,
          action: "member.left",
          resource: "member",
          resourceId: membership.id,
          before: { userId: user.id, role: membership.role },
          ...extractRequestContext(c),
        },
        tx,
      );
      await drizzle.projectRepo.deleteProjectMember(tx, projectId, user.id);
    });

    return c.json(ok({ left: true }));
  })

  // POST /dashboard/projects/:projectId/members/transfer
  .post(
    "/transfer",
    zValidator("json", transferOwnershipBodySchema),
    async (c) => {
      const projectId = c.req.param("projectId");
      if (!projectId)
        throw new HTTPException(400, { message: "Missing projectId" });
      const user = c.get("user");
      await assertProjectCapability(projectId, user.id, "project:transfer");
      const { toUserId } = c.req.valid("json");

      if (toUserId === user.id) {
        throw new HTTPException(400, {
          message: "Cannot transfer ownership to yourself",
        });
      }

      const target = await drizzle.projectRepo.findMembership(
        drizzle.db, projectId, toUserId,
      );
      if (!target) {
        throw new HTTPException(404, {
          message: "Target user is not a member of this project",
        });
      }
      if (target.role === MemberRole.OWNER) {
        throw new HTTPException(409, {
          message: "Target is already an OWNER",
        });
      }

      await drizzle.db.transaction(async (tx) => {
        await drizzle.projectRepo.updateProjectMemberRole(
          tx, projectId, toUserId, MemberRole.OWNER,
        );
        await drizzle.projectRepo.updateProjectMemberRole(
          tx, projectId, user.id, MemberRole.ADMIN,
        );
        await audit(
          {
            projectId,
            userId: user.id,
            action: "member.ownership_transferred",
            resource: "project",
            resourceId: projectId,
            before: { ownerUserId: user.id },
            after: { ownerUserId: toUserId },
            ...extractRequestContext(c),
          },
          tx,
        );
      });

      return c.json(ok({ transferred: true }));
    },
  );
```

Note: the prior POST `/` (direct add-by-email) is removed. Phase 6 replaces it with the invitation flow.

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @rovenue/api test members
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/dashboard/members.ts apps/api/src/routes/dashboard/members.integration.test.ts
git commit -m "feat(api): capability-based member mgmt + transfer ownership + guards"
```

---

## Phase 4 — Mailer foundation

### Task 4.1: SES SDK dependency + env vars

**Files:**
- Modify: `apps/api/package.json`
- Modify: `apps/api/src/lib/env.ts`
- Modify: `.env.example`

- [ ] **Step 1: Add the SDK**

```bash
cd apps/api && pnpm add @aws-sdk/client-sesv2
```

- [ ] **Step 2: Add env vars**

Edit `apps/api/src/lib/env.ts`. Inside the `z.object({...})` (before `.superRefine`), add:

```ts
    AWS_SES_REGION: z.string().min(1).default("us-east-1"),
    AWS_SES_FROM_EMAIL: z.string().email().optional(),
    AWS_SES_CONFIGURATION_SET: z.string().min(1).optional(),
    AWS_SES_EVENTS_VERIFY_SIGNATURE: z
      .enum(["true", "false"])
      .default("true")
      .transform((v) => v === "true"),
```

No production-required check — SES is opt-in.

- [ ] **Step 3: Append to `.env.example`**

Append to `.env.example`:

```
# ---- Amazon SES (optional; enables invite emails) ----
AWS_SES_REGION=us-east-1
AWS_SES_FROM_EMAIL=
AWS_SES_CONFIGURATION_SET=
AWS_SES_EVENTS_VERIFY_SIGNATURE=true
# AWS credentials come from the default SDK provider chain:
#   AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY (env vars, dev/static)
#   or an IAM role attached to the host (recommended for prod).
```

- [ ] **Step 4: Typecheck**

```bash
pnpm -r build
```

Expected: builds clean.

- [ ] **Step 5: Commit**

```bash
git add apps/api/package.json apps/api/pnpm-lock.yaml apps/api/src/lib/env.ts .env.example
git commit -m "feat(api): add AWS SES SDK + env vars"
```

### Task 4.2: Mailer transport

**Files:**
- Create: `apps/api/src/lib/mailer.ts`
- Test: `apps/api/src/lib/mailer.test.ts`

- [ ] **Step 1: Write the failing test**

```bash
cd apps/api && pnpm add -D aws-sdk-client-mock
```

Create `apps/api/src/lib/mailer.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  SESv2Client,
  SendEmailCommand,
} from "@aws-sdk/client-sesv2";
import {
  __setMailerForTests,
  mailer,
  type Mailer,
} from "./mailer";

describe("mailer", () => {
  afterEach(() => __setMailerForTests(null));

  it("NoopMailer is used when AWS_SES_FROM_EMAIL is unset", async () => {
    // env at import time decides. We can't easily simulate it here,
    // so we exercise the interface directly:
    class RecordingNoop implements Mailer {
      sent: Array<{ to: string; subject: string }> = [];
      async send(m: any) {
        this.sent.push({ to: m.to, subject: m.subject });
        return { messageId: "noop" };
      }
    }
    const rec = new RecordingNoop();
    __setMailerForTests(rec);
    const out = await mailer().send({
      to: "a@b.com", subject: "hi", html: "<p>hi</p>", text: "hi",
    });
    expect(out.messageId).toBe("noop");
    expect(rec.sent).toEqual([{ to: "a@b.com", subject: "hi" }]);
  });

  it("SesMailer sends via SESv2 SendEmailCommand", async () => {
    const sesMock = mockClient(SESv2Client);
    sesMock.on(SendEmailCommand).resolves({ MessageId: "ses-id-42" });

    // Build a fresh SesMailer with the mocked client by exposing it via
    // __setMailerForTests, simulating what the production factory does.
    const { _SesMailerForTests } = await import("./mailer");
    const m = new _SesMailerForTests(
      new SESv2Client({ region: "us-east-1" }),
      "noreply@example.com",
      "rovenue-events",
    );

    const out = await m.send({
      to: "alex@example.com",
      subject: "Welcome",
      html: "<p>hi</p>",
      text: "hi",
      correlationId: "inv_abc",
    });
    expect(out.messageId).toBe("ses-id-42");

    const calls = sesMock.commandCalls(SendEmailCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0].args[0].input;
    expect(input.FromEmailAddress).toBe("noreply@example.com");
    expect(input.Destination?.ToAddresses).toEqual(["alex@example.com"]);
    expect(input.ConfigurationSetName).toBe("rovenue-events");
    expect(input.Content?.Simple?.Subject?.Data).toBe("Welcome");
    expect(input.Content?.Simple?.Headers).toEqual([
      { Name: "X-Rovenue-Id", Value: "inv_abc" },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
pnpm --filter @rovenue/api test mailer.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement the transport**

Create `apps/api/src/lib/mailer.ts`:

```ts
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import { env } from "./env";
import { logger } from "./logger";

export interface MailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
  correlationId?: string;
}

export interface Mailer {
  send(msg: MailMessage): Promise<{ messageId: string }>;
}

class SesMailer implements Mailer {
  constructor(
    private client: SESv2Client,
    private from: string,
    private configurationSet?: string,
  ) {}

  async send(msg: MailMessage) {
    const cmd = new SendEmailCommand({
      FromEmailAddress: this.from,
      Destination: { ToAddresses: [msg.to] },
      ConfigurationSetName: this.configurationSet,
      Content: {
        Simple: {
          Subject: { Data: msg.subject, Charset: "UTF-8" },
          Body: {
            Html: { Data: msg.html, Charset: "UTF-8" },
            Text: { Data: msg.text, Charset: "UTF-8" },
          },
          Headers: msg.correlationId
            ? [{ Name: "X-Rovenue-Id", Value: msg.correlationId }]
            : undefined,
        },
      },
    });
    const out = await this.client.send(cmd);
    return { messageId: out.MessageId ?? "" };
  }
}

class NoopMailer implements Mailer {
  async send(msg: MailMessage) {
    logger.warn("mailer.noop", { to: msg.to, subject: msg.subject });
    return { messageId: "noop" };
  }
}

let _mailer: Mailer | null = null;

export function mailer(): Mailer {
  if (_mailer) return _mailer;
  if (!env.AWS_SES_FROM_EMAIL) {
    _mailer = new NoopMailer();
    return _mailer;
  }
  const client = new SESv2Client({ region: env.AWS_SES_REGION });
  _mailer = new SesMailer(
    client,
    env.AWS_SES_FROM_EMAIL,
    env.AWS_SES_CONFIGURATION_SET ?? undefined,
  );
  return _mailer;
}

export function __setMailerForTests(m: Mailer | null) {
  _mailer = m;
}

// Exported only for unit tests; production callers use `mailer()`.
export const _SesMailerForTests = SesMailer;
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @rovenue/api test mailer.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/mailer.ts apps/api/src/lib/mailer.test.ts apps/api/package.json apps/api/pnpm-lock.yaml
git commit -m "feat(api): SES mailer transport with NoopMailer fallback"
```

### Task 4.3: Invitation email template

**Files:**
- Create: `apps/api/src/lib/email-templates/base.ts`
- Create: `apps/api/src/lib/email-templates/invitation.ts`
- Create: `apps/api/src/lib/email-templates/index.ts`
- Test: `apps/api/src/lib/email-templates/invitation.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/lib/email-templates/invitation.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { renderInvitationEmail } from "./invitation";

describe("renderInvitationEmail", () => {
  it("includes all key params in subject/html/text", () => {
    const out = renderInvitationEmail({
      inviterName: "Furkan",
      projectName: "Rovenue",
      role: "DEVELOPER",
      inviteUrl: "https://dash.example.com/invitations/tok_123",
      expiresAt: new Date("2026-06-02T00:00:00Z"),
    });
    expect(out.subject).toContain("Rovenue");
    expect(out.subject).toContain("invited");
    expect(out.html).toContain("Furkan");
    expect(out.html).toContain("DEVELOPER");
    expect(out.html).toContain(
      'href="https://dash.example.com/invitations/tok_123"',
    );
    expect(out.text).toContain("https://dash.example.com/invitations/tok_123");
    expect(out.text).toContain("DEVELOPER");
    expect(out.text).toContain("Rovenue");
  });

  it("escapes HTML in inviter / project name to prevent injection", () => {
    const out = renderInvitationEmail({
      inviterName: '<script>alert(1)</script>',
      projectName: '"><img>',
      role: "ADMIN",
      inviteUrl: "https://example.com/x",
      expiresAt: new Date(),
    });
    expect(out.html).not.toContain("<script>");
    expect(out.html).toContain("&lt;script&gt;");
    expect(out.html).not.toContain('"><img>');
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
pnpm --filter @rovenue/api test invitation.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement templates**

Create `apps/api/src/lib/email-templates/base.ts`:

```ts
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function shell(innerHtml: string): string {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Rovenue</title></head>
<body style="font-family:system-ui,sans-serif;max-width:560px;margin:32px auto;color:#0a0a0a;">
${innerHtml}
<hr style="border:none;border-top:1px solid #e5e5e5;margin:32px 0;">
<p style="font-size:12px;color:#737373;">Rovenue · Self-hosted subscription management.</p>
</body></html>`;
}
```

Create `apps/api/src/lib/email-templates/invitation.ts`:

```ts
import type { MemberRoleName } from "@rovenue/shared";
import { escapeHtml, shell } from "./base";

export interface InvitationEmailParams {
  inviterName: string;
  projectName: string;
  role: MemberRoleName;
  inviteUrl: string;
  expiresAt: Date;
}

export function renderInvitationEmail(p: InvitationEmailParams): {
  subject: string;
  html: string;
  text: string;
} {
  const inviter = escapeHtml(p.inviterName);
  const project = escapeHtml(p.projectName);
  const role = escapeHtml(p.role);
  const url = p.inviteUrl;
  const expires = p.expiresAt.toUTCString();

  const subject = `You've been invited to ${p.projectName} on Rovenue`;

  const html = shell(`
<h1 style="font-size:20px;margin:0 0 16px;">You're invited to join ${project}</h1>
<p style="font-size:14px;line-height:1.6;">
  <strong>${inviter}</strong> invited you to join <strong>${project}</strong>
  as a <strong>${role}</strong>.
</p>
<p style="margin:24px 0;">
  <a href="${url}" style="background:#0a0a0a;color:#fff;padding:10px 18px;border-radius:6px;text-decoration:none;font-size:14px;">
    Accept invitation
  </a>
</p>
<p style="font-size:12px;color:#737373;">
  This link expires on ${expires}. If you didn't expect this email you can ignore it.
</p>`);

  const text = [
    `You're invited to join ${p.projectName}`,
    "",
    `${p.inviterName} invited you to join ${p.projectName} as a ${p.role}.`,
    "",
    `Accept the invitation: ${url}`,
    "",
    `This link expires on ${expires}.`,
  ].join("\n");

  return { subject, html, text };
}
```

Create `apps/api/src/lib/email-templates/index.ts`:

```ts
export { renderInvitationEmail } from "./invitation";
export type { InvitationEmailParams } from "./invitation";
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @rovenue/api test invitation.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/email-templates
git commit -m "feat(api): invitation email template"
```

### Task 4.4: BullMQ email queue + worker

**Files:**
- Create: `apps/api/src/workers/email.ts`
- Modify: `apps/api/src/index.ts` (register worker on boot)
- Test: `apps/api/src/workers/email.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/workers/email.test.ts`:

```ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { __setMailerForTests, type Mailer } from "../lib/mailer";
import { runInvitationEmailJob } from "./email";
import { drizzle } from "@rovenue/db";

class RecordingMailer implements Mailer {
  sent: Array<{ to: string; subject: string }> = [];
  async send(m: any) {
    this.sent.push({ to: m.to, subject: m.subject });
    return { messageId: `mock-${this.sent.length}` };
  }
}

describe("runInvitationEmailJob", () => {
  beforeEach(() => __setMailerForTests(null));

  it("no-ops when invitation is no longer pending", async () => {
    const rec = new RecordingMailer();
    __setMailerForTests(rec);
    vi.spyOn(drizzle.invitationRepo, "findInvitationForEmailSend")
      .mockResolvedValueOnce(null);

    const out = await runInvitationEmailJob({ invitationId: "inv_404" });
    expect(out).toEqual({ skipped: "not_pending" });
    expect(rec.sent).toHaveLength(0);
  });

  it("sends and patches sesMessageId + lastSentAt on success", async () => {
    const rec = new RecordingMailer();
    __setMailerForTests(rec);
    vi.spyOn(drizzle.invitationRepo, "findInvitationForEmailSend")
      .mockResolvedValueOnce({
        invitation: {
          id: "inv_1", email: "a@b.com", role: "DEVELOPER",
          expiresAt: new Date(Date.now() + 86_400_000),
        },
        inviterName: "Furkan",
        projectName: "Rovenue",
      } as any);
    const patch = vi.spyOn(drizzle.invitationRepo, "patchSendResult")
      .mockResolvedValueOnce(undefined as any);

    const out = await runInvitationEmailJob({ invitationId: "inv_1" });
    expect(out).toEqual({ sent: true, messageId: "mock-1" });
    expect(rec.sent[0].to).toBe("a@b.com");
    expect(patch).toHaveBeenCalledWith(expect.anything(), "inv_1", {
      sesMessageId: "mock-1",
      lastSentAt: expect.any(Date),
    });
  });
});
```

- [ ] **Step 2: Run test to verify failure**

```bash
pnpm --filter @rovenue/api test workers/email
```

Expected: FAIL — `runInvitationEmailJob` and repo methods do not exist yet. (We add the repo methods in Phase 5; for this task we stub them so the test compiles.)

- [ ] **Step 3: Stub repo methods**

Edit `packages/db/src/drizzle/repositories/invitations.ts` (create the file):

```ts
import type { Db } from "../client";

export interface InvitationEmailLoad {
  invitation: {
    id: string;
    email: string;
    role: string;
    expiresAt: Date;
  };
  inviterName: string;
  projectName: string;
}

export async function findInvitationForEmailSend(
  _db: Db,
  _id: string,
): Promise<InvitationEmailLoad | null> {
  throw new Error("not implemented yet — see Phase 5");
}

export async function patchSendResult(
  _db: Db,
  _id: string,
  _patch: { sesMessageId: string; lastSentAt: Date },
): Promise<void> {
  throw new Error("not implemented yet — see Phase 5");
}
```

Also wire it into `packages/db/src/index.ts` (the `drizzle` namespace):

```ts
import * as invitationRepo from "./drizzle/repositories/invitations";
// ...
export const drizzle = {
  // existing keys...
  invitationRepo,
};
```

(Locate the existing `drizzle` export and add `invitationRepo` to it.)

- [ ] **Step 4: Implement the worker**

Create `apps/api/src/workers/email.ts`:

```ts
import { Queue, Worker, type Job } from "bullmq";
import { Redis } from "ioredis";
import { drizzle } from "@rovenue/db";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import { mailer } from "../lib/mailer";
import { renderInvitationEmail } from "../lib/email-templates";
import type { MemberRoleName } from "@rovenue/shared";

const log = logger.child("email-worker");

export const EMAIL_QUEUE_NAME = "rovenue-email";

interface InvitationEmailJobData {
  type: "invitation.send";
  invitationId: string;
}

function createBullConnection(): Redis {
  return new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: null,
    lazyConnect: false,
  });
}

let cachedQueue: Queue | undefined;
export function getEmailQueue(): Queue {
  if (cachedQueue) return cachedQueue;
  cachedQueue = new Queue(EMAIL_QUEUE_NAME, {
    connection: createBullConnection(),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: "exponential", delay: 30_000 },
      removeOnComplete: { count: 100, age: 24 * 60 * 60 },
      removeOnFail: { count: 500, age: 7 * 24 * 60 * 60 },
    },
  });
  return cachedQueue;
}

export async function enqueueInvitationEmail(
  invitationId: string,
): Promise<void> {
  const queue = getEmailQueue();
  await queue.add(
    "invitation.send",
    { type: "invitation.send", invitationId } satisfies InvitationEmailJobData,
    { jobId: `inv-${invitationId}-${Date.now()}` },
  );
}

export async function runInvitationEmailJob(args: {
  invitationId: string;
}): Promise<{ sent: true; messageId: string } | { skipped: string }> {
  const load = await drizzle.invitationRepo.findInvitationForEmailSend(
    drizzle.db, args.invitationId,
  );
  if (!load) return { skipped: "not_pending" };

  const inviteUrl = `${env.DASHBOARD_URL}/invitations/${args.invitationId}`;
  // ^ NOTE: the worker doesn't have the plaintext token. The API layer
  // creates the inviteUrl with the plaintext token and stores it in the
  // email job payload via the queue. We update this in Task 6.4 to
  // pass the inviteUrl directly via job data.

  const { subject, html, text } = renderInvitationEmail({
    inviterName: load.inviterName,
    projectName: load.projectName,
    role: load.invitation.role as MemberRoleName,
    inviteUrl,
    expiresAt: load.invitation.expiresAt,
  });

  const result = await mailer().send({
    to: load.invitation.email,
    subject,
    html,
    text,
    correlationId: args.invitationId,
  });

  await drizzle.invitationRepo.patchSendResult(
    drizzle.db, args.invitationId,
    { sesMessageId: result.messageId, lastSentAt: new Date() },
  );

  return { sent: true, messageId: result.messageId };
}

let cachedWorker: Worker | undefined;
export function createEmailWorker(): Worker {
  if (cachedWorker) return cachedWorker;
  cachedWorker = new Worker<InvitationEmailJobData>(
    EMAIL_QUEUE_NAME,
    async (job: Job<InvitationEmailJobData>) => {
      if (job.data.type !== "invitation.send") return;
      return runInvitationEmailJob({ invitationId: job.data.invitationId });
    },
    {
      connection: createBullConnection(),
      concurrency: 5,
    },
  );

  cachedWorker.on("failed", (job, err) => {
    log.error("email job failed", {
      jobId: job?.id, attemptsMade: job?.attemptsMade, err: err.message,
    });
  });

  return cachedWorker;
}
```

- [ ] **Step 5: Wire worker into boot**

Edit `apps/api/src/index.ts`. Add to imports:

```ts
import { createEmailWorker } from "./workers/email";
```

After the other `create…Worker()` calls (near line 65), add:

```ts
// Outgoing transactional email (invites today; reusable for more flows later).
createEmailWorker();
```

- [ ] **Step 6: Run tests**

```bash
pnpm --filter @rovenue/api test workers/email
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/workers/email.ts apps/api/src/workers/email.test.ts apps/api/src/index.ts packages/db/src/drizzle/repositories/invitations.ts packages/db/src/index.ts
git commit -m "feat(api): BullMQ email queue + worker + invitation repo stub"
```

---

## Phase 5 — Invitations schema + repository

### Task 5.1: `project_invitations` migration + Drizzle table

**Files:**
- Modify: `packages/db/src/drizzle/enums.ts`
- Modify: `packages/db/src/drizzle/schema.ts`
- Create: `packages/db/drizzle/migrations/0039_project_invitations.sql`

- [ ] **Step 1: Add the delivery-status enum**

Edit `packages/db/src/drizzle/enums.ts` and append:

```ts
export const invitationDeliveryStatus = pgEnum("InvitationDeliveryStatus", [
  "PENDING",
  "DELIVERED",
  "BOUNCED",
  "COMPLAINED",
  "SUPPRESSED",
]);
```

- [ ] **Step 2: Add the table to schema**

Edit `packages/db/src/drizzle/schema.ts`. After the `projectMembers` block, insert:

```ts
// =============================================================
// project_invitations
// =============================================================

export const projectInvitations = pgTable(
  "project_invitations",
  {
    id: text("id").primaryKey().$defaultFn(() => createId()),
    projectId: text("projectId")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    role: memberRole("role").notNull(),
    tokenHash: text("tokenHash").notNull(),
    invitedByUserId: text("invitedByUserId")
      .notNull()
      .references(() => user.id, { onDelete: "restrict" }),
    expiresAt: timestamp("expiresAt", { withTimezone: true }).notNull(),
    acceptedAt: timestamp("acceptedAt", { withTimezone: true }),
    revokedAt: timestamp("revokedAt", { withTimezone: true }),
    deliveryStatus: invitationDeliveryStatus("deliveryStatus")
      .notNull()
      .default("PENDING"),
    deliveryError: text("deliveryError"),
    lastSentAt: timestamp("lastSentAt", { withTimezone: true }),
    sesMessageId: text("sesMessageId"),
    createdAt: timestamp("createdAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updatedAt", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    pendingUniq: uniqueIndex("project_invitations_pending_uniq")
      .on(t.projectId, t.email)
      .where(sql`accepted_at IS NULL AND revoked_at IS NULL`),
    tokenHashUniq: uniqueIndex("project_invitations_token_hash_key").on(
      t.tokenHash,
    ),
    expiresAtIdx: index("project_invitations_expiresAt_idx").on(t.expiresAt),
    sesMessageIdIdx: index("project_invitations_sesMessageId_idx").on(
      t.sesMessageId,
    ),
    projectIdEmailIdx: index("project_invitations_projectId_email_idx").on(
      t.projectId,
      t.email,
    ),
  }),
);

export type ProjectInvitation = typeof projectInvitations.$inferSelect;
export type NewProjectInvitation = typeof projectInvitations.$inferInsert;
```

Also re-export `invitationDeliveryStatus` and `projectInvitations` from the existing barrel re-export block near the bottom of `schema.ts` (alongside `memberRole`).

- [ ] **Step 3: Generate migration**

```bash
cd packages/db && pnpm db:migrate:generate
```

Open the generated file (likely `0039_*.sql`) and confirm it creates `project_invitations` + the indexes. Drizzle may produce the partial unique index without the `WHERE` clause — if so, replace that statement with the explicit version:

```sql
CREATE UNIQUE INDEX "project_invitations_pending_uniq"
  ON "project_invitations" ("projectId", "email")
  WHERE accepted_at IS NULL AND revoked_at IS NULL;
```

Rename the file to `0039_project_invitations.sql` for clarity if drizzle gave it a different suffix.

- [ ] **Step 4: Run migration + verify**

```bash
pnpm db:migrate
psql "$DATABASE_URL" -c "\d project_invitations"
```

Expected: table exists with the columns + indexes listed.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/drizzle packages/db/drizzle/migrations
git commit -m "feat(db): project_invitations table"
```

### Task 5.2: Token helper

**Files:**
- Create: `apps/api/src/lib/invitation-token.ts`
- Test: `apps/api/src/lib/invitation-token.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/lib/invitation-token.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { generateInvitationToken, hashInvitationToken } from "./invitation-token";

describe("invitation-token", () => {
  it("emits a token with the rov_inv_ prefix and url-safe body", () => {
    const t = generateInvitationToken();
    expect(t.plaintext).toMatch(/^rov_inv_[A-Za-z0-9_-]{40,}$/);
    expect(t.hash).toHaveLength(64); // sha256 hex
  });

  it("hash matches between generation and re-hash", () => {
    const t = generateInvitationToken();
    expect(hashInvitationToken(t.plaintext)).toBe(t.hash);
  });

  it("hashes are deterministic across calls", () => {
    expect(hashInvitationToken("abc")).toBe(hashInvitationToken("abc"));
  });
});
```

- [ ] **Step 2: Run test, see failure**

```bash
pnpm --filter @rovenue/api test invitation-token.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `apps/api/src/lib/invitation-token.ts`:

```ts
import { createHash, randomBytes } from "node:crypto";

const PREFIX = "rov_inv_";

export interface GeneratedInvitationToken {
  plaintext: string;
  hash: string;
}

export function generateInvitationToken(): GeneratedInvitationToken {
  const body = randomBytes(32).toString("base64url"); // 43 chars
  const plaintext = `${PREFIX}${body}`;
  return { plaintext, hash: hashInvitationToken(plaintext) };
}

export function hashInvitationToken(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @rovenue/api test invitation-token.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/invitation-token.ts apps/api/src/lib/invitation-token.test.ts
git commit -m "feat(api): invitation token generator + hasher"
```

### Task 5.3: Invitation repository

**Files:**
- Modify: `packages/db/src/drizzle/repositories/invitations.ts`
- Test: `packages/db/src/drizzle/repositories/invitations.integration.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/db/src/drizzle/repositories/invitations.integration.test.ts`:

```ts
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "../../index";
import {
  createInvitation,
  findInvitationByTokenHash,
  findInvitationByEmail,
  listInvitations,
  patchSendResult,
  revokeInvitation,
  markAccepted,
  setDeliveryStatus,
  findInvitationForEmailSend,
} from "./invitations";
import { createTestProject, createTestUser } from "../../test/factories"; // hypothetical

describe("invitations repo", () => {
  let projectId: string;
  let inviterUserId: string;
  beforeAll(async () => {
    const p = await createTestProject();
    projectId = p.projectId;
    inviterUserId = p.ownerUserId;
  });

  afterEach(async () => {
    await drizzle.db.execute(`DELETE FROM project_invitations`);
  });

  it("creates an invitation and looks it up by tokenHash", async () => {
    const row = await createInvitation(drizzle.db, {
      projectId,
      email: "alex@example.com",
      role: "DEVELOPER",
      tokenHash: "h1",
      invitedByUserId: inviterUserId,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    expect(row.id).toBeDefined();
    const found = await findInvitationByTokenHash(drizzle.db, "h1");
    expect(found?.id).toBe(row.id);
  });

  it("pending uniqueness blocks a 2nd pending invite for same email", async () => {
    await createInvitation(drizzle.db, {
      projectId, email: "dup@example.com", role: "DEVELOPER",
      tokenHash: "h2", invitedByUserId: inviterUserId,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await expect(
      createInvitation(drizzle.db, {
        projectId, email: "dup@example.com", role: "GROWTH",
        tokenHash: "h3", invitedByUserId: inviterUserId,
        expiresAt: new Date(Date.now() + 86_400_000),
      }),
    ).rejects.toThrow();
  });

  it("can re-invite after revoke", async () => {
    const first = await createInvitation(drizzle.db, {
      projectId, email: "redo@example.com", role: "ADMIN",
      tokenHash: "h4", invitedByUserId: inviterUserId,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await revokeInvitation(drizzle.db, first.id);
    const second = await createInvitation(drizzle.db, {
      projectId, email: "redo@example.com", role: "ADMIN",
      tokenHash: "h5", invitedByUserId: inviterUserId,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    expect(second.id).not.toBe(first.id);
  });

  it("patchSendResult updates sesMessageId + lastSentAt", async () => {
    const row = await createInvitation(drizzle.db, {
      projectId, email: "send@example.com", role: "DEVELOPER",
      tokenHash: "h6", invitedByUserId: inviterUserId,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await patchSendResult(drizzle.db, row.id, {
      sesMessageId: "ses-xyz",
      lastSentAt: new Date("2026-05-26T00:00:00Z"),
    });
    const after = await findInvitationByTokenHash(drizzle.db, "h6");
    expect(after?.sesMessageId).toBe("ses-xyz");
  });

  it("setDeliveryStatus flips status and clears/sets deliveryError", async () => {
    const row = await createInvitation(drizzle.db, {
      projectId, email: "b@example.com", role: "DEVELOPER",
      tokenHash: "h7", invitedByUserId: inviterUserId,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await setDeliveryStatus(drizzle.db, "h7-msg-id", "BOUNCED", "permanent: unknown user");
    // setDeliveryStatus looks up by sesMessageId; ensure we set it first
    await patchSendResult(drizzle.db, row.id, {
      sesMessageId: "h7-msg-id", lastSentAt: new Date(),
    });
    await setDeliveryStatus(drizzle.db, "h7-msg-id", "BOUNCED", "permanent: unknown user");
    const after = await findInvitationByTokenHash(drizzle.db, "h7");
    expect(after?.deliveryStatus).toBe("BOUNCED");
    expect(after?.deliveryError).toBe("permanent: unknown user");
  });

  it("listInvitations returns pending + recent terminal (30d) for a project", async () => {
    await createInvitation(drizzle.db, {
      projectId, email: "p1@example.com", role: "DEVELOPER",
      tokenHash: "ha", invitedByUserId: inviterUserId,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const list = await listInvitations(drizzle.db, projectId);
    expect(list.map((i) => i.email)).toContain("p1@example.com");
  });

  it("findInvitationForEmailSend returns null for already-accepted invitations", async () => {
    const row = await createInvitation(drizzle.db, {
      projectId, email: "x@example.com", role: "DEVELOPER",
      tokenHash: "hi", invitedByUserId: inviterUserId,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await markAccepted(drizzle.db, row.id);
    expect(
      await findInvitationForEmailSend(drizzle.db, row.id),
    ).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests, confirm failure**

```bash
pnpm --filter @rovenue/db test invitations.integration.test.ts
```

Expected: FAIL — functions not implemented.

- [ ] **Step 3: Replace the stub with the real repo**

Replace `packages/db/src/drizzle/repositories/invitations.ts` with:

```ts
import { and, desc, eq, isNull, or, sql, gte } from "drizzle-orm";
import type { Db, DbOrTx } from "./projects";
import {
  invitationDeliveryStatus,
  projectInvitations,
  projects,
  user,
  type ProjectInvitation,
} from "../schema";

export type DeliveryStatus =
  (typeof invitationDeliveryStatus.enumValues)[number];

export interface CreateInvitationInput {
  projectId: string;
  email: string;
  role: "ADMIN" | "DEVELOPER" | "GROWTH" | "CUSTOMER_SUPPORT";
  tokenHash: string;
  invitedByUserId: string;
  expiresAt: Date;
  /** Pre-set when we want to short-circuit sending (cross-project suppression). */
  deliveryStatus?: DeliveryStatus;
  deliveryError?: string;
}

export async function createInvitation(
  db: DbOrTx,
  input: CreateInvitationInput,
): Promise<ProjectInvitation> {
  const rows = await db
    .insert(projectInvitations)
    .values({
      projectId: input.projectId,
      email: input.email.toLowerCase(),
      role: input.role,
      tokenHash: input.tokenHash,
      invitedByUserId: input.invitedByUserId,
      expiresAt: input.expiresAt,
      deliveryStatus: input.deliveryStatus ?? "PENDING",
      deliveryError: input.deliveryError ?? null,
    })
    .returning();
  const row = rows[0];
  if (!row) throw new Error("Failed to insert invitation");
  return row;
}

export async function revokeInvitation(
  db: DbOrTx, id: string,
): Promise<void> {
  await db
    .update(projectInvitations)
    .set({ revokedAt: new Date(), updatedAt: new Date() })
    .where(eq(projectInvitations.id, id));
}

export async function markAccepted(
  db: DbOrTx, id: string,
): Promise<void> {
  await db
    .update(projectInvitations)
    .set({ acceptedAt: new Date(), updatedAt: new Date() })
    .where(eq(projectInvitations.id, id));
}

export async function findInvitationByTokenHash(
  db: Db, tokenHash: string,
): Promise<ProjectInvitation | null> {
  const rows = await db
    .select()
    .from(projectInvitations)
    .where(eq(projectInvitations.tokenHash, tokenHash))
    .limit(1);
  return rows[0] ?? null;
}

export async function findPendingInvitationByEmail(
  db: Db, projectId: string, email: string,
): Promise<ProjectInvitation | null> {
  const rows = await db
    .select()
    .from(projectInvitations)
    .where(
      and(
        eq(projectInvitations.projectId, projectId),
        eq(projectInvitations.email, email.toLowerCase()),
        isNull(projectInvitations.acceptedAt),
        isNull(projectInvitations.revokedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function findInvitationByEmail(
  db: Db, projectId: string, email: string,
): Promise<ProjectInvitation | null> {
  return findPendingInvitationByEmail(db, projectId, email);
}

export interface InvitationListRow {
  id: string;
  email: string;
  role: ProjectInvitation["role"];
  status: "pending" | "accepted" | "revoked" | "expired";
  deliveryStatus: DeliveryStatus;
  deliveryError: string | null;
  invitedByName: string | null;
  expiresAt: Date;
  lastSentAt: Date | null;
  createdAt: Date;
}

export async function listInvitations(
  db: Db, projectId: string,
): Promise<InvitationListRow[]> {
  const thirtyDaysAgo = new Date(Date.now() - 30 * 86_400_000);
  const rows = await db
    .select({
      id: projectInvitations.id,
      email: projectInvitations.email,
      role: projectInvitations.role,
      acceptedAt: projectInvitations.acceptedAt,
      revokedAt: projectInvitations.revokedAt,
      expiresAt: projectInvitations.expiresAt,
      deliveryStatus: projectInvitations.deliveryStatus,
      deliveryError: projectInvitations.deliveryError,
      lastSentAt: projectInvitations.lastSentAt,
      createdAt: projectInvitations.createdAt,
      invitedByName: user.name,
    })
    .from(projectInvitations)
    .innerJoin(user, eq(user.id, projectInvitations.invitedByUserId))
    .where(
      and(
        eq(projectInvitations.projectId, projectId),
        or(
          and(
            isNull(projectInvitations.acceptedAt),
            isNull(projectInvitations.revokedAt),
          ),
          gte(projectInvitations.createdAt, thirtyDaysAgo),
        ),
      ),
    )
    .orderBy(desc(projectInvitations.createdAt));

  const now = new Date();
  return rows.map((r) => {
    let status: InvitationListRow["status"];
    if (r.acceptedAt) status = "accepted";
    else if (r.revokedAt) status = "revoked";
    else if (r.expiresAt <= now) status = "expired";
    else status = "pending";
    return {
      id: r.id,
      email: r.email,
      role: r.role,
      status,
      deliveryStatus: r.deliveryStatus,
      deliveryError: r.deliveryError,
      invitedByName: r.invitedByName,
      expiresAt: r.expiresAt,
      lastSentAt: r.lastSentAt,
      createdAt: r.createdAt,
    };
  });
}

export async function patchSendResult(
  db: DbOrTx, id: string,
  patch: { sesMessageId: string; lastSentAt: Date },
): Promise<void> {
  await db
    .update(projectInvitations)
    .set({
      sesMessageId: patch.sesMessageId,
      lastSentAt: patch.lastSentAt,
      updatedAt: new Date(),
    })
    .where(eq(projectInvitations.id, id));
}

export async function setDeliveryStatus(
  db: DbOrTx,
  sesMessageId: string,
  status: DeliveryStatus,
  error: string | null,
): Promise<void> {
  await db
    .update(projectInvitations)
    .set({
      deliveryStatus: status,
      deliveryError: error,
      updatedAt: new Date(),
    })
    .where(eq(projectInvitations.sesMessageId, sesMessageId));
}

export interface InvitationEmailLoad {
  invitation: {
    id: string;
    email: string;
    role: ProjectInvitation["role"];
    expiresAt: Date;
  };
  inviterName: string;
  projectName: string;
}

export async function findInvitationForEmailSend(
  db: Db, id: string,
): Promise<InvitationEmailLoad | null> {
  const rows = await db
    .select({
      id: projectInvitations.id,
      email: projectInvitations.email,
      role: projectInvitations.role,
      expiresAt: projectInvitations.expiresAt,
      acceptedAt: projectInvitations.acceptedAt,
      revokedAt: projectInvitations.revokedAt,
      deliveryStatus: projectInvitations.deliveryStatus,
      inviterName: user.name,
      projectName: projects.name,
    })
    .from(projectInvitations)
    .innerJoin(user, eq(user.id, projectInvitations.invitedByUserId))
    .innerJoin(projects, eq(projects.id, projectInvitations.projectId))
    .where(eq(projectInvitations.id, id))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  if (r.acceptedAt || r.revokedAt) return null;
  if (r.deliveryStatus === "SUPPRESSED") return null;
  if (r.expiresAt <= new Date()) return null;
  return {
    invitation: {
      id: r.id, email: r.email, role: r.role, expiresAt: r.expiresAt,
    },
    inviterName: r.inviterName,
    projectName: r.projectName,
  };
}

/** Look up the most recent terminal delivery for a given email across all projects. */
export async function findCrossProjectSuppression(
  db: Db, email: string,
): Promise<{ status: DeliveryStatus; error: string | null } | null> {
  const rows = await db
    .select({
      deliveryStatus: projectInvitations.deliveryStatus,
      deliveryError: projectInvitations.deliveryError,
    })
    .from(projectInvitations)
    .where(
      and(
        eq(projectInvitations.email, email.toLowerCase()),
        sql`${projectInvitations.deliveryStatus} IN ('BOUNCED','COMPLAINED','SUPPRESSED')`,
      ),
    )
    .orderBy(desc(projectInvitations.updatedAt))
    .limit(1);
  const r = rows[0];
  if (!r) return null;
  return { status: r.deliveryStatus, error: r.deliveryError };
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @rovenue/db test invitations
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/db
git commit -m "feat(db): invitation repository with cross-project suppression"
```

---

## Phase 6 — Invitation API + email send

### Task 6.1: Wire types in shared

**Files:**
- Modify: `packages/shared/src/dashboard.ts`

- [ ] **Step 1: Replace the existing `ProjectMemberRow` / `AddMemberRequest` block**

Edit `packages/shared/src/dashboard.ts` around lines 142-172. Remove `AddMemberRequest`, `AddMemberResponse`, `UpdateMemberRoleRequest` and add the new types:

```ts
// =============================================================
// Project members
// =============================================================

export interface ProjectMemberRow {
  id: string;
  userId: string;
  email: string;
  name: string | null;
  image: string | null;
  role: MemberRoleName;
  createdAt: string;
}

export interface ListMembersResponse {
  members: ProjectMemberRow[];
}

export interface UpdateMemberRoleRequest {
  role: AssignableRole;
}

export interface TransferOwnershipRequest {
  toUserId: string;
}

// =============================================================
// Project invitations
// =============================================================

export type InvitationStatus = "pending" | "accepted" | "revoked" | "expired";
export type InvitationDeliveryStatusName =
  | "PENDING"
  | "DELIVERED"
  | "BOUNCED"
  | "COMPLAINED"
  | "SUPPRESSED";

export interface InvitationRow {
  id: string;
  email: string;
  role: MemberRoleName;
  status: InvitationStatus;
  deliveryStatus: InvitationDeliveryStatusName;
  deliveryError: string | null;
  invitedByName: string | null;
  expiresAt: string;
  lastSentAt: string | null;
  createdAt: string;
}

export interface ListInvitationsResponse {
  invitations: InvitationRow[];
}

export interface CreateInvitationRequest {
  email: string;
  role: AssignableRole;
}

export interface CreateInvitationResponse {
  invitation: InvitationRow;
  /** Returned exactly once on create. Subsequent GETs do not include this. */
  inviteUrl: string;
}

export interface InvitationPreviewResponse {
  projectId: string;
  projectName: string;
  inviterName: string | null;
  role: MemberRoleName;
  email: string;
  status: InvitationStatus;
  expiresAt: string;
}

export interface AcceptInvitationResponse {
  projectId: string;
  role: MemberRoleName;
}
```

- [ ] **Step 2: Rebuild shared**

```bash
pnpm --filter @rovenue/shared build
```

- [ ] **Step 3: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): invitation wire types + drop AddMemberRequest"
```

### Task 6.2: Invitations API — POST/GET/DELETE/resend

**Files:**
- Create: `apps/api/src/routes/dashboard/invitations.ts`
- Modify: `apps/api/src/routes/dashboard/index.ts` (mount route)
- Test: `apps/api/src/routes/dashboard/invitations.integration.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/routes/dashboard/invitations.integration.test.ts`:

```ts
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { app } from "../../app";
import { drizzle } from "@rovenue/db";
import { __setMailerForTests, type Mailer } from "../../lib/mailer";
import { createTestProject, createTestUser, sessionFor } from "../../test/factories";

class RecordingMailer implements Mailer {
  sent: any[] = [];
  async send(m: any) {
    this.sent.push(m);
    return { messageId: `mock-${this.sent.length}` };
  }
}

describe("invitations API", () => {
  let projectId: string;
  let ownerSession: string;

  beforeAll(async () => {
    const p = await createTestProject();
    projectId = p.projectId;
    ownerSession = p.ownerSession;
  });

  afterEach(async () => {
    await drizzle.db.execute(`DELETE FROM project_invitations`);
    __setMailerForTests(null);
  });

  it("POST returns inviteUrl exactly once and a single invitation row", async () => {
    const rec = new RecordingMailer();
    __setMailerForTests(rec);

    const res = await app.request(
      `/dashboard/projects/${projectId}/invitations`,
      {
        method: "POST",
        headers: { cookie: ownerSession, "content-type": "application/json" },
        body: JSON.stringify({ email: "ALEX@Example.com", role: "DEVELOPER" }),
      },
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.data.inviteUrl).toContain("/invitations/rov_inv_");
    expect(body.data.invitation.email).toBe("alex@example.com");

    const list = await app.request(
      `/dashboard/projects/${projectId}/invitations`,
      { headers: { cookie: ownerSession } },
    );
    const listBody = await list.json();
    expect(listBody.data.invitations).toHaveLength(1);
    // inviteUrl is not exposed in list:
    expect(listBody.data.invitations[0]).not.toHaveProperty("inviteUrl");
  });

  it("POST blocks role = OWNER", async () => {
    const res = await app.request(
      `/dashboard/projects/${projectId}/invitations`,
      {
        method: "POST",
        headers: { cookie: ownerSession, "content-type": "application/json" },
        body: JSON.stringify({ email: "x@example.com", role: "OWNER" }),
      },
    );
    expect(res.status).toBe(400);
  });

  it("POST 409 when email is already a project member", async () => {
    const member = await createTestUser({ email: "exists@example.com" });
    await drizzle.projectRepo.createProjectMember(drizzle.db, {
      projectId, userId: member.id, role: "DEVELOPER",
    });
    const res = await app.request(
      `/dashboard/projects/${projectId}/invitations`,
      {
        method: "POST",
        headers: { cookie: ownerSession, "content-type": "application/json" },
        body: JSON.stringify({ email: "exists@example.com", role: "ADMIN" }),
      },
    );
    expect(res.status).toBe(409);
  });

  it("POST replaces an existing pending invite and sets X-Rovenue-Refreshed", async () => {
    const rec = new RecordingMailer();
    __setMailerForTests(rec);

    await app.request(
      `/dashboard/projects/${projectId}/invitations`,
      {
        method: "POST",
        headers: { cookie: ownerSession, "content-type": "application/json" },
        body: JSON.stringify({ email: "dup@example.com", role: "DEVELOPER" }),
      },
    );
    const res = await app.request(
      `/dashboard/projects/${projectId}/invitations`,
      {
        method: "POST",
        headers: { cookie: ownerSession, "content-type": "application/json" },
        body: JSON.stringify({ email: "dup@example.com", role: "GROWTH" }),
      },
    );
    expect(res.status).toBe(201);
    expect(res.headers.get("x-rovenue-refreshed")).toBe("true");
  });

  it("DELETE revokes the invitation", async () => {
    const created = await app.request(
      `/dashboard/projects/${projectId}/invitations`,
      {
        method: "POST",
        headers: { cookie: ownerSession, "content-type": "application/json" },
        body: JSON.stringify({ email: "r@example.com", role: "DEVELOPER" }),
      },
    );
    const body = await created.json();
    const id = body.data.invitation.id;

    const res = await app.request(
      `/dashboard/projects/${projectId}/invitations/${id}`,
      { method: "DELETE", headers: { cookie: ownerSession } },
    );
    expect(res.status).toBe(200);

    const list = await app.request(
      `/dashboard/projects/${projectId}/invitations`,
      { headers: { cookie: ownerSession } },
    );
    const listBody = await list.json();
    expect(
      listBody.data.invitations.find((i: any) => i.id === id)?.status,
    ).toBe("revoked");
  });
});
```

- [ ] **Step 2: Run tests, confirm failures**

```bash
pnpm --filter @rovenue/api test invitations.integration.test.ts
```

Expected: all FAIL (route doesn't exist).

- [ ] **Step 3: Implement the route**

Create `apps/api/src/routes/dashboard/invitations.ts`:

```ts
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { drizzle } from "@rovenue/db";
import { ASSIGNABLE_ROLES, type CreateInvitationResponse, type ListInvitationsResponse, type InvitationRow } from "@rovenue/shared";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectCapability } from "../../lib/capabilities";
import { audit, extractRequestContext } from "../../lib/audit";
import { ok } from "../../lib/response";
import { env } from "../../lib/env";
import { generateInvitationToken } from "../../lib/invitation-token";
import { enqueueInvitationEmail } from "../../workers/email";
import { getRedis } from "../../lib/redis";

const INVITE_TTL_DAYS = 7;
const RESEND_COOLDOWN_SECONDS = 60;

const createBodySchema = z.object({
  email: z.string().email(),
  role: z.enum(ASSIGNABLE_ROLES),
});

function toRow(r: {
  id: string;
  email: string;
  role: string;
  status: string;
  deliveryStatus: string;
  deliveryError: string | null;
  invitedByName: string | null;
  expiresAt: Date;
  lastSentAt: Date | null;
  createdAt: Date;
}): InvitationRow {
  return {
    id: r.id,
    email: r.email,
    role: r.role as InvitationRow["role"],
    status: r.status as InvitationRow["status"],
    deliveryStatus: r.deliveryStatus as InvitationRow["deliveryStatus"],
    deliveryError: r.deliveryError,
    invitedByName: r.invitedByName,
    expiresAt: r.expiresAt.toISOString(),
    lastSentAt: r.lastSentAt ? r.lastSentAt.toISOString() : null,
    createdAt: r.createdAt.toISOString(),
  };
}

export const invitationsRoute = new Hono()
  .use("*", requireDashboardAuth)

  .get("/", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) throw new HTTPException(400, { message: "Missing projectId" });
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "members:manage");

    const rows = await drizzle.invitationRepo.listInvitations(drizzle.db, projectId);
    const payload: ListInvitationsResponse = { invitations: rows.map(toRow) };
    return c.json(ok(payload));
  })

  .post("/", zValidator("json", createBodySchema), async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) throw new HTTPException(400, { message: "Missing projectId" });
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "members:manage");
    const body = c.req.valid("json");

    const email = body.email.toLowerCase();
    if (email === user.email.toLowerCase()) {
      throw new HTTPException(400, { message: "Cannot invite yourself" });
    }

    // Already a member?
    const existingMember = await drizzle.userRepo.findUserByEmail(drizzle.db, email);
    if (existingMember) {
      const m = await drizzle.projectRepo.findMembership(
        drizzle.db, projectId, existingMember.id,
      );
      if (m) {
        throw new HTTPException(409, {
          message: "ALREADY_MEMBER: that email is already a project member",
        });
      }
    }

    // Pending invitation refresh?
    const prior = await drizzle.invitationRepo.findPendingInvitationByEmail(
      drizzle.db, projectId, email,
    );
    let refreshed = false;

    // Cross-project suppression pre-check.
    const sup = await drizzle.invitationRepo.findCrossProjectSuppression(
      drizzle.db, email,
    );

    const token = generateInvitationToken();
    const expiresAt = new Date(Date.now() + INVITE_TTL_DAYS * 86_400_000);

    const created = await drizzle.db.transaction(async (tx) => {
      if (prior) {
        await drizzle.invitationRepo.revokeInvitation(tx, prior.id);
        refreshed = true;
      }
      const row = await drizzle.invitationRepo.createInvitation(tx, {
        projectId,
        email,
        role: body.role,
        tokenHash: token.hash,
        invitedByUserId: user.id,
        expiresAt,
        deliveryStatus: sup ? "SUPPRESSED" : undefined,
        deliveryError: sup
          ? `cross-project suppression: prior ${sup.status}`
          : undefined,
      });
      await audit(
        {
          projectId,
          userId: user.id,
          action: "invitation.created",
          resource: "invitation",
          resourceId: row.id,
          after: { email, role: body.role, refreshed },
          ...extractRequestContext(c),
        },
        tx,
      );
      return row;
    });

    if (!sup) {
      await enqueueInvitationEmail(created.id);
    }

    const inviteUrl = `${env.DASHBOARD_URL}/invitations/${token.plaintext}`;
    const list = await drizzle.invitationRepo.listInvitations(drizzle.db, projectId);
    const rowForResponse = list.find((i) => i.id === created.id);
    if (!rowForResponse) {
      throw new HTTPException(500, { message: "Just-created invitation vanished" });
    }
    const payload: CreateInvitationResponse = {
      invitation: toRow(rowForResponse),
      inviteUrl,
    };
    if (refreshed) c.header("X-Rovenue-Refreshed", "true");
    return c.json(ok(payload), 201);
  })

  .delete("/:invitationId", async (c) => {
    const projectId = c.req.param("projectId");
    const invitationId = c.req.param("invitationId");
    if (!projectId || !invitationId)
      throw new HTTPException(400, { message: "Missing param" });
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "members:manage");

    const row = await drizzle.invitationRepo.findInvitationByTokenHash(drizzle.db, "")
      .then(() => null); // placeholder — use findById helper below
    // We don't have a findById; check via listInvitations or a direct query.
    // Quick: use the schema directly here:
    const direct = await drizzle.db.execute(
      `SELECT * FROM project_invitations WHERE id = $1 AND "projectId" = $2`,
      [invitationId, projectId],
    );
    if ((direct as any).rows.length === 0) {
      throw new HTTPException(404, { message: "Invitation not found" });
    }

    await drizzle.db.transaction(async (tx) => {
      await drizzle.invitationRepo.revokeInvitation(tx, invitationId);
      await audit(
        {
          projectId,
          userId: user.id,
          action: "invitation.revoked",
          resource: "invitation",
          resourceId: invitationId,
          ...extractRequestContext(c),
        },
        tx,
      );
    });

    return c.json(ok({ revoked: true }));
  })

  .post("/:invitationId/resend", async (c) => {
    const projectId = c.req.param("projectId");
    const invitationId = c.req.param("invitationId");
    if (!projectId || !invitationId)
      throw new HTTPException(400, { message: "Missing param" });
    const user = c.get("user");
    await assertProjectCapability(projectId, user.id, "members:manage");

    const redis = getRedis();
    const key = `invite:resend:${invitationId}`;
    const acquired = await redis.set(key, "1", "EX", RESEND_COOLDOWN_SECONDS, "NX");
    if (acquired !== "OK") {
      throw new HTTPException(429, {
        message: `Wait ${RESEND_COOLDOWN_SECONDS}s before resending`,
      });
    }

    const load = await drizzle.invitationRepo.findInvitationForEmailSend(
      drizzle.db, invitationId,
    );
    if (!load) {
      throw new HTTPException(409, { message: "Invitation is not in a sendable state" });
    }

    await enqueueInvitationEmail(invitationId);
    await audit(
      {
        projectId,
        userId: user.id,
        action: "invitation.resent",
        resource: "invitation",
        resourceId: invitationId,
        ...extractRequestContext(c),
      },
      drizzle.db,
    );

    return c.json(ok({ resent: true }));
  });
```

Note: the DELETE handler uses raw SQL because we don't have a `findInvitationById`. Add this helper to the repo:

In `packages/db/src/drizzle/repositories/invitations.ts`, add:

```ts
export async function findInvitationById(
  db: Db, id: string,
): Promise<ProjectInvitation | null> {
  const rows = await db
    .select()
    .from(projectInvitations)
    .where(eq(projectInvitations.id, id))
    .limit(1);
  return rows[0] ?? null;
}
```

Then replace the raw-SQL block in the DELETE handler with:

```ts
const row = await drizzle.invitationRepo.findInvitationById(drizzle.db, invitationId);
if (!row || row.projectId !== projectId) {
  throw new HTTPException(404, { message: "Invitation not found" });
}
```

- [ ] **Step 4: Mount the route**

Edit `apps/api/src/routes/dashboard/index.ts`. Add to imports:

```ts
import { invitationsRoute } from "./invitations";
```

After the `membersRoute` mount line:

```ts
  .route("/projects/:projectId/invitations", invitationsRoute)
```

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @rovenue/api test invitations.integration.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/dashboard/invitations.ts apps/api/src/routes/dashboard/invitations.integration.test.ts apps/api/src/routes/dashboard/index.ts packages/db/src/drizzle/repositories/invitations.ts
git commit -m "feat(api): invitation create/list/revoke/resend endpoints"
```

### Task 6.3: Carry the plaintext token through the email job

**Files:**
- Modify: `apps/api/src/workers/email.ts`
- Modify: `apps/api/src/routes/dashboard/invitations.ts`

The current worker hard-codes `inviteUrl = ${DASHBOARD_URL}/invitations/${invitationId}`, which is wrong — the token is what authenticates the link, not the row id. Fix by carrying `token` through the job payload, since the plaintext is only known at create time.

- [ ] **Step 1: Update the job data type**

In `apps/api/src/workers/email.ts`:

```ts
interface InvitationEmailJobData {
  type: "invitation.send";
  invitationId: string;
  /** Plaintext token. Only available at create time; resends look up
   *  the hash and reconstruct… no, they can't — see Step 4. */
  inviteUrl: string;
}
```

Change `enqueueInvitationEmail`:

```ts
export async function enqueueInvitationEmail(
  invitationId: string,
  inviteUrl: string,
): Promise<void> {
  const queue = getEmailQueue();
  await queue.add(
    "invitation.send",
    { type: "invitation.send", invitationId, inviteUrl } satisfies InvitationEmailJobData,
    { jobId: `inv-${invitationId}-${Date.now()}` },
  );
}
```

And `runInvitationEmailJob`:

```ts
export async function runInvitationEmailJob(args: {
  invitationId: string;
  inviteUrl: string;
}): Promise<...> {
  // ... use args.inviteUrl instead of building it from the id
}
```

Update the worker's job handler accordingly.

- [ ] **Step 2: Update the API to pass inviteUrl**

In `apps/api/src/routes/dashboard/invitations.ts`, replace `enqueueInvitationEmail(created.id)` with:

```ts
await enqueueInvitationEmail(created.id, inviteUrl);
```

- [ ] **Step 3: Handle resend (token is hashed in DB — we can't regenerate the plaintext)**

Resend uses the SAME plaintext token (per the spec). But once the create response is done, the plaintext is gone. The only way to resend is to store the plaintext somewhere encrypted-at-rest, OR to issue a new token on resend (acceptable per spec note about durability).

Decision: **resend issues a new token**. Update the resend handler:

```ts
.post("/:invitationId/resend", async (c) => {
  // ... (rate limit + capability checks unchanged)
  const existing = await drizzle.invitationRepo.findInvitationById(drizzle.db, invitationId);
  if (!existing || existing.projectId !== projectId) {
    throw new HTTPException(404, { message: "Invitation not found" });
  }
  if (existing.acceptedAt || existing.revokedAt || existing.expiresAt <= new Date()) {
    throw new HTTPException(409, { message: "Invitation is not in a sendable state" });
  }

  const token = generateInvitationToken();
  await drizzle.db.transaction(async (tx) => {
    await tx
      .update(projectInvitations)
      .set({ tokenHash: token.hash, updatedAt: new Date() })
      .where(eq(projectInvitations.id, invitationId));
  });
  const inviteUrl = `${env.DASHBOARD_URL}/invitations/${token.plaintext}`;

  await enqueueInvitationEmail(invitationId, inviteUrl);
  // audit unchanged
  return c.json(ok({ resent: true }));
}),
```

Add an `updateTokenHash` repo method instead of inline SQL — cleaner:

```ts
// In invitations.ts repo:
export async function updateTokenHash(
  db: DbOrTx, id: string, tokenHash: string,
): Promise<void> {
  await db
    .update(projectInvitations)
    .set({ tokenHash, updatedAt: new Date() })
    .where(eq(projectInvitations.id, id));
}
```

Use it in the resend handler.

- [ ] **Step 4: Update the worker test to pass inviteUrl**

In `apps/api/src/workers/email.test.ts`, update calls to `runInvitationEmailJob` to pass `inviteUrl: "https://dash.test/invitations/rov_inv_xyz"`.

- [ ] **Step 5: Run all tests**

```bash
pnpm --filter @rovenue/api test
```

Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add apps
git commit -m "feat(api): plumb plaintext invite token through email job; resend issues new token"
```

### Task 6.4: Public preview + accept routes

**Files:**
- Create: `apps/api/src/routes/public/invitations.ts`
- Modify: `apps/api/src/app.ts` (mount route)
- Test: `apps/api/src/routes/public/invitations.integration.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/routes/public/invitations.integration.test.ts`:

```ts
import { afterEach, describe, expect, it } from "vitest";
import { app } from "../../app";
import { drizzle, MemberRole } from "@rovenue/db";
import { createTestProject, createTestUser, sessionFor } from "../../test/factories";
import { generateInvitationToken } from "../../lib/invitation-token";

describe("public invitation routes", () => {
  afterEach(async () => {
    await drizzle.db.execute(`DELETE FROM project_invitations`);
  });

  it("GET /invitations/:token returns project preview when pending", async () => {
    const { projectId, ownerUserId } = await createTestProject({ name: "Acme" });
    const t = generateInvitationToken();
    await drizzle.invitationRepo.createInvitation(drizzle.db, {
      projectId,
      email: "alex@example.com",
      role: "DEVELOPER",
      tokenHash: t.hash,
      invitedByUserId: ownerUserId,
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const res = await app.request(`/invitations/${t.plaintext}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.projectName).toBe("Acme");
    expect(body.data.status).toBe("pending");
    expect(body.data.email).toBe("alex@example.com");
  });

  it("GET returns status='expired' when expired (no 404)", async () => {
    const { projectId, ownerUserId } = await createTestProject();
    const t = generateInvitationToken();
    await drizzle.invitationRepo.createInvitation(drizzle.db, {
      projectId, email: "exp@example.com", role: "DEVELOPER",
      tokenHash: t.hash, invitedByUserId: ownerUserId,
      expiresAt: new Date(Date.now() - 1000),
    });
    const res = await app.request(`/invitations/${t.plaintext}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.status).toBe("expired");
  });

  it("POST accept requires auth", async () => {
    const t = generateInvitationToken();
    const res = await app.request(`/invitations/${t.plaintext}/accept`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("POST accept: matching email creates membership and marks accepted", async () => {
    const { projectId, ownerUserId } = await createTestProject();
    const invitee = await createTestUser({ email: "accept@example.com" });
    const inviteeSession = await sessionFor(invitee.id);
    const t = generateInvitationToken();
    const inv = await drizzle.invitationRepo.createInvitation(drizzle.db, {
      projectId, email: "accept@example.com", role: "GROWTH",
      tokenHash: t.hash, invitedByUserId: ownerUserId,
      expiresAt: new Date(Date.now() + 86_400_000),
    });

    const res = await app.request(`/invitations/${t.plaintext}/accept`, {
      method: "POST", headers: { cookie: inviteeSession },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.projectId).toBe(projectId);
    expect(body.data.role).toBe("GROWTH");

    const m = await drizzle.projectRepo.findMembership(drizzle.db, projectId, invitee.id);
    expect(m?.role).toBe(MemberRole.GROWTH);

    // Token can't be reused:
    const replay = await app.request(`/invitations/${t.plaintext}/accept`, {
      method: "POST", headers: { cookie: inviteeSession },
    });
    expect([409, 410]).toContain(replay.status);
  });

  it("POST accept: email mismatch → 403", async () => {
    const { projectId, ownerUserId } = await createTestProject();
    const wrongUser = await createTestUser({ email: "wrong@example.com" });
    const sess = await sessionFor(wrongUser.id);
    const t = generateInvitationToken();
    await drizzle.invitationRepo.createInvitation(drizzle.db, {
      projectId, email: "right@example.com", role: "ADMIN",
      tokenHash: t.hash, invitedByUserId: ownerUserId,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    const res = await app.request(`/invitations/${t.plaintext}/accept`, {
      method: "POST", headers: { cookie: sess },
    });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run tests, confirm failure**

```bash
pnpm --filter @rovenue/api test public/invitations
```

Expected: FAIL (route doesn't exist).

- [ ] **Step 3: Implement the route**

Create `apps/api/src/routes/public/invitations.ts`:

```ts
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { drizzle } from "@rovenue/db";
import type {
  AcceptInvitationResponse,
  InvitationPreviewResponse,
} from "@rovenue/shared";
import { hashInvitationToken } from "../../lib/invitation-token";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { audit, extractRequestContext } from "../../lib/audit";
import { ok } from "../../lib/response";

export const publicInvitationsRoute = new Hono()

  .get("/:token", async (c) => {
    const token = c.req.param("token");
    if (!token || !token.startsWith("rov_inv_")) {
      throw new HTTPException(404, { message: "Invalid invitation token" });
    }
    const hash = hashInvitationToken(token);
    const inv = await drizzle.invitationRepo.findInvitationByTokenHash(drizzle.db, hash);
    if (!inv) {
      throw new HTTPException(404, { message: "Invitation not found" });
    }
    const project = await drizzle.projectRepo.findProjectById(drizzle.db, inv.projectId);
    const inviter = await drizzle.userRepo.findUserById(drizzle.db, inv.invitedByUserId);

    const now = new Date();
    let status: InvitationPreviewResponse["status"];
    if (inv.acceptedAt) status = "accepted";
    else if (inv.revokedAt) status = "revoked";
    else if (inv.expiresAt <= now) status = "expired";
    else status = "pending";

    const payload: InvitationPreviewResponse = {
      projectId: inv.projectId,
      projectName: project?.name ?? "(unknown project)",
      inviterName: inviter?.name ?? null,
      role: inv.role,
      email: inv.email,
      status,
      expiresAt: inv.expiresAt.toISOString(),
    };
    return c.json(ok(payload));
  })

  .post("/:token/accept", requireDashboardAuth, async (c) => {
    const token = c.req.param("token");
    if (!token || !token.startsWith("rov_inv_")) {
      throw new HTTPException(404, { message: "Invalid invitation token" });
    }
    const user = c.get("user");
    const hash = hashInvitationToken(token);
    const inv = await drizzle.invitationRepo.findInvitationByTokenHash(drizzle.db, hash);
    if (!inv) throw new HTTPException(404, { message: "Invitation not found" });
    if (inv.acceptedAt) throw new HTTPException(409, { message: "Already accepted" });
    if (inv.revokedAt) throw new HTTPException(410, { message: "Invitation revoked" });
    if (inv.expiresAt <= new Date())
      throw new HTTPException(410, { message: "Invitation expired" });

    if (inv.email.toLowerCase() !== user.email.toLowerCase()) {
      throw new HTTPException(403, {
        message: `This invitation was sent to ${inv.email}`,
      });
    }

    // If they're already a member, only mark accepted.
    const existing = await drizzle.projectRepo.findMembership(
      drizzle.db, inv.projectId, user.id,
    );
    if (existing) {
      await drizzle.invitationRepo.markAccepted(drizzle.db, inv.id);
      return c.json(ok({
        projectId: inv.projectId,
        role: existing.role,
      } satisfies AcceptInvitationResponse));
    }

    await drizzle.db.transaction(async (tx) => {
      await drizzle.projectRepo.createProjectMember(tx, {
        projectId: inv.projectId,
        userId: user.id,
        role: inv.role,
      });
      await drizzle.invitationRepo.markAccepted(tx, inv.id);
      await audit(
        {
          projectId: inv.projectId,
          userId: user.id,
          action: "invitation.accepted",
          resource: "invitation",
          resourceId: inv.id,
          after: { role: inv.role },
          ...extractRequestContext(c),
        },
        tx,
      );
    });

    const payload: AcceptInvitationResponse = {
      projectId: inv.projectId,
      role: inv.role,
    };
    return c.json(ok(payload));
  });
```

- [ ] **Step 4: Mount the route**

Edit `apps/api/src/app.ts`. Add the import and mount under the root path:

```ts
import { publicInvitationsRoute } from "./routes/public/invitations";
// ...
app.route("/invitations", publicInvitationsRoute);
```

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @rovenue/api test public/invitations
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/public apps/api/src/app.ts
git commit -m "feat(api): public invitation preview + accept routes"
```

---

## Phase 7 — SES bounce webhook + cross-project suppression

### Task 7.1: SNS signature verifier

**Files:**
- Create: `apps/api/src/lib/sns-signature.ts`
- Test: `apps/api/src/lib/sns-signature.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/lib/sns-signature.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { verifySnsSignature, isAmazonSigningCertHost } from "./sns-signature";

describe("isAmazonSigningCertHost", () => {
  it("accepts sns.us-east-1.amazonaws.com", () => {
    expect(
      isAmazonSigningCertHost("https://sns.us-east-1.amazonaws.com/x.pem"),
    ).toBe(true);
  });
  it("rejects non-amazonaws.com host", () => {
    expect(
      isAmazonSigningCertHost("https://evil.example.com/x.pem"),
    ).toBe(false);
  });
  it("rejects subdomain attack", () => {
    expect(
      isAmazonSigningCertHost("https://amazonaws.com.evil.com/x.pem"),
    ).toBe(false);
  });
});

describe("verifySnsSignature", () => {
  it("rejects payloads with wrong SignatureVersion", async () => {
    await expect(
      verifySnsSignature({
        Type: "Notification",
        SignatureVersion: "2",
        Signature: "",
        SigningCertURL: "https://sns.us-east-1.amazonaws.com/cert.pem",
        Message: "hi",
        MessageId: "m",
        Timestamp: "2026-05-26T00:00:00.000Z",
        TopicArn: "arn:aws:sns:us-east-1:1:t",
      } as any),
    ).rejects.toThrow(/SignatureVersion/);
  });

  it("rejects payloads from a non-amazonaws cert host", async () => {
    await expect(
      verifySnsSignature({
        Type: "Notification",
        SignatureVersion: "1",
        Signature: "abc",
        SigningCertURL: "https://evil.example.com/cert.pem",
        Message: "hi",
        MessageId: "m",
        Timestamp: "2026-05-26T00:00:00.000Z",
        TopicArn: "arn:aws:sns:us-east-1:1:t",
      } as any),
    ).rejects.toThrow(/SigningCertURL/);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
pnpm --filter @rovenue/api test sns-signature.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement signature verifier**

Create `apps/api/src/lib/sns-signature.ts`:

```ts
import { createVerify } from "node:crypto";

export interface SnsPayload {
  Type: "Notification" | "SubscriptionConfirmation" | "UnsubscribeConfirmation";
  MessageId: string;
  TopicArn: string;
  Subject?: string;
  Message: string;
  Timestamp: string;
  SignatureVersion: string;
  Signature: string;
  SigningCertURL: string;
  Token?: string;       // SubscriptionConfirmation
  SubscribeURL?: string;
}

const STRING_TO_SIGN_KEYS_NOTIFICATION = [
  "Message", "MessageId", "Subject", "Timestamp", "TopicArn", "Type",
] as const;
const STRING_TO_SIGN_KEYS_SUBSCRIPTION = [
  "Message", "MessageId", "SubscribeURL", "Timestamp", "Token", "TopicArn", "Type",
] as const;

export function isAmazonSigningCertHost(url: string): boolean {
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return false;
    return /\.amazonaws\.com$/i.test(u.hostname);
  } catch {
    return false;
  }
}

function canonicalize(p: SnsPayload): string {
  const keys =
    p.Type === "Notification"
      ? STRING_TO_SIGN_KEYS_NOTIFICATION
      : STRING_TO_SIGN_KEYS_SUBSCRIPTION;
  const lines: string[] = [];
  for (const k of keys) {
    const v = (p as any)[k];
    if (v == null) continue;
    lines.push(k);
    lines.push(String(v));
  }
  return lines.join("\n") + "\n";
}

async function fetchPem(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`cert fetch ${res.status}`);
  return res.text();
}

export async function verifySnsSignature(p: SnsPayload): Promise<void> {
  if (p.SignatureVersion !== "1") {
    throw new Error(`Unsupported SignatureVersion: ${p.SignatureVersion}`);
  }
  if (!isAmazonSigningCertHost(p.SigningCertURL)) {
    throw new Error(`Untrusted SigningCertURL host: ${p.SigningCertURL}`);
  }
  const pem = await fetchPem(p.SigningCertURL);
  const verifier = createVerify("RSA-SHA1");
  verifier.update(canonicalize(p));
  verifier.end();
  const ok = verifier.verify(pem, p.Signature, "base64");
  if (!ok) throw new Error("Invalid SNS signature");
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @rovenue/api test sns-signature.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/sns-signature.ts apps/api/src/lib/sns-signature.test.ts
git commit -m "feat(api): SNS signature verifier"
```

### Task 7.2: SES events parser

**Files:**
- Create: `apps/api/src/lib/ses-events.ts`
- Test: `apps/api/src/lib/ses-events.test.ts`
- Create: `apps/api/src/lib/__fixtures__/ses-bounce.json`
- Create: `apps/api/src/lib/__fixtures__/ses-complaint.json`
- Create: `apps/api/src/lib/__fixtures__/ses-delivery.json`

- [ ] **Step 1: Write fixtures** (real-shaped SES event payloads)

Create `apps/api/src/lib/__fixtures__/ses-bounce.json`:

```json
{
  "notificationType": "Bounce",
  "bounce": {
    "bounceType": "Permanent",
    "bounceSubType": "General",
    "bouncedRecipients": [{ "emailAddress": "a@b.com", "diagnosticCode": "550 user unknown" }],
    "timestamp": "2026-05-26T00:00:00Z",
    "feedbackId": "f1"
  },
  "mail": {
    "messageId": "ses-msg-1",
    "tags": { "ses:configuration-set": ["rovenue-events"] }
  }
}
```

Create `apps/api/src/lib/__fixtures__/ses-complaint.json`:

```json
{
  "notificationType": "Complaint",
  "complaint": { "complainedRecipients": [{ "emailAddress": "a@b.com" }] },
  "mail": {
    "messageId": "ses-msg-2",
    "tags": { "ses:configuration-set": ["rovenue-events"] }
  }
}
```

Create `apps/api/src/lib/__fixtures__/ses-delivery.json`:

```json
{
  "notificationType": "Delivery",
  "delivery": { "recipients": ["a@b.com"] },
  "mail": {
    "messageId": "ses-msg-3",
    "tags": { "ses:configuration-set": ["rovenue-events"] }
  }
}
```

- [ ] **Step 2: Write the failing test**

Create `apps/api/src/lib/ses-events.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseSesEvent, type SesEventPatch } from "./ses-events";

function fixture(name: string): string {
  return readFileSync(
    join(__dirname, "__fixtures__", `ses-${name}.json`),
    "utf8",
  );
}

describe("parseSesEvent", () => {
  it("Permanent bounce → BOUNCED with diagnostic", () => {
    const out = parseSesEvent(fixture("bounce")) as SesEventPatch;
    expect(out).toEqual({
      configurationSet: "rovenue-events",
      sesMessageId: "ses-msg-1",
      status: "BOUNCED",
      error: "550 user unknown",
    });
  });

  it("Complaint → COMPLAINED", () => {
    const out = parseSesEvent(fixture("complaint")) as SesEventPatch;
    expect(out.status).toBe("COMPLAINED");
    expect(out.sesMessageId).toBe("ses-msg-2");
  });

  it("Delivery → DELIVERED with no error", () => {
    const out = parseSesEvent(fixture("delivery")) as SesEventPatch;
    expect(out.status).toBe("DELIVERED");
    expect(out.error).toBeNull();
  });

  it("Transient bounce → null (ignored)", () => {
    const transient = JSON.stringify({
      notificationType: "Bounce",
      bounce: { bounceType: "Transient", bouncedRecipients: [] },
      mail: { messageId: "x", tags: { "ses:configuration-set": ["rovenue-events"] } },
    });
    expect(parseSesEvent(transient)).toBeNull();
  });
});
```

- [ ] **Step 3: Implement parser**

Create `apps/api/src/lib/ses-events.ts`:

```ts
export type DeliveryStatus = "DELIVERED" | "BOUNCED" | "COMPLAINED";

export interface SesEventPatch {
  configurationSet: string | null;
  sesMessageId: string;
  status: DeliveryStatus;
  error: string | null;
}

export function parseSesEvent(rawMessage: string): SesEventPatch | null {
  let evt: any;
  try { evt = JSON.parse(rawMessage); } catch { return null; }
  if (!evt?.notificationType) return null;
  const sesMessageId = evt.mail?.messageId;
  if (!sesMessageId) return null;
  const cs = evt.mail?.tags?.["ses:configuration-set"];
  const configurationSet = Array.isArray(cs) ? (cs[0] ?? null) : null;

  switch (evt.notificationType) {
    case "Bounce": {
      if (evt.bounce?.bounceType !== "Permanent") return null;
      const diag = evt.bounce.bouncedRecipients?.[0]?.diagnosticCode ?? "permanent bounce";
      return { configurationSet, sesMessageId, status: "BOUNCED", error: diag };
    }
    case "Complaint":
      return { configurationSet, sesMessageId, status: "COMPLAINED", error: null };
    case "Delivery":
      return { configurationSet, sesMessageId, status: "DELIVERED", error: null };
    case "Reject":
      return { configurationSet, sesMessageId, status: "BOUNCED", error: "rejected" };
    default:
      return null;
  }
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @rovenue/api test ses-events.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/ses-events.ts apps/api/src/lib/ses-events.test.ts apps/api/src/lib/__fixtures__
git commit -m "feat(api): SES event parser"
```

### Task 7.3: Webhook route

**Files:**
- Create: `apps/api/src/routes/webhooks/ses-events.ts`
- Modify: `apps/api/src/app.ts`
- Test: `apps/api/src/routes/webhooks/ses-events.integration.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/routes/webhooks/ses-events.integration.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { app } from "../../app";
import { drizzle } from "@rovenue/db";
import { createTestProject } from "../../test/factories";
import { generateInvitationToken } from "../../lib/invitation-token";

// We disable signature verification for the integration test via env.
process.env.AWS_SES_EVENTS_VERIFY_SIGNATURE = "false";
process.env.AWS_SES_CONFIGURATION_SET = "rovenue-events";

describe("POST /webhooks/ses-events", () => {
  afterEach(async () => {
    await drizzle.db.execute(`DELETE FROM project_invitations`);
  });

  it("Bounce → flips invitation row to BOUNCED", async () => {
    const { projectId, ownerUserId } = await createTestProject();
    const t = generateInvitationToken();
    const inv = await drizzle.invitationRepo.createInvitation(drizzle.db, {
      projectId, email: "b@example.com", role: "DEVELOPER",
      tokenHash: t.hash, invitedByUserId: ownerUserId,
      expiresAt: new Date(Date.now() + 86_400_000),
    });
    await drizzle.invitationRepo.patchSendResult(drizzle.db, inv.id, {
      sesMessageId: "ses-msg-bounce", lastSentAt: new Date(),
    });

    const snsBody = {
      Type: "Notification",
      MessageId: "sns-id-1",
      TopicArn: "arn:aws:sns:us-east-1:1:rovenue",
      Timestamp: new Date().toISOString(),
      SignatureVersion: "1",
      Signature: "skip",
      SigningCertURL: "https://sns.us-east-1.amazonaws.com/x.pem",
      Message: JSON.stringify({
        notificationType: "Bounce",
        bounce: {
          bounceType: "Permanent",
          bouncedRecipients: [{ emailAddress: "b@example.com", diagnosticCode: "550 unknown" }],
        },
        mail: {
          messageId: "ses-msg-bounce",
          tags: { "ses:configuration-set": ["rovenue-events"] },
        },
      }),
    };
    const res = await app.request(`/webhooks/ses-events`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-amz-sns-message-type": "Notification" },
      body: JSON.stringify(snsBody),
    });
    expect(res.status).toBe(200);
    const after = await drizzle.invitationRepo.findInvitationByTokenHash(drizzle.db, t.hash);
    expect(after?.deliveryStatus).toBe("BOUNCED");
    expect(after?.deliveryError).toBe("550 unknown");
  });
});
```

- [ ] **Step 2: Run test, see failure**

```bash
pnpm --filter @rovenue/api test ses-events.integration.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement the route**

Create `apps/api/src/routes/webhooks/ses-events.ts`:

```ts
import { Hono } from "hono";
import { drizzle } from "@rovenue/db";
import { env } from "../../lib/env";
import { logger } from "../../lib/logger";
import { parseSesEvent } from "../../lib/ses-events";
import { verifySnsSignature, type SnsPayload } from "../../lib/sns-signature";

const log = logger.child("ses-events");

export const sesEventsRoute = new Hono()
  .post("/", async (c) => {
    const payload = (await c.req.json()) as SnsPayload;

    if (env.AWS_SES_EVENTS_VERIFY_SIGNATURE) {
      try {
        await verifySnsSignature(payload);
      } catch (e) {
        log.warn("rejected SNS payload", {
          err: e instanceof Error ? e.message : String(e),
        });
        return c.json({ ok: false }, 403);
      }
    }

    if (payload.Type === "SubscriptionConfirmation" && payload.SubscribeURL) {
      // One-shot confirm.
      await fetch(payload.SubscribeURL);
      return c.json({ ok: true });
    }

    if (payload.Type !== "Notification") {
      return c.json({ ok: true });
    }

    const patch = parseSesEvent(payload.Message);
    if (!patch) return c.json({ ok: true });

    if (
      env.AWS_SES_CONFIGURATION_SET &&
      patch.configurationSet &&
      patch.configurationSet !== env.AWS_SES_CONFIGURATION_SET
    ) {
      log.warn("ses event for unrelated configuration set", {
        got: patch.configurationSet,
        expected: env.AWS_SES_CONFIGURATION_SET,
      });
      return c.json({ ok: true });
    }

    await drizzle.invitationRepo.setDeliveryStatus(
      drizzle.db, patch.sesMessageId, patch.status, patch.error,
    );
    return c.json({ ok: true });
  });
```

- [ ] **Step 4: Mount in app.ts**

Edit `apps/api/src/app.ts`:

```ts
import { sesEventsRoute } from "./routes/webhooks/ses-events";
// ...
app.route("/webhooks/ses-events", sesEventsRoute);
```

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @rovenue/api test ses-events.integration.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/routes/webhooks apps/api/src/app.ts
git commit -m "feat(api): SES bounce/complaint webhook"
```

---

## Phase 8 — Dashboard rewrite

### Task 8.1: New hooks

**Files:**
- Modify: `apps/dashboard/src/lib/hooks/useProjectAdmin.ts`

- [ ] **Step 1: Add invitation + member-management hooks**

Edit `apps/dashboard/src/lib/hooks/useProjectAdmin.ts`. After the existing `useProjectMembers`, append:

```ts
import type {
  CreateInvitationRequest,
  CreateInvitationResponse,
  ListInvitationsResponse,
  TransferOwnershipRequest,
  UpdateMemberRoleRequest,
  ProjectMemberRow,
  AssignableRole,
} from "@rovenue/shared";

export function useUpdateMemberRole() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId, userId, role,
    }: { projectId: string; userId: string; role: AssignableRole }) =>
      api<{ member: ProjectMemberRow }>(
        `/dashboard/projects/${projectId}/members/${userId}`,
        {
          method: "PATCH",
          body: JSON.stringify({ role } satisfies UpdateMemberRoleRequest),
        },
      ),
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: ["members", vars.projectId] }),
  });
}

export function useRemoveMember() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId, userId,
    }: { projectId: string; userId: string }) =>
      api(`/dashboard/projects/${projectId}/members/${userId}`, {
        method: "DELETE",
      }),
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: ["members", vars.projectId] }),
  });
}

export function useLeaveProject() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ projectId }: { projectId: string }) =>
      api(`/dashboard/projects/${projectId}/members/leave`, { method: "POST" }),
    onSuccess: () => qc.invalidateQueries(),
  });
}

export function useTransferOwnership() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId, toUserId,
    }: { projectId: string; toUserId: string }) =>
      api(`/dashboard/projects/${projectId}/members/transfer`, {
        method: "POST",
        body: JSON.stringify({ toUserId } satisfies TransferOwnershipRequest),
      }),
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: ["members", vars.projectId] }),
  });
}

export function useProjectInvitations(projectId: string) {
  return useQuery({
    queryKey: ["invitations", projectId],
    enabled: Boolean(projectId),
    queryFn: () =>
      api<ListInvitationsResponse>(
        `/dashboard/projects/${projectId}/invitations`,
      ),
    select: (res) => res.invitations,
  });
}

export function useCreateInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId, email, role,
    }: { projectId: string } & CreateInvitationRequest) =>
      api<CreateInvitationResponse>(
        `/dashboard/projects/${projectId}/invitations`,
        {
          method: "POST",
          body: JSON.stringify({ email, role } satisfies CreateInvitationRequest),
        },
      ),
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: ["invitations", vars.projectId] }),
  });
}

export function useRevokeInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId, invitationId,
    }: { projectId: string; invitationId: string }) =>
      api(`/dashboard/projects/${projectId}/invitations/${invitationId}`, {
        method: "DELETE",
      }),
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: ["invitations", vars.projectId] }),
  });
}

export function useResendInvitation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      projectId, invitationId,
    }: { projectId: string; invitationId: string }) =>
      api(`/dashboard/projects/${projectId}/invitations/${invitationId}/resend`, {
        method: "POST",
      }),
    onSuccess: (_d, vars) =>
      qc.invalidateQueries({ queryKey: ["invitations", vars.projectId] }),
  });
}
```

- [ ] **Step 2: Build dashboard**

```bash
pnpm --filter @rovenue/dashboard build
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/lib/hooks/useProjectAdmin.ts
git commit -m "feat(dashboard): member mgmt + invitation hooks"
```

### Task 8.2: Invite dialog component

**Files:**
- Create: `apps/dashboard/src/components/projects/InviteMemberDialog.tsx`
- Modify: `apps/dashboard/src/i18n/locales/en.json` (add strings inline below)

- [ ] **Step 1: Add i18n strings**

In `apps/dashboard/src/i18n/locales/en.json`, locate the existing `"members"` key (it currently appears under `settings.tabs.members`; we need a new top-level `members` block). Add a new top-level key (or extend the existing `members` block if one exists):

```json
"members": {
  "title": "Members",
  "subtitle": "Project access roster. Every project must keep at least one OWNER.",
  "cols": {
    "user": "User",
    "role": "Role",
    "since": "Member since",
    "email": "Email",
    "expires": "Expires",
    "status": "Status"
  },
  "role": {
    "owner": "Owner",
    "admin": "Admin",
    "developer": "Developer",
    "growth": "Growth",
    "customer_support": "Customer Support"
  },
  "empty": "No members yet.",
  "invite": {
    "cta": "Invite member",
    "title": "Invite a new member",
    "emailLabel": "Email",
    "emailPlaceholder": "name@example.com",
    "roleLabel": "Role",
    "submit": "Send invitation",
    "successTitle": "Invitation sent",
    "successBody": "We've emailed {{email}}. The invite link is below if you want to share it directly. It expires in 7 days.",
    "refreshedBanner": "Replaced an existing pending invite.",
    "copyLink": "Copy link",
    "copied": "Copied!",
    "errors": {
      "already_member": "That email is already a project member.",
      "invalid_email": "Enter a valid email address."
    }
  },
  "actions": {
    "changeRole": "Change role",
    "remove": "Remove from project",
    "leave": "Leave project",
    "transfer": "Transfer ownership…",
    "resend": "Resend email",
    "revoke": "Revoke invitation"
  },
  "transfer": {
    "title": "Transfer ownership",
    "warning": "You will be demoted to ADMIN. Continue?",
    "confirm": "Transfer ownership"
  },
  "remove": {
    "title": "Remove {{name}}?",
    "confirm": "Remove member"
  },
  "leave": {
    "title": "Leave this project?",
    "lastOwner": "You are the last OWNER. Transfer ownership first.",
    "confirm": "Leave project"
  },
  "invitations": {
    "title": "Pending invitations",
    "emptyTitle": "No pending invitations",
    "status": {
      "pending": "Sent",
      "accepted": "Accepted",
      "revoked": "Revoked",
      "expired": "Expired",
      "bounced": "Bounced",
      "complained": "Complained",
      "suppressed": "Suppressed"
    },
    "expiresIn": "in {{count}} days"
  }
}
```

If a `members` block already exists with the partial content seen at line 2818 (`subtitle`: "Manage workspace members."), merge / replace it with the block above.

- [ ] **Step 2: Implement the dialog**

Create `apps/dashboard/src/components/projects/InviteMemberDialog.tsx`:

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ASSIGNABLE_ROLES, type AssignableRole } from "@rovenue/shared";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../ui/dialog";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Select } from "../../ui/select";
import { useCreateInvitation } from "../../lib/hooks/useProjectAdmin";

interface Props {
  projectId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function InviteMemberDialog({ projectId, open, onOpenChange }: Props) {
  const { t } = useTranslation();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<AssignableRole>("DEVELOPER");
  const [success, setSuccess] = useState<
    | { inviteUrl: string; email: string; refreshed: boolean }
    | null
  >(null);
  const [error, setError] = useState<string | null>(null);

  const create = useCreateInvitation();

  function reset() {
    setEmail("");
    setRole("DEVELOPER");
    setSuccess(null);
    setError(null);
  }

  async function submit() {
    setError(null);
    try {
      const res = await create.mutateAsync({ projectId, email: email.trim().toLowerCase(), role });
      setSuccess({
        inviteUrl: res.inviteUrl,
        email: res.invitation.email,
        refreshed: false, // header isn't surfaced by the api() helper today;
                          // see Task 8.5 if we want to expose it.
      });
    } catch (e: any) {
      const msg = e?.message ?? "";
      if (msg.includes("ALREADY_MEMBER"))
        setError(t("members.invite.errors.already_member"));
      else setError(msg);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { onOpenChange(o); if (!o) reset(); }}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("members.invite.title")}</DialogTitle>
        </DialogHeader>

        {success ? (
          <div className="space-y-3">
            {success.refreshed && (
              <div className="rounded-md border border-rv-divider bg-rv-c2 px-3 py-2 text-[12px] text-rv-mute-700">
                {t("members.invite.refreshedBanner")}
              </div>
            )}
            <p className="text-[13px]">
              {t("members.invite.successBody", { email: success.email })}
            </p>
            <div className="flex items-center gap-2">
              <Input value={success.inviteUrl} readOnly className="flex-1 font-mono text-[11px]" />
              <Button
                onClick={() => navigator.clipboard.writeText(success.inviteUrl)}
              >
                {t("members.invite.copyLink")}
              </Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <label className="block">
              <span className="text-[12px] text-rv-mute-700">{t("members.invite.emailLabel")}</span>
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={t("members.invite.emailPlaceholder")}
              />
            </label>
            <label className="block">
              <span className="text-[12px] text-rv-mute-700">{t("members.invite.roleLabel")}</span>
              <Select
                value={role}
                onChange={(e) => setRole(e.currentTarget.value as AssignableRole)}
              >
                {ASSIGNABLE_ROLES.map((r) => (
                  <option key={r} value={r}>{t(`members.role.${r.toLowerCase()}`)}</option>
                ))}
              </Select>
            </label>
            {error && <div className="text-[12px] text-rv-danger">{error}</div>}
            <Button onClick={submit} disabled={create.isPending || !email}>
              {t("members.invite.submit")}
            </Button>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
```

(Confirm the actual UI primitives in `apps/dashboard/src/ui/` and adjust imports — the names above match the existing chip/menu pattern but a quick `ls apps/dashboard/src/ui/` will tell you the actual component file names.)

- [ ] **Step 3: Build**

```bash
pnpm --filter @rovenue/dashboard build
```

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/components/projects/InviteMemberDialog.tsx apps/dashboard/src/i18n/locales/en.json
git commit -m "feat(dashboard): InviteMemberDialog component + i18n"
```

### Task 8.3: Members page rewrite

**Files:**
- Modify: `apps/dashboard/src/routes/_authed/projects/$projectId/settings/members.tsx`

- [ ] **Step 1: Rewrite the page**

Replace the contents with:

```tsx
import { useState } from "react";
import { createFileRoute, useParams, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Chip } from "../../../../../ui/chip";
import { Button } from "../../../../../ui/button";
import { Menu, MenuItem, MenuTrigger } from "../../../../../ui/menu";
import { useProject } from "../../../../../lib/hooks/useProject";
import { useSession } from "../../../../../lib/hooks/useSession";
import {
  useProjectMembers,
  useProjectInvitations,
  useUpdateMemberRole,
  useRemoveMember,
  useLeaveProject,
  useTransferOwnership,
  useRevokeInvitation,
  useResendInvitation,
} from "../../../../../lib/hooks/useProjectAdmin";
import { InviteMemberDialog } from "../../../../../components/projects/InviteMemberDialog";
import { ASSIGNABLE_ROLES, type AssignableRole, type MemberRoleName } from "@rovenue/shared";

export const Route = createFileRoute("/_authed/projects/$projectId/settings/members")({
  component: MembersRoute,
});

function MembersRoute() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/settings/members",
  });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <MembersPage projectId={projectId} />;
}

function MembersPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: session } = useSession();
  const callerId = session?.user.id;

  const { data: members = [], isLoading: mLoading } = useProjectMembers(projectId);
  const { data: invitations = [], isLoading: iLoading } = useProjectInvitations(projectId);

  const callerRole = members.find((m) => m.userId === callerId)?.role;
  const canManage = callerRole === "OWNER" || callerRole === "ADMIN";
  const canTransfer = callerRole === "OWNER";

  const [inviteOpen, setInviteOpen] = useState(false);
  const updateRole = useUpdateMemberRole();
  const remove = useRemoveMember();
  const leave = useLeaveProject();
  const transfer = useTransferOwnership();
  const revoke = useRevokeInvitation();
  const resend = useResendInvitation();

  return (
    <>
      <header className="pb-5 flex items-start justify-between">
        <div>
          <h1 className="text-[24px] font-semibold leading-8 tracking-tight">
            {t("members.title")}
          </h1>
          <p className="mt-1 text-[13px] text-rv-mute-500">{t("members.subtitle")}</p>
        </div>
        {canManage && (
          <Button onClick={() => setInviteOpen(true)}>+ {t("members.invite.cta")}</Button>
        )}
      </header>

      <div className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
        <div className="grid grid-cols-[minmax(0,1fr)_160px_160px_40px] gap-3 border-b border-rv-divider bg-rv-c2 px-4 py-2 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
          <span>{t("members.cols.user")}</span>
          <span>{t("members.cols.role")}</span>
          <span>{t("members.cols.since")}</span>
          <span />
        </div>
        {mLoading && members.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12px] text-rv-mute-500">
            {t("common.loading", "Loading…")}
          </div>
        ) : members.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12px] text-rv-mute-500">
            {t("members.empty")}
          </div>
        ) : (
          members.map((m) => {
            const isSelf = m.userId === callerId;
            const isOwner = m.role === "OWNER";
            const canEditThis = canManage && !isSelf && !isOwner;
            const canTransferToThis = canTransfer && !isSelf && !isOwner;
            return (
              <div
                key={m.id}
                className="grid grid-cols-[minmax(0,1fr)_160px_160px_40px] items-center gap-3 border-b border-rv-divider px-4 py-2.5 text-[12px] last:border-b-0"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  {m.image ? (
                    <img src={m.image} alt="" className="h-6 w-6 shrink-0 rounded-full" />
                  ) : (
                    <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-rv-c3 text-[10px] font-medium text-rv-mute-700">
                      {(m.name ?? m.email).slice(0, 1).toUpperCase()}
                    </div>
                  )}
                  <div className="min-w-0">
                    <div className="truncate font-medium">{m.name ?? m.email}</div>
                    {m.name && (
                      <div className="truncate text-[11px] text-rv-mute-500">{m.email}</div>
                    )}
                  </div>
                </div>
                <Chip tone={isOwner ? "primary" : m.role === "ADMIN" ? "warning" : "default"}>
                  {t(`members.role.${m.role.toLowerCase()}`)}
                </Chip>
                <span className="font-rv-mono text-rv-mute-500">
                  {new Date(m.createdAt).toLocaleDateString()}
                </span>
                <div>
                  {(canEditThis || canTransferToThis || isSelf) && (
                    <Menu>
                      <MenuTrigger>⋯</MenuTrigger>
                      {canEditThis && (
                        <>
                          {ASSIGNABLE_ROLES.filter((r) => r !== m.role).map((r) => (
                            <MenuItem
                              key={r}
                              onSelect={() =>
                                updateRole.mutate({ projectId, userId: m.userId, role: r })
                              }
                            >
                              {t("members.actions.changeRole")}: {t(`members.role.${r.toLowerCase()}`)}
                            </MenuItem>
                          ))}
                          <MenuItem
                            onSelect={() => remove.mutate({ projectId, userId: m.userId })}
                          >
                            {t("members.actions.remove")}
                          </MenuItem>
                        </>
                      )}
                      {canTransferToThis && (
                        <MenuItem
                          onSelect={() =>
                            transfer.mutate({ projectId, toUserId: m.userId })
                          }
                        >
                          {t("members.actions.transfer")}
                        </MenuItem>
                      )}
                      {isSelf && callerRole !== "OWNER" && (
                        <MenuItem
                          onSelect={async () => {
                            await leave.mutateAsync({ projectId });
                            navigate({ to: "/projects" });
                          }}
                        >
                          {t("members.actions.leave")}
                        </MenuItem>
                      )}
                    </Menu>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>

      {invitations.length > 0 && (
        <section className="mt-8">
          <h2 className="mb-3 text-[14px] font-semibold">{t("members.invitations.title")}</h2>
          <div className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
            <div className="grid grid-cols-[minmax(0,1fr)_160px_140px_120px_40px] gap-3 border-b border-rv-divider bg-rv-c2 px-4 py-2 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
              <span>{t("members.cols.email")}</span>
              <span>{t("members.cols.role")}</span>
              <span>{t("members.cols.expires")}</span>
              <span>{t("members.cols.status")}</span>
              <span />
            </div>
            {invitations.map((inv) => {
              const daysLeft = Math.max(
                0,
                Math.ceil((new Date(inv.expiresAt).getTime() - Date.now()) / 86_400_000),
              );
              const isBounced =
                inv.deliveryStatus === "BOUNCED" ||
                inv.deliveryStatus === "COMPLAINED" ||
                inv.deliveryStatus === "SUPPRESSED";
              const statusTone = isBounced
                ? "danger"
                : inv.status === "pending"
                  ? "default"
                  : "muted";
              const statusKey = isBounced
                ? inv.deliveryStatus.toLowerCase()
                : inv.status;
              return (
                <div
                  key={inv.id}
                  className="grid grid-cols-[minmax(0,1fr)_160px_140px_120px_40px] items-center gap-3 border-b border-rv-divider px-4 py-2.5 text-[12px] last:border-b-0"
                >
                  <span className="truncate">{inv.email}</span>
                  <Chip>{t(`members.role.${inv.role.toLowerCase()}`)}</Chip>
                  <span className="text-rv-mute-500">
                    {t("members.invitations.expiresIn", { count: daysLeft })}
                  </span>
                  <Chip tone={statusTone as any}>
                    {t(`members.invitations.status.${statusKey}`)}
                  </Chip>
                  <div>
                    {canManage && inv.status === "pending" && (
                      <Menu>
                        <MenuTrigger>⋯</MenuTrigger>
                        <MenuItem
                          onSelect={() =>
                            resend.mutate({ projectId, invitationId: inv.id })
                          }
                        >
                          {t("members.actions.resend")}
                        </MenuItem>
                        <MenuItem
                          onSelect={() =>
                            revoke.mutate({ projectId, invitationId: inv.id })
                          }
                        >
                          {t("members.actions.revoke")}
                        </MenuItem>
                      </Menu>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      <InviteMemberDialog projectId={projectId} open={inviteOpen} onOpenChange={setInviteOpen} />
    </>
  );
}
```

- [ ] **Step 2: Verify build**

```bash
pnpm --filter @rovenue/dashboard build
```

Expected: clean. (Adjust `useSession`/UI primitive imports if they don't match — `ls apps/dashboard/src/lib/hooks/` + `ls apps/dashboard/src/ui/`.)

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/routes/_authed/projects/\$projectId/settings/members.tsx
git commit -m "feat(dashboard): members page rewrite with invite + per-row actions"
```

### Task 8.4: Acceptance landing page

**Files:**
- Create: `apps/dashboard/src/routes/invitations/$token.tsx`

- [ ] **Step 1: Implement**

Create `apps/dashboard/src/routes/invitations/$token.tsx`:

```tsx
import { useEffect, useState } from "react";
import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { useSession } from "../../lib/hooks/useSession";
import { Button } from "../../ui/button";
import type { AcceptInvitationResponse, InvitationPreviewResponse } from "@rovenue/shared";

export const Route = createFileRoute("/invitations/$token")({
  component: InvitationLanding,
});

function InvitationLanding() {
  const { t } = useTranslation();
  const { token } = useParams({ from: "/invitations/$token" });
  const navigate = useNavigate();
  const { data: session, status } = useSession();

  const [preview, setPreview] = useState<InvitationPreviewResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [accepting, setAccepting] = useState(false);

  useEffect(() => {
    api<InvitationPreviewResponse>(`/invitations/${token}`)
      .then((res) => setPreview(res))
      .catch((e) => setError(e?.message ?? "Not found"));
  }, [token]);

  useEffect(() => {
    if (!preview || preview.status !== "pending" || !session?.user) return;
    if (session.user.email.toLowerCase() !== preview.email.toLowerCase()) return;
    setAccepting(true);
    api<AcceptInvitationResponse>(`/invitations/${token}/accept`, { method: "POST" })
      .then((res) => navigate({ to: `/projects/${res.projectId}` }))
      .catch((e) => setError(e?.message ?? "Could not accept"))
      .finally(() => setAccepting(false));
  }, [preview, session, token, navigate]);

  if (error) {
    return (
      <main className="mx-auto max-w-md p-8">
        <h1 className="mb-2 text-xl font-semibold">{t("common.error", "Error")}</h1>
        <p className="text-rv-mute-500">{error}</p>
      </main>
    );
  }
  if (!preview) {
    return (
      <main className="mx-auto max-w-md p-8 text-rv-mute-500">
        {t("common.loading", "Loading…")}
      </main>
    );
  }

  if (preview.status !== "pending") {
    const k = preview.status; // accepted | revoked | expired
    return (
      <main className="mx-auto max-w-md p-8">
        <h1 className="mb-2 text-xl font-semibold">
          {t(`invitationsLanding.${k}.title`, k)}
        </h1>
        <p className="text-rv-mute-500">
          {t(`invitationsLanding.${k}.body`, "")}
        </p>
      </main>
    );
  }

  if (status === "loading") {
    return (
      <main className="mx-auto max-w-md p-8 text-rv-mute-500">{t("common.loading", "Loading…")}</main>
    );
  }

  if (!session?.user) {
    return (
      <main className="mx-auto max-w-md p-8">
        <h1 className="mb-2 text-xl font-semibold">
          {t("invitationsLanding.invite.title", "You're invited to join {{project}}", {
            project: preview.projectName,
          })}
        </h1>
        <p className="mb-6 text-rv-mute-700">
          {t("invitationsLanding.invite.body",
            "{{inviter}} invited {{email}} to join {{project}} as a {{role}}.", {
              inviter: preview.inviterName ?? "Someone",
              email: preview.email,
              project: preview.projectName,
              role: preview.role,
            })}
        </p>
        <div className="flex gap-2">
          <Button onClick={() => (window.location.href = `/api/auth/sign-in/github?redirect=${encodeURIComponent(window.location.href)}`)}>
            Sign in with GitHub
          </Button>
          <Button onClick={() => (window.location.href = `/api/auth/sign-in/google?redirect=${encodeURIComponent(window.location.href)}`)}>
            Sign in with Google
          </Button>
        </div>
      </main>
    );
  }

  if (session.user.email.toLowerCase() !== preview.email.toLowerCase()) {
    return (
      <main className="mx-auto max-w-md p-8">
        <h1 className="mb-2 text-xl font-semibold">
          {t("invitationsLanding.mismatch.title", "Wrong account")}
        </h1>
        <p className="text-rv-mute-700">
          {t("invitationsLanding.mismatch.body",
            "You're signed in as {{me}}, but this invite is for {{them}}.",
            { me: session.user.email, them: preview.email })}
        </p>
      </main>
    );
  }

  return (
    <main className="mx-auto max-w-md p-8 text-rv-mute-500">
      {accepting ? t("invitationsLanding.joining", "Joining…") : t("common.loading", "Loading…")}
    </main>
  );
}
```

Add the relevant i18n keys to `en.json` under `"invitationsLanding": { ... }`.

- [ ] **Step 2: Build**

```bash
pnpm --filter @rovenue/dashboard build
```

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/routes/invitations apps/dashboard/src/i18n/locales/en.json
git commit -m "feat(dashboard): invitation acceptance landing page"
```

### Task 8.5: End-to-end smoke

**Files:**
- (Manual; document outcome here)

- [ ] **Step 1: Start the stack**

```bash
docker compose up -d
pnpm db:migrate
pnpm dev
```

- [ ] **Step 2: Run the flow**

In a browser:
1. Sign in to the dashboard.
2. Go to Project → Settings → Members.
3. Click "Invite member", enter your secondary email, choose "Developer", submit.
4. Confirm the success state shows the inviteUrl.
5. Open the inviteUrl in an incognito window. Confirm the landing page renders with project name, inviter, role.
6. Sign in (with the same email if possible).
7. Confirm redirect to `/projects/<id>` and the new member appears in the Members table.
8. As the OWNER, change the new member's role to GROWTH. Confirm the change persists.
9. Revoke any leftover pending invitation. Confirm the row disappears from the pending list.

- [ ] **Step 3: Document outcome**

Append to `docs/superpowers/plans/2026-05-26-project-members-invite.md` (this file), under a `## Smoke verification` section: a one-line "smoke passed YYYY-MM-DD" or a bullet list of issues to address.

- [ ] **Step 4: Final commit**

```bash
git commit --allow-empty -m "chore: members + invite flow smoke verified"
```

---

## Self-review notes

- **Spec coverage:** every section of `docs/superpowers/specs/2026-05-26-project-members-invite-design.md` has a phase: enum migration (Phase 1), capability matrix (Phase 2), member endpoints + transfer + leave (Phase 3), mailer + templates + queue (Phase 4), invitations schema (Phase 5), invitation API + accept (Phase 6), bounce webhook + cross-project suppression (Phase 7), UI rewrite + landing page (Phase 8).
- **Placeholder scan:** the only forward-reference comment is in Task 6.3 step 1 (worker's old `inviteUrl` construction), which is explicitly noted as a wrong intermediate the next step fixes — this is intentional pedagogy, not a TODO.
- **Type consistency:** `AssignableRole` (Phase 1.4) is used in `UpdateMemberRoleRequest` and `CreateInvitationRequest` (Phase 6.1), and matches `ASSIGNABLE_ROLES` exactly. `MemberRoleName` is the wire type; `MemberRole` is the Drizzle TS enum.
- **Sequencing gotcha:** Phase 4 stubs the invitation repo *before* Phase 5 builds it. The stub method signatures match Phase 5's real implementations so the test in 4.4 keeps passing when the real repo lands.
- **Email/token plumbing:** Task 6.3 is explicit about why the worker had to be rewired to carry `inviteUrl`. Resend issues a new token (acceptable per spec).
