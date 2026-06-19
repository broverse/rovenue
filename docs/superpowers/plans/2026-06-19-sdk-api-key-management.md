# SDK API-Key Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Settings → SDK page's three inert key buttons functional by adding backend create/revoke API-key endpoints and the dashboard UI to drive them.

**Architecture:** Append two routes to the existing chained `projectsRoute` (so Hono `AppType` inference stays intact), backed by a new `revokeApiKey` repo writer that reuses the project-create key-minting logic. The dashboard gets two react-query mutation hooks, a one-time-secret create dialog, and inline per-row revoke; all three buttons open the same dialog.

**Tech Stack:** Hono + Zod + Drizzle (backend), React + @tanstack/react-query + HeroUI/Base-UI modals + react-i18next (dashboard), Vitest (+ testcontainers Postgres for `*.integration.test.ts`).

## Global Constraints

- All API responses use the `{ data }` / `{ error: { code, message } }` envelope via the `ok()` helper and `errorHandler`.
- Create & revoke require role **ADMIN or OWNER**: `await assertProjectAccess(id, user.id, MemberRole.ADMIN)` (ADMIN rank 3, OWNER rank 4 both pass).
- Keys are **Production** publishable + secret pairs. Public prefix `rov_pub_`, secret prefix `rov_sec_`; secret plaintext layout `rov_sec_<apiKeyId>_<random>` where `apiKeyId` is 16 random hex bytes and MUST NOT contain `_`. Store only the bcrypt hash (`BCRYPT_ROUNDS = 10`).
- The plaintext secret is returned **exactly once** in the create response; never persisted except as the bcrypt hash, never logged, never put in an audit payload.
- Audit every write inside the same transaction: `api_key.created` / `api_key.revoked`, `resource: "api_key"` (both already exist in `AuditAction`). Payloads carry only the publishable identifier, never the secret.
- `drizzle.apiKeyRepo` is a namespace re-export (`export * as apiKeyRepo from "./repositories/api-keys"`); adding a function to that file exposes it automatically — no barrel edit. Same for shared types (`export * from "./dashboard"`).
- Dashboard mutations invalidate `queryKey: ["project", projectId]` on success (the source of `project.apiKeys`).
- The dashboard `api<T>(path, init)` helper auto-sets `content-type: application/json` when a body is present and always sends `credentials: "include"`.

---

### Task 1: Shared wire types

**Files:**
- Modify: `packages/shared/src/dashboard.ts` (append near `ProjectApiKey`, line ~44)

**Interfaces:**
- Consumes: existing `ProjectApiKey` interface.
- Produces: `CreateApiKeyRequest { label: string }`, `CreateApiKeyResponse { apiKey: ProjectApiKey; secretKey: string }`.

- [ ] **Step 1: Add the two interfaces**

In `packages/shared/src/dashboard.ts`, immediately after the `ProjectApiKey` interface, add:

```ts
export interface CreateApiKeyRequest {
  label: string;
}

export interface CreateApiKeyResponse {
  apiKey: ProjectApiKey;
  secretKey: string; // plaintext — shown once, only in this response
}
```

- [ ] **Step 2: Build the package to verify types compile**

Run: `pnpm --filter @rovenue/shared build`
Expected: PASS (no TS errors). The types are re-exported automatically via `export * from "./dashboard"`.

- [ ] **Step 3: Commit**

```bash
git add packages/shared/src/dashboard.ts
git commit -m "feat(shared): add CreateApiKey request/response wire types"
```

---

### Task 2: `revokeApiKey` repository writer

**Files:**
- Modify: `packages/db/src/drizzle/repositories/api-keys.ts` (append after `createApiKey`, end of file)

**Interfaces:**
- Consumes: existing `apiKeys` table import, `ActiveApiKeyRow` type, `Db` type, and `and`/`eq`/`isNull` from `drizzle-orm` (already imported at top).
- Produces: `revokeApiKey(db: Db, projectId: string, keyId: string): Promise<ActiveApiKeyRow | null>`.

- [ ] **Step 1: Implement `revokeApiKey`**

Append to `packages/db/src/drizzle/repositories/api-keys.ts`:

