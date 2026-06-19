# SDK Settings — Functional API-Key Management

**Date:** 2026-06-19
**Status:** Approved (design)
**Area:** `apps/dashboard` (Settings → SDK), `apps/api` (dashboard projects router), `packages/db`, `packages/shared`

## Problem

On the Settings → SDK page (`/_authed/projects/$projectId/settings/sdk`) three buttons are
inert placeholders, and there is no way to manage API keys after a project is created:

1. **"Manage keys"** — page header button (`sdk.tsx`), no `onClick`.
2. **"Generate API key"** — hero button (`sdk-hero.tsx`), no `onClick`.
3. **"New key"** — keys card button (`keys-card.tsx`), no `onClick`.

The keys *list* already renders real data from `project.apiKeys`, but the backend exposes **no
route to create or revoke a key** — keys are only minted once, atomically, during project
creation. The result: the UI shows real keys but offers no way to add or remove them.

## Scope (confirmed with user)

- **Mock data:** API-keys section only. The rest of the SDK page (hero telemetry stats, SDK
  package cards, REST endpoint catalog, webhook delivery samples in `mock-data.ts`) is left
  untouched — it is acceptable static/demo content for now.
- **Key actions:** Create + Revoke. No rotate.
- **Create options:** Label only. Each create mints a **Production** publishable + secret pair
  (same as project-create), the user only supplies a label.
- **Permission:** ADMIN and OWNER may create/revoke (`assertProjectAccess(..., MemberRole.ADMIN)`).
- **Three buttons:** All three open the same Create Key dialog. Revoke is an inline per-row
  action in the keys card.

## Out of scope

- Rotating keys in place; the unused `RotateCw` button in `secret-row.tsx` stays as-is.
- Sandbox-environment keys, choosing key type (publishable-only vs secret), per-key scopes.
- Replacing hero stats / package versions / endpoint catalog / webhook deliveries with live data.

## Backend

### Repository — `packages/db/src/drizzle/repositories/api-keys.ts`

Add a revoke writer:

```ts
export async function revokeApiKey(
  db: Db,
  projectId: string,
  keyId: string,
): Promise<ActiveApiKeyRow | null>;
```

- `UPDATE api_keys SET revokedAt = now() WHERE id = :keyId AND projectId = :projectId AND revokedAt IS NULL RETURNING ...`
- Scoping on **both** `id` and `projectId` prevents revoking another project's key via a guessed id.
- Returns the row (id/label/keyPublic/environment/createdAt) or `null` when nothing matched
  (already revoked or wrong project) → caller maps to 404.

Export it from the repo barrel so it is reachable as `drizzle.apiKeyRepo.revokeApiKey`.

### Routes — `apps/api/src/routes/dashboard/projects.ts`

Append two handlers to the existing chained router (keeps `AppType` inference intact). Reuse the
existing module-level helpers `newApiKeyId()`, `urlSafeRandom()`, `API_KEY_PREFIX`, `API_KEY_KIND`,
`BCRYPT_ROUNDS`, `Environment.PRODUCTION`.

**`POST /dashboard/projects/:id/api-keys`**

- Zod body: `{ label: string }` — `z.string().trim().min(1).max(60)`.
- `await assertProjectAccess(id, user.id, MemberRole.ADMIN);`
- Inside one `drizzle.db.transaction`:
  - `apiKeyId = newApiKeyId()`, `keyPublic = ${API_KEY_PREFIX[PUBLIC]}${urlSafeRandom(24)}`.
  - `secretPlaintext = ${API_KEY_PREFIX[SECRET]}${apiKeyId}_${urlSafeRandom(32)}`, bcrypt-hash it.
  - `drizzle.apiKeyRepo.createApiKey(tx, { id, projectId: id, label, keyPublic, keySecretHash, environment: PRODUCTION })`.
  - `audit({ projectId: id, userId: user.id, action: "api_key.created", resource: "api_key", resourceId: apiKeyId, after: { id: apiKeyId, label, publicKey: keyPublic, environment: PRODUCTION }, ...extractRequestContext(c) }, tx)`. The payload carries only the **publishable** identifier — never the secret — so the `resource: "credential"` redaction guard does not apply (`api_key.created` / `api_key.revoked` are the dedicated audit actions that already exist in `AuditAction`).