```ts
/**
 * Revoke a single api key by setting `revokedAt`. Scoped to BOTH the
 * key id and its owning project so a guessed id from another project
 * can't be revoked, and only affects rows that are still active.
 * Returns the affected row (sans secret) or null when nothing matched
 * (already revoked, or wrong project) — callers map null to 404.
 */
export async function revokeApiKey(
  db: Db,
  projectId: string,
  keyId: string,
): Promise<ActiveApiKeyRow | null> {
  const rows = await db
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(
      and(
        eq(apiKeys.id, keyId),
        eq(apiKeys.projectId, projectId),
        isNull(apiKeys.revokedAt),
      ),
    )
    .returning({
      id: apiKeys.id,
      label: apiKeys.label,
      keyPublic: apiKeys.keyPublic,
      environment: apiKeys.environment,
      createdAt: apiKeys.createdAt,
    });
  return rows[0] ?? null;
}
```

- [ ] **Step 2: Typecheck the db package**

Run: `pnpm --filter @rovenue/db build`
Expected: PASS (no TS errors). `revokeApiKey` is now reachable as `drizzle.apiKeyRepo.revokeApiKey`.

- [ ] **Step 3: Commit**

```bash
git add packages/db/src/drizzle/repositories/api-keys.ts
git commit -m "feat(db): add revokeApiKey writer scoped to project + active rows"
```

---

### Task 3: `POST /dashboard/projects/:id/api-keys` create route

**Files:**
- Modify: `apps/api/src/routes/dashboard/projects.ts` (add handler in the chain, before `.delete("/:id", ...)`)
- Test: `apps/api/src/routes/dashboard/api-keys.integration.test.ts` (create)

**Interfaces:**
- Consumes: `CreateApiKeyResponse` (Task 1), existing module helpers `newApiKeyId()`, `urlSafeRandom()`, `API_KEY_PREFIX`, `API_KEY_KIND`, `BCRYPT_ROUNDS`, `Environment`, `assertProjectAccess`, `audit`, `extractRequestContext`, `ok`, `drizzle.apiKeyRepo.createApiKey`.
- Produces: route `POST /:id/api-keys` returning `{ data: CreateApiKeyResponse }`.

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/src/routes/dashboard/api-keys.integration.test.ts`:

```ts
// =============================================================
// /dashboard/projects/:id/api-keys — create + revoke
// =============================================================

import { afterAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import bcrypt from "bcryptjs";
import { getDb, drizzle, projects } from "@rovenue/db";
import { auth } from "../../lib/auth";
import { errorHandler } from "../../middleware/error";
import { projectsRoute } from "./projects";

const RUN_ID = Date.now();
const db = getDb();
const schema = drizzle.schema;

function buildApp() {
  const app = new Hono();
  app.route("/projects", projectsRoute);
  app.onError(errorHandler);
  return app;
}

async function createUserAndSession(suffix: string) {
  const email = `apikey_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!apikey";
  const signUp = await auth.api.signUpEmail({
    body: { email, password, name: `apikey-${suffix}` },
  });
  if (!signUp?.user) throw new Error("signUp failed");
  const signIn = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const cookieHeader = signIn.headers.get("set-cookie");
  if (!cookieHeader) throw new Error("no set-cookie");
  return { userId: signUp.user.id, cookie: cookieHeader.split(";")[0] ?? "" };
}

const seededProjectIds: string[] = [];
async function seedProject(suffix: string) {
  const id = `prj_apikey_${RUN_ID}_${suffix}`;
  await db.insert(projects).values({ id, name: id });
  seededProjectIds.push(id);
  return id;
}

async function addMember(
  projectId: string,
  userId: string,
  role: "OWNER" | "ADMIN" | "DEVELOPER" | "GROWTH" | "CUSTOMER_SUPPORT",
) {
  await db.insert(schema.projectMembers).values({ projectId, userId, role });
}

afterAll(async () => {
  for (const id of seededProjectIds) {
    await db.delete(projects).where(eq(projects.id, id));
  }
});

describe.sequential("dashboard api-keys — create", () => {
  it("ADMIN can create a key; secret hashes back and is Production", async () => {
    const { userId, cookie } = await createUserAndSession("create_ok");
    const projectId = await seedProject("create_ok");
    await addMember(projectId, userId, "ADMIN");

    const app = buildApp();
    const res = await app.request(`/projects/${projectId}/api-keys`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "backend" }),
    });
    expect(res.status).toBe(200);
    const { data } = (await res.json()) as {
      data: { apiKey: { id: string; label: string; publicKey: string; environment: string }; secretKey: string };
    };
    expect(data.apiKey.label).toBe("backend");
    expect(data.apiKey.environment).toBe("PRODUCTION");
    expect(data.apiKey.publicKey.startsWith("rov_pub_")).toBe(true);
    expect(data.secretKey.startsWith(`rov_sec_${data.apiKey.id}_`)).toBe(true);

    const rows = await db
      .select({ hash: schema.apiKeys.keySecretHash })
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.id, data.apiKey.id));
    expect(rows[0]).toBeTruthy();
    expect(await bcrypt.compare(data.secretKey, rows[0]!.hash)).toBe(true);
  });

  it("rejects a blank label with 400", async () => {
    const { userId, cookie } = await createUserAndSession("create_blank");
    const projectId = await seedProject("create_blank");
    await addMember(projectId, userId, "ADMIN");

    const app = buildApp();
    const res = await app.request(`/projects/${projectId}/api-keys`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "   " }),
    });
    expect(res.status).toBe(400);
  });

  it("forbids a DEVELOPER (below ADMIN) with 403", async () => {
    const { userId, cookie } = await createUserAndSession("create_dev");
    const projectId = await seedProject("create_dev");
    await addMember(projectId, userId, "DEVELOPER");

    const app = buildApp();
    const res = await app.request(`/projects/${projectId}/api-keys`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ label: "nope" }),
    });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rovenue/api test -- api-keys.integration`
Expected: FAIL — the `/api-keys` route returns 404 (handler not added yet).

- [ ] **Step 3: Add the create handler**

In `apps/api/src/routes/dashboard/projects.ts`, add this validator near the other schemas (top-level, alongside `createProjectBodySchema`):

```ts
const createApiKeyBodySchema = z.object({
  label: z.string().trim().min(1).max(60),
});
```

Then insert the handler into the route chain immediately **before** the `.delete("/:id", ...)` handler:

```ts
  // POST /:id/api-keys — ADMIN+. Mints a Production publishable+secret
  // pair (same material layout as project-create) and returns the
  // secret plaintext exactly once. The audit payload carries only the
  // publishable id — never the secret.
  .post("/:id/api-keys", zValidator("json", createApiKeyBodySchema), async (c) => {
    const id = c.req.param("id");
    const user = c.get("user");
    await assertProjectAccess(id, user.id, MemberRole.ADMIN);
    const { label } = c.req.valid("json");

    const apiKeyId = newApiKeyId();
    const keyPublic = `${API_KEY_PREFIX[API_KEY_KIND.PUBLIC]}${urlSafeRandom(24)}`;

    const { apiKey, secretKey } = await drizzle.db.transaction(async (tx) => {
      const secretPlaintext = `${API_KEY_PREFIX[API_KEY_KIND.SECRET]}${apiKeyId}_${urlSafeRandom(32)}`;
      const keySecretHash = await bcrypt.hash(secretPlaintext, BCRYPT_ROUNDS);

      const createdApiKey = await drizzle.apiKeyRepo.createApiKey(tx, {
        id: apiKeyId,
        projectId: id,
        label,
        keyPublic,
        keySecretHash,
        environment: Environment.PRODUCTION,
      });

      await audit(
        {
          projectId: id,
          userId: user.id,
          action: "api_key.created",
          resource: "api_key",
          resourceId: apiKeyId,
          after: {
            id: apiKeyId,
            label,
            publicKey: keyPublic,
            environment: Environment.PRODUCTION,
          },
          ...extractRequestContext(c),
        },
        tx,
      );

      return { apiKey: createdApiKey, secretKey: secretPlaintext };
    });

    const payload: CreateApiKeyResponse = {
      apiKey: {
        id: apiKey.id,
        label: apiKey.label,
        publicKey: apiKey.keyPublic,
        environment: apiKey.environment,
        createdAt: apiKey.createdAt.toISOString(),
      },
      secretKey,
    };
    return c.json(ok(payload));
  })
```

Add `CreateApiKeyResponse` to the existing `@rovenue/shared` import block at the top of the file.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rovenue/api test -- api-keys.integration`
Expected: PASS for the three "create" tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/dashboard/projects.ts apps/api/src/routes/dashboard/api-keys.integration.test.ts
git commit -m "feat(api): add POST create-api-key route (ADMIN+, one-time secret)"
```

---

### Task 4: `DELETE /dashboard/projects/:id/api-keys/:keyId` revoke route

**Files:**
- Modify: `apps/api/src/routes/dashboard/projects.ts` (add handler before `.delete("/:id", ...)`, after the create handler)
- Test: `apps/api/src/routes/dashboard/api-keys.integration.test.ts` (add a `revoke` describe block)

**Interfaces:**
- Consumes: `drizzle.apiKeyRepo.revokeApiKey` (Task 2), `HTTPException`, `audit`, `assertProjectAccess`, `ok`.
- Produces: route `DELETE /:id/api-keys/:keyId` returning `{ data: { id: string } }`.

- [ ] **Step 1: Add the failing revoke tests**

Append to `apps/api/src/routes/dashboard/api-keys.integration.test.ts` (the `and`, `isNull` imports are already present):

```ts
describe.sequential("dashboard api-keys — revoke", () => {
  async function createKey(app: Hono, projectId: string, cookie: string, label: string) {
    const res = await app.request(`/projects/${projectId}/api-keys`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ label }),
    });
    const { data } = (await res.json()) as { data: { apiKey: { id: string } } };
    return data.apiKey.id;
  }

  it("ADMIN revokes a key; it leaves no active row and 404s on re-revoke", async () => {
    const { userId, cookie } = await createUserAndSession("revoke_ok");
    const projectId = await seedProject("revoke_ok");
    await addMember(projectId, userId, "ADMIN");
    const app = buildApp();
    const keyId = await createKey(app, projectId, cookie, "to-revoke");

    const res = await app.request(`/projects/${projectId}/api-keys/${keyId}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(res.status).toBe(200);

    const active = await db
      .select({ id: schema.apiKeys.id })
      .from(schema.apiKeys)
      .where(and(eq(schema.apiKeys.id, keyId), isNull(schema.apiKeys.revokedAt)));
    expect(active).toHaveLength(0);

    const again = await app.request(`/projects/${projectId}/api-keys/${keyId}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(again.status).toBe(404);
  });

  it("cannot revoke a key belonging to another project (404)", async () => {
    const { userId, cookie } = await createUserAndSession("revoke_foreign");
    const projectA = await seedProject("revoke_foreign_a");
    const projectB = await seedProject("revoke_foreign_b");
    await addMember(projectA, userId, "ADMIN");
    await addMember(projectB, userId, "ADMIN");
    const app = buildApp();
    const keyInA = await createKey(app, projectA, cookie, "lives-in-a");

    const res = await app.request(`/projects/${projectB}/api-keys/${keyInA}`, {
      method: "DELETE",
      headers: { cookie },
    });
    expect(res.status).toBe(404);
  });

  it("forbids a DEVELOPER from revoking (403)", async () => {
    const owner = await createUserAndSession("revoke_owner");
    const dev = await createUserAndSession("revoke_dev");
    const projectId = await seedProject("revoke_role");
    await addMember(projectId, owner.userId, "ADMIN");
    await addMember(projectId, dev.userId, "DEVELOPER");
    const app = buildApp();
    const keyId = await createKey(app, projectId, owner.cookie, "guarded");

    const res = await app.request(`/projects/${projectId}/api-keys/${keyId}`, {
      method: "DELETE",
      headers: { cookie: dev.cookie },
    });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @rovenue/api test -- api-keys.integration`
Expected: FAIL — DELETE on `/api-keys/:keyId` returns 404 (matches `/:id`? No — the `:id` delete is `/projects/:id`; `/projects/:id/api-keys/:keyId` has no handler) so the revoke tests fail.

- [ ] **Step 3: Add the revoke handler**

In `apps/api/src/routes/dashboard/projects.ts`, insert immediately **after** the create handler and **before** `.delete("/:id", ...)`:

```ts
  // DELETE /:id/api-keys/:keyId — ADMIN+. Revokes a single key
  // (sets revokedAt). Scoped to the project in the repo so a foreign
  // key id 404s. 404 when nothing active matched.
  .delete("/:id/api-keys/:keyId", async (c) => {
    const id = c.req.param("id");
    const keyId = c.req.param("keyId");
    const user = c.get("user");
    await assertProjectAccess(id, user.id, MemberRole.ADMIN);

    await drizzle.db.transaction(async (tx) => {
      const revoked = await drizzle.apiKeyRepo.revokeApiKey(tx, id, keyId);
      if (!revoked) {
        throw new HTTPException(404, { message: "API key not found" });
      }
      await audit(
        {
          projectId: id,
          userId: user.id,
          action: "api_key.revoked",
          resource: "api_key",
          resourceId: keyId,
          before: {
            id: revoked.id,
            label: revoked.label,
            publicKey: revoked.keyPublic,
          },
          ...extractRequestContext(c),
        },
        tx,
      );
    });

    return c.json(ok({ id: keyId }));
  })
```

> Route ordering: `.delete("/:id/api-keys/:keyId", ...)` is more specific than `.delete("/:id", ...)` and both are distinct path depths, so Hono matches them unambiguously regardless of order. Keeping the keyId handler before `/:id` is for readability.

- [ ] **Step 4: Run the full file to verify pass**

Run: `pnpm --filter @rovenue/api test -- api-keys.integration`
Expected: PASS for all create + revoke tests.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/routes/dashboard/projects.ts apps/api/src/routes/dashboard/api-keys.integration.test.ts
git commit -m "feat(api): add DELETE revoke-api-key route (ADMIN+, project-scoped)"
```

---

### Task 5: Dashboard mutation hooks

**Files:**
- Create: `apps/dashboard/src/lib/hooks/useCreateApiKey.ts`
- Create: `apps/dashboard/src/lib/hooks/useRevokeApiKey.ts`

**Interfaces:**
- Consumes: `api` from `../api`, `CreateApiKeyRequest` / `CreateApiKeyResponse` from `@rovenue/shared`.
- Produces: `useCreateApiKey(projectId): UseMutationResult<CreateApiKeyResponse, ApiError, CreateApiKeyRequest>`, `useRevokeApiKey(projectId): UseMutationResult<{ id: string }, ApiError, string>`.

- [ ] **Step 1: Write `useCreateApiKey`**

Create `apps/dashboard/src/lib/hooks/useCreateApiKey.ts`:

```ts
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { CreateApiKeyRequest, CreateApiKeyResponse } from "@rovenue/shared";
import { api } from "../api";

export function useCreateApiKey(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: CreateApiKeyRequest) =>
      api<CreateApiKeyResponse>(`/dashboard/projects/${projectId}/api-keys`, {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", projectId] }),
  });
}
```

- [ ] **Step 2: Write `useRevokeApiKey`**

Create `apps/dashboard/src/lib/hooks/useRevokeApiKey.ts`:

```ts
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";

export function useRevokeApiKey(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) =>
      api<{ id: string }>(`/dashboard/projects/${projectId}/api-keys/${keyId}`, {
        method: "DELETE",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["project", projectId] }),
  });
}
```

- [ ] **Step 3: Typecheck the dashboard**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit`
Expected: PASS (no errors for the two new files).

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/lib/hooks/useCreateApiKey.ts apps/dashboard/src/lib/hooks/useRevokeApiKey.ts
git commit -m "feat(dashboard): add create/revoke api-key mutation hooks"
```

---

### Task 6: i18n strings for the dialog + revoke

**Files:**
- Modify: `apps/dashboard/src/i18n/locales/en.json` (under `sdkApi.keys`)

**Interfaces:**
- Produces: i18n keys consumed by Tasks 7–8: `sdkApi.keys.actions.revoke`, `sdkApi.keys.dialog.*`, `sdkApi.keys.revokeConfirm.*`.

- [ ] **Step 1: Add the keys**

In `apps/dashboard/src/i18n/locales/en.json`, inside `sdkApi.keys.actions` add `"revoke": "Revoke"`. Then add two new sibling objects under `sdkApi.keys` (alongside `actions`, `kinds`, ...):

```json
"dialog": {
  "title": "New API key",
  "labelField": "Key name",
  "labelPlaceholder": "Production backend",
  "create": "Create key",
  "createdTitle": "Key created",
  "secretWarning": "Copy your secret key now. For security it won't be shown again.",
  "publishableLabel": "Publishable key",
  "secretLabel": "Secret key",
  "done": "Done"
},
"revokeConfirm": {
  "title": "Revoke this key?",
  "body": "Apps and servers using this key will immediately lose access. This cannot be undone.",
  "confirm": "Revoke key"
}
```

- [ ] **Step 2: Verify JSON is valid**

Run: `node -e "JSON.parse(require('fs').readFileSync('apps/dashboard/src/i18n/locales/en.json','utf8')); console.log('ok')"`
Expected: prints `ok`.

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/i18n/locales/en.json
git commit -m "feat(dashboard): i18n strings for api-key dialog + revoke"
```