- Respond `c.json(ok(payload))` where `payload: CreateApiKeyResponse = { apiKey: { id, label, publicKey: keyPublic, environment, createdAt }, secretKey: secretPlaintext }`.
- Secret returned **exactly once**; never persisted except as the bcrypt hash.

**`DELETE /dashboard/projects/:id/api-keys/:keyId`**

- `await assertProjectAccess(id, user.id, MemberRole.ADMIN);`
- Transaction: `const revoked = await drizzle.apiKeyRepo.revokeApiKey(tx, id, keyId);`
  - if `!revoked` → `throw new HTTPException(404, { message: "API key not found" })`.
  - `audit({ projectId: id, userId: user.id, action: "api_key.revoked", resource: "api_key", resourceId: keyId, before: { id: revoked.id, label: revoked.label, publicKey: revoked.keyPublic }, ...extractRequestContext(c) }, tx)`.
- Respond `c.json(ok({ id: keyId }))`.

> Note on the last key: revoking the final active key is allowed. The keys card already handles the
> empty state. (We do not block it; SDK auth simply has no live key until a new one is created.)

### Shared types — `packages/shared/src/dashboard.ts`

```ts
export interface CreateApiKeyRequest {
  label: string;
}

export interface CreateApiKeyResponse {
  apiKey: ProjectApiKey;
  secretKey: string; // plaintext — shown once, only in this response
}
```

Export both from the package barrel.

## Frontend — `apps/dashboard`

### Mutation hooks — `src/lib/hooks/`

Mirror `useRotateWebhookSecret` (uses the `api()` helper + invalidates `["project", projectId]`).

```ts
// useCreateApiKey.ts
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

// useRevokeApiKey.ts
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

The `api()` helper auto-sets `content-type: application/json` whenever a body is present and always
sends `credentials: "include"`, so the hooks just pass `body: JSON.stringify(...)`.

### Create dialog — `src/components/sdk-api/create-api-key-dialog.tsx`

Built on the HeroUI `Modal` family, same structure as `DeleteProjectDialog`.

- Controlled by an `open` prop + `onOpenChange`/`onClose` from the parent (`SdkPage`).
- **Form state:** label `Input` (autofocus). Submit disabled while empty or pending.
- On submit → `useCreateApiKey`. On success, swap the body to a **one-time reveal panel**:
  - The publishable key and the secret key, each in a mono `code` block with `CopyButton`.
  - A prominent warning: the secret is shown only once and cannot be retrieved again.
  - Footer button becomes "Done" → `onClose`.
- Closing resets all local state (label, created result, error) and calls `mutation.reset()`.
- Surfaces `error.message` in an alert box (same pattern as `DeleteProjectDialog`).

### Wiring — `src/routes/_authed/projects/$projectId/settings/sdk.tsx`

- Lift `const [createOpen, setCreateOpen] = useState(false)` into `SdkPage`.
- Render `<CreateApiKeyDialog projectId={project.id} open={createOpen} onClose={() => setCreateOpen(false)} />`.
- Pass `onCreateKey={() => setCreateOpen(true)}` down to:
  - the header "Manage keys" button (`onClick`),
  - `SdkHero` → its "Generate API key" button,
  - `KeysCard` → its "New key" button.
- `SdkHero` and `KeysCard` gain an optional `onCreateKey?: () => void` prop wired to the relevant
  `Button`'s `onClick` (these use the local `../../ui/button`, which takes `onClick`).

### Revoke — `src/components/sdk-api/keys-card.tsx`

- `KeysCard` gains a `projectId: string` prop and owns `useRevokeApiKey(projectId)` internally
  (consistent with how feature cards own their own mutations).
- Each key row gets a **Revoke** action. Use the existing `ui/confirm-dialog.tsx` (`tone="danger"`)
  to confirm before calling `revoke.mutate(keyId)`. Manage one "pending confirm key id" in
  `KeysCard` state; the confirm dialog's `onConfirm` returns the mutation promise so it shows a busy
  state and stays open on error.
- The empty-state copy already exists (`sdkApi.keys.empty`).

### i18n — `src/i18n/locales/en.json` (and peer locales)

Add under `sdkApi.keys`:

- `actions.revoke` — "Revoke"
- `dialog.title` — "New API key"
- `dialog.labelField` — "Key name"
- `dialog.labelPlaceholder` — e.g. "Production backend"
- `dialog.create` — "Create key"
- `dialog.createdTitle` — "Key created"
- `dialog.secretWarning` — "Copy your secret key now. For security it won't be shown again."
- `dialog.publishableLabel` / `dialog.secretLabel`
- `dialog.done` — "Done"
- `revokeConfirm.title` / `revokeConfirm.body` / `revokeConfirm.confirm`

Reuse `sdkApi.keys.actions.create` ("New key") and `sdkApi.hero.actions.generateKey`
("Generate API key") for the trigger buttons.

## Data flow

```
[New key / Generate / Manage keys button] → setCreateOpen(true)
  → CreateApiKeyDialog (label) → POST /dashboard/projects/:id/api-keys
    → tx: createApiKey + audit(credential.created)
    → { apiKey, secretKey }  ── secret rendered once in dialog
    → invalidate ["project", id] → KeysCard re-renders with the new key