---

### Task 7: `CreateApiKeyDialog` component

**Files:**
- Create: `apps/dashboard/src/components/sdk-api/create-api-key-dialog.tsx`
- Modify: `apps/dashboard/src/components/sdk-api/index.ts` (export it)

**Interfaces:**
- Consumes: `useCreateApiKey` (Task 5), HeroUI `Modal*` family, `Input` from `../../ui/input`, `CopyButton` from `../../ui/copy-button`, i18n keys (Task 6).
- Produces: `<CreateApiKeyDialog projectId: string; open: boolean; onClose: () => void />`.

- [ ] **Step 1: Implement the dialog**

Create `apps/dashboard/src/components/sdk-api/create-api-key-dialog.tsx`:

```tsx
import { useId, useState } from "react";
import {
  Button,
  Modal,
  ModalBackdrop,
  ModalBody,
  ModalContainer,
  ModalDialog,
  ModalFooter,
  ModalHeader,
  ModalHeading,
  ModalIcon,
} from "@heroui/react";
import { useTranslation } from "react-i18next";
import { AlertTriangle, KeyRound } from "lucide-react";
import type { CreateApiKeyResponse } from "@rovenue/shared";
import { Input } from "../../ui/input";
import { CopyButton } from "../../ui/copy-button";
import { useCreateApiKey } from "../../lib/hooks/useCreateApiKey";

interface Props {
  projectId: string;
  open: boolean;
  onClose: () => void;
}

export function CreateApiKeyDialog({ projectId, open, onClose }: Props) {
  const { t } = useTranslation();
  const labelId = useId();
  const [label, setLabel] = useState("");
  const [created, setCreated] = useState<CreateApiKeyResponse | null>(null);
  const { mutate, isPending, error, reset } = useCreateApiKey(projectId);

  const canSubmit = label.trim().length > 0 && !isPending;

  function close() {
    setLabel("");
    setCreated(null);
    reset();
    onClose();
  }

  function handleCreate() {
    if (!canSubmit) return;
    mutate(
      { label: label.trim() },
      { onSuccess: (res) => setCreated(res) },
    );
  }

  return (
    <Modal
      isOpen={open}
      onOpenChange={(next) => {
        if (!next && !isPending) close();
      }}
    >
      <ModalBackdrop variant="blur" isDismissable={!isPending}>
        <ModalContainer size="sm" placement="center">
          <ModalDialog>
            <ModalHeader className="items-center gap-3">
              <ModalIcon className="bg-primary-100 text-primary-500">
                {created ? <AlertTriangle size={18} /> : <KeyRound size={18} />}
              </ModalIcon>
              <ModalHeading>
                {created
                  ? t("sdkApi.keys.dialog.createdTitle")
                  : t("sdkApi.keys.dialog.title")}
              </ModalHeading>
            </ModalHeader>

            {created ? (
              <>
                <ModalBody className="gap-3">
                  <div className="rounded-md border border-warning-200 bg-warning-50 px-3 py-2 text-sm text-warning-700">
                    {t("sdkApi.keys.dialog.secretWarning")}
                  </div>
                  <SecretReveal
                    label={t("sdkApi.keys.dialog.publishableLabel")}
                    value={created.apiKey.publicKey}
                    copyLabel={t("sdkApi.copy.idle")}
                    copiedLabel={t("sdkApi.copy.copied")}
                  />
                  <SecretReveal
                    label={t("sdkApi.keys.dialog.secretLabel")}
                    value={created.secretKey}
                    copyLabel={t("sdkApi.copy.idle")}
                    copiedLabel={t("sdkApi.copy.copied")}
                  />
                </ModalBody>
                <ModalFooter>
                  <Button variant="solid" color="primary" onPress={close}>
                    {t("sdkApi.keys.dialog.done")}
                  </Button>
                </ModalFooter>
              </>
            ) : (
              <>
                <ModalBody className="gap-3">
                  <div>
                    <label
                      htmlFor={labelId}
                      className="mb-2 block text-[11px] font-medium uppercase tracking-wider text-default-500"
                    >
                      {t("sdkApi.keys.dialog.labelField")}
                    </label>
                    <Input
                      id={labelId}
                      value={label}
                      onChange={(e) => setLabel(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handleCreate();
                      }}
                      placeholder={t("sdkApi.keys.dialog.labelPlaceholder")}
                      autoComplete="off"
                      autoFocus
                      maxLength={60}
                    />
                  </div>
                  {error && (
                    <div
                      role="alert"
                      className="rounded-md border border-danger-200 bg-danger-50 px-3 py-2 text-sm text-danger-600"
                    >
                      {error.message}
                    </div>
                  )}
                </ModalBody>
                <ModalFooter>
                  <Button variant="ghost" onPress={close} isDisabled={isPending}>
                    {t("common.cancel")}
                  </Button>
                  <Button
                    variant="solid"
                    color="primary"
                    isPending={isPending}
                    isDisabled={!canSubmit}
                    onPress={handleCreate}
                  >
                    {t("sdkApi.keys.dialog.create")}
                  </Button>
                </ModalFooter>
              </>
            )}
          </ModalDialog>
        </ModalContainer>
      </ModalBackdrop>
    </Modal>
  );
}

function SecretReveal({
  label,
  value,
  copyLabel,
  copiedLabel,
}: {
  label: string;
  value: string;
  copyLabel: string;
  copiedLabel: string;
}) {
  return (
    <div>
      <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-default-500">
        {label}
      </div>
      <div className="flex items-center gap-2">
        <code className="block min-w-0 flex-1 truncate rounded border border-default-200 bg-default-100 px-2 py-1.5 font-mono text-[11.5px]">
          {value}
        </code>
        <CopyButton size="sm" value={value} label={copyLabel} copiedLabel={copiedLabel} />
      </div>
    </div>
  );
}
```

> Before implementing, open `DeleteProjectDialog.tsx` and confirm the exact `@heroui/react` `Button` props (`variant`/`color`/`onPress`/`isPending`/`isDisabled`) and the `Modal*` import names — mirror them exactly. If `Button` there uses `variant="danger"` rather than `color`, follow that codebase convention instead of the `color="primary"` shown here.

- [ ] **Step 2: Export from the barrel**

In `apps/dashboard/src/components/sdk-api/index.ts`, add:

```ts
export { CreateApiKeyDialog } from "./create-api-key-dialog";
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/components/sdk-api/create-api-key-dialog.tsx apps/dashboard/src/components/sdk-api/index.ts
git commit -m "feat(dashboard): add CreateApiKeyDialog with one-time secret reveal"
```

---

### Task 8: Wire the three buttons + revoke into the SDK page

**Files:**
- Modify: `apps/dashboard/src/routes/_authed/projects/$projectId/settings/sdk.tsx`
- Modify: `apps/dashboard/src/components/sdk-api/sdk-hero.tsx`
- Modify: `apps/dashboard/src/components/sdk-api/keys-card.tsx`

**Interfaces:**
- Consumes: `CreateApiKeyDialog` (Task 7), `useRevokeApiKey` (Task 5), `ConfirmDialog` from `../../ui/confirm-dialog`, i18n keys (Task 6).
- Produces: `SdkHero` gains `onCreateKey?: () => void`; `KeysCard` gains `projectId: string` and `onCreateKey?: () => void`.