[Revoke on a key row] → ConfirmDialog → DELETE /dashboard/projects/:id/api-keys/:keyId
  → tx: revokeApiKey + audit(credential.deleted)
  → invalidate ["project", id] → row disappears
```

## Error handling

- Backend: `assertProjectAccess` throws 403 for insufficient role / non-membership; Zod 400 on bad
  label; 404 when revoke matches no active key. All mutations are wrapped in a transaction so the
  audit row is an atomic side-effect of the write.
- Frontend: hooks surface `ApiError.message`; the create dialog shows it inline and stays open; the
  revoke confirm dialog keeps open on rejection (its `onConfirm` returns the mutation promise).

## Testing

- **API integration** (`projects.integration.test.ts` or a sibling): create-key returns a usable
  pair and the secret authenticates against `/v1` (bcrypt round-trips); revoke makes the key 404 on
  the next `/v1` auth; ADMIN allowed / VIEWER (or non-member) gets 403; revoking a foreign project's
  key id 404s; revoke is idempotent-safe (second revoke 404s). Assert an audit row is written for
  both actions.
- **Repo unit:** `revokeApiKey` only affects the targeted row and respects `projectId` scoping +
  `revokedAt IS NULL`.
- **Frontend:** dialog reveals the secret once and resets on close; "New key", "Generate API key",
  and "Manage keys" all open the dialog; revoke flows through the confirm dialog and invalidates the
  project query.

## Files

**New**
- `apps/dashboard/src/components/sdk-api/create-api-key-dialog.tsx`
- `apps/dashboard/src/lib/hooks/useCreateApiKey.ts`
- `apps/dashboard/src/lib/hooks/useRevokeApiKey.ts`

**Modified**
- `packages/db/src/drizzle/repositories/api-keys.ts` (+ barrel) — `revokeApiKey`
- `apps/api/src/routes/dashboard/projects.ts` — POST + DELETE handlers
- `packages/shared/src/dashboard.ts` (+ barrel) — `CreateApiKeyRequest`, `CreateApiKeyResponse`
- `apps/dashboard/src/components/sdk-api/{index.ts,keys-card.tsx,sdk-hero.tsx}` — `onCreateKey`/revoke wiring
- `apps/dashboard/src/routes/_authed/projects/$projectId/settings/sdk.tsx` — dialog state + props
- `apps/dashboard/src/i18n/locales/*.json` — new keys