- [ ] **Step 1: Add `onCreateKey` to `SdkHero`**

In `apps/dashboard/src/components/sdk-api/sdk-hero.tsx`, change the props type and the generate button:

```tsx
type Props = {
  stats: SdkHeroStats;
  onCreateKey?: () => void;
};

export function SdkHero({ stats, onCreateKey }: Props) {
```

and on the generate-key `Button` (the one rendering `sdkApi.hero.actions.generateKey`) add `onClick={onCreateKey}`:

```tsx
          <Button variant="solid-primary" size="sm" onClick={onCreateKey}>
            <KeyRound size={13} />
            {t("sdkApi.hero.actions.generateKey")}
          </Button>
```

- [ ] **Step 2: Add create + revoke to `KeysCard`**

In `apps/dashboard/src/components/sdk-api/keys-card.tsx`, update the imports and props, wire the "New key" button, and add a per-row revoke with a confirm dialog. Replace the file's `Props` interface, component signature, the header create button, and the row rendering as follows:

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Trash2 } from "lucide-react";
import type { ProjectApiKey } from "@rovenue/shared";
import { Button } from "../../ui/button";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { SecretRow } from "./secret-row";
import { useRevokeApiKey } from "../../lib/hooks/useRevokeApiKey";

interface Props {
  projectId: string;
  apiKeys: ReadonlyArray<ProjectApiKey>;
  onCreateKey?: () => void;
}
```

Change the component signature to `export function KeysCard({ projectId, apiKeys, onCreateKey }: Props) {`, then inside it add:

```tsx
  const revoke = useRevokeApiKey(projectId);
  const [confirmId, setConfirmId] = useState<string | null>(null);
```

Wire the header create button:

```tsx
        <Button variant="solid-primary" size="sm" onClick={onCreateKey}>
          <Plus size={13} />
          {t("sdkApi.keys.actions.create")}
        </Button>
```

Wrap each `SecretRow` so a revoke button sits beside it. Replace the `apiKeys.map(...)` block with:

```tsx
        {apiKeys.map((key) => (
          <div key={key.id} className="flex items-stretch gap-2">
            <div className="min-w-0 flex-1">
              <SecretRow
                label={key.label}
                created={formatRelative(key.createdAt)}
                environment={t(
                  `sdkApi.keys.environments.${key.environment === "PRODUCTION" ? "production" : "sandbox"}`,
                )}
                kind="publishable"
                value={key.publicKey}
                preview={previewKey(key.publicKey)}
                readOnly
              />
            </div>
            <Button
              variant="light"
              size="sm"
              className="self-center text-rv-danger"
              onClick={() => setConfirmId(key.id)}
              aria-label={t("sdkApi.keys.actions.revoke")}
            >
              <Trash2 size={13} />
            </Button>
          </div>
        ))}
```

And before the closing `</section>`, render the confirm dialog:

```tsx
      <ConfirmDialog
        open={confirmId !== null}
        title={t("sdkApi.keys.revokeConfirm.title")}
        description={t("sdkApi.keys.revokeConfirm.body")}
        confirmLabel={t("sdkApi.keys.revokeConfirm.confirm")}
        tone="danger"
        onConfirm={async () => {
          if (confirmId) await revoke.mutateAsync(confirmId);
        }}
        onClose={() => setConfirmId(null)}
      />
```

> Confirm `ConfirmDialog` keeps the `confirmId` value referenced inside `onConfirm` — `setConfirmId(null)` runs in `onClose` which `ConfirmDialog` calls **after** a successful `onConfirm`, so the closure still sees the id during the mutation.

- [ ] **Step 3: Wire the page (`sdk.tsx`)**

In `apps/dashboard/src/routes/_authed/projects/$projectId/settings/sdk.tsx`:

Add imports:

```tsx
import { useState } from "react";
```

and add `CreateApiKeyDialog` to the existing `../../../../../components/sdk-api` import.

In `SdkPage`, add state and dialog, pass `onCreateKey` down, and give the header "Manage keys" button an `onClick`:

```tsx
function SdkPage({ project }: { project: ProjectDetail }) {
  const { t } = useTranslation();
  const [createOpen, setCreateOpen] = useState(false);
  const openCreate = () => setCreateOpen(true);

  return (
    <>
      {/* header unchanged except the Manage keys button: */}
      {/* <Button variant="flat" size="sm" onClick={openCreate}> ... Manage keys ... </Button> */}

      <SdkHero stats={HERO_STATS} onCreateKey={openCreate} />
      <QuickstartCard />
      <KeysCard projectId={project.id} apiKeys={project.apiKeys} onCreateKey={openCreate} />
      <SdkPackagesGrid />

      {/* ...existing grid unchanged... */}

      <CreateApiKeyDialog
        projectId={project.id}
        open={createOpen}
        onClose={() => setCreateOpen(false)}
      />
    </>
  );
}
```

Apply the `onClick={openCreate}` to the existing "Manage keys" `<Button>` in the header (the one rendering `sdkApi.actions.manageKeys`), and the `<KeysCard>` / `<SdkHero>` prop additions shown above. Leave all other markup intact.

- [ ] **Step 4: Typecheck the dashboard**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit`
Expected: PASS — no missing props, all three buttons now wired.

- [ ] **Step 5: Build the dashboard to confirm the bundle compiles**

Run: `pnpm --filter @rovenue/dashboard build`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/routes/_authed/projects/$projectId/settings/sdk.tsx apps/dashboard/src/components/sdk-api/sdk-hero.tsx apps/dashboard/src/components/sdk-api/keys-card.tsx
git commit -m "feat(dashboard): wire SDK key buttons + inline revoke to real API"
```

---

### Task 9: Manual verification

**Files:** none (verification only).

- [ ] **Step 1: Run the dev stack and exercise the flow**

Run: `pnpm dev` (Postgres/Redis/etc. via `docker compose up` if not already running).

Verify in the dashboard at Settings → SDK for a project where you are OWNER/ADMIN:
1. "New key", "Generate API key", and "Manage keys" each open the create dialog.
2. Creating a key shows the publishable + secret once with working Copy buttons; closing and reopening the keys list shows the new key (no secret).
3. The Revoke trash button opens the confirm dialog; confirming removes the row; the empty state appears when the last key is revoked.
4. As a DEVELOPER-role member, create/revoke return an error surfaced in the dialog/alert (403).

- [ ] **Step 2: Run the full API test suite for the touched route**

Run: `pnpm --filter @rovenue/api test -- api-keys.integration`
Expected: PASS (all create + revoke tests).

---

## Notes for the implementer

- Pre-existing red tests on `main` (half-built integrations framework, etc.) are unrelated — do not try to fix them; only the `api-keys.integration` suite is in scope.
- Stay on the current branch; do not create or switch branches.
- The `*.integration.test.ts` suites require a real Postgres (testcontainers / `docker compose`); if the DB is unavailable, the create/revoke tests cannot run — note that rather than weakening the assertions.
