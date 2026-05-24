# Skip the Projects-List Landing Page

Date: 2026-05-25
Status: Approved (verbal — 2026-05-25)
Scope: `apps/dashboard`

## Problem

After login, an authenticated dashboard user without a `lastProjectId` in
localStorage lands on `/projects` — a stand-alone list view of their projects
(see screenshot in chat: "Projects" header, project cards, "New project"
button). The list view duplicates what the persistent sidebar
`AppSwitcher` already shows once a project is selected, and forces a click
even when the user has exactly one project. It also flickers because
`/projects` mounts, calls `useProjects`, then auto-redirects to
`/projects/setup` when the list is empty.

The legacy `/projects/new` route is a second, competing project-creation
flow (a small form in a card with a key-reveal modal) that conflicts with
the canonical `ProjectSetupWizard` at `/projects/setup`.

## Goals

1. Authenticated user → land directly on a project's Overview if they have
   any project; otherwise on the setup wizard. No intermediate list.
2. A single project-creation surface: `/projects/setup`
   (`ProjectSetupWizard`).
3. The sidebar `AppSwitcher` exposes a "+ New project" affordance so a user
   with existing projects can still create more.
4. A user who opens the setup wizard but has existing projects can cancel
   back to their last project.

## Non-Goals

- Re-designing the `ProjectSetupWizard` itself.
- Changing the topbar `+ New` menu's existing entries (Product / Experiment
  / Feature flag / Webhook / API key). Project creation is intentionally
  *not* added there — the sidebar is the canonical surface.
- Server-side default-project selection. Tie-break stays client-side via
  `lastProjectId` in localStorage.

## Design

### 1. New landing logic in `routes/index.tsx`

The root route's `beforeLoad` becomes:

```ts
beforeLoad: async () => {
  const session = await getSession();
  if (!session.data) {
    throw redirect({ to: "/login", search: { error: undefined } });
  }

  // Prefetch projects so the redirect target is known synchronously.
  const projects = await queryClient.ensureQueryData({
    queryKey: ["projects"],
    queryFn: () =>
      unwrap<{ projects: ProjectSummary[] }>(rpc.dashboard.projects.$get()),
  }).then((r) => r.projects);

  if (projects.length === 0) {
    throw redirect({ to: "/projects/setup" });
  }

  const lastId =
    typeof localStorage !== "undefined"
      ? localStorage.getItem("lastProjectId")
      : null;
  const target =
    (lastId && projects.find((p) => p.id === lastId)?.id) ?? projects[0]!.id;

  if (target !== lastId) {
    try { localStorage.setItem("lastProjectId", target); } catch {}
  }

  throw redirect({
    to: "/projects/$projectId",
    params: { projectId: target },
  });
}
```

Notes:
- `queryClient.ensureQueryData` warms the same `["projects"]` cache the
  sidebar's `useProjects()` will read — no duplicate request.
- A stale `lastProjectId` pointing at a project the user no longer has
  access to silently falls back to the first project.
- The "first" project is whatever order the API returns. The API already
  orders by `created_at desc` for the user's memberships, so the most
  recently joined / created project wins, which matches user intent.

### 2. Routes & files to delete

- `apps/dashboard/src/routes/_authed/projects.index.tsx` — list view
- `apps/dashboard/src/routes/_authed/projects.new.tsx` — legacy creation
- `apps/dashboard/src/components/projects/ProjectCard.tsx` — sole user is
  the deleted list view
- `apps/dashboard/src/components/projects/CreateProjectForm.tsx` — sole
  user is the deleted `/projects/new`
- `apps/dashboard/src/components/layout/TopNav.tsx` — used only by the
  deleted screens (the setup wizard renders its own `SetupTopbar`; verify
  no other importers before deletion)
- `apps/dashboard/src/components/layout/ProjectSwitcher.tsx` — if no other
  importers remain; verify before deletion (the sidebar uses
  `AppSwitcher`, not this one)

The route tree (`routeTree.gen.ts`) regenerates from the surviving route
files; no manual edit needed there.

### 3. Sidebar `AppSwitcher` — "+ New project" affordance

In `components/dashboard/app-switcher.tsx`, append to the menu popup after
the project list:

```tsx
<div className="my-1 h-px bg-rv-divider" />
<Menu.Item
  onClick={() => void navigate({ to: "/projects/setup" })}
  className={ITEM_CLASS_NEW_PROJECT}
>
  <Plus size={13} />
  <span className="flex-1">{t("appSwitcher.newProject")}</span>
</Menu.Item>
```

Imports: `Plus` from `lucide-react`. New i18n key:
`appSwitcher.newProject` → "New project" / "Yeni proje".

### 4. `ProjectSetupWizard` — Cancel affordance (create mode)

The wizard already accepts a `mode` prop (`"create" | "update"`). In
`mode="create"`, if a `lastProjectId` exists in localStorage, render a
"Cancel" link/button in `SetupTopbar` (or equivalently in the wizard
header). Click → navigate to `/projects/$lastProjectId`.

If no `lastProjectId` (genuinely first-time user), the Cancel control is
hidden — the user must complete setup or sign out.

The check is read-only against localStorage; no new prop drilling is
required if `SetupTopbar` reads it directly. If `SetupTopbar` is generic,
we'll add an optional `onCancel?: () => void` prop and wire it from
`projects.setup.tsx`.

i18n: `setup.cancel` → "Cancel" / "İptal".

### 5. i18n keys

- **Remove:** `projects.list.*`, `projects.new.*` from `en.json` (and any
  other locale files present)
- **Add:** `appSwitcher.newProject`, `setup.cancel`

### 6. Cross-link cleanup

Grep-and-fix any remaining `to="/projects"` or `Link to="/projects"`
references. From the explored code, these live in:
- `components/layout/TopNav.tsx` — being deleted
- `routes/_authed/projects.setup.tsx` — already navigates to a project on
  success, not to `/projects`
- Possibly in i18n strings — none seen

No other production references expected; tests may import — fix or delete.

## Data Flow

```
/login → (Better Auth) → /

/  beforeLoad:
   ├─ no session       → /login
   ├─ projects = []    → /projects/setup
   ├─ lastProjectId in projects   → /projects/$lastProjectId
   └─ otherwise        → /projects/$(projects[0].id)
                         + set lastProjectId

Sidebar AppSwitcher (every project page):
   ├─ select existing  → /projects/$id  + update lastProjectId
   └─ "+ New project"  → /projects/setup

/projects/setup:
   ├─ submit success   → /projects/$newId + set lastProjectId
   └─ Cancel (only if lastProjectId exists)  → /projects/$lastProjectId
```

## Error Handling

- `ensureQueryData` failure in `/` beforeLoad: rethrow as a router error;
  the existing `__root.tsx` already renders generic auth/error UI — confirm
  there's at least a fallback. If not, add a tiny error-boundary
  componentin `__root.tsx` (out of scope if one already exists; in scope to
  verify).
- localStorage access guarded by `try`/`typeof` everywhere it's used
  (existing pattern in `AppSwitcher` / `index.tsx`).
- Race where the user is removed from a project between page loads: the
  `lastProjectId` fallback handles it. If `/projects/$projectId` itself
  returns 404, the project route's existing error path takes over (out of
  scope).

## Testing

Vitest unit/component tests (Testing Library):

1. **`/` redirect — empty projects**: mock `useProjects` → `[]`,
   `beforeLoad` redirects to `/projects/setup`.
2. **`/` redirect — projects with stored lastProjectId in list**:
   redirects to that project, leaves localStorage unchanged.
3. **`/` redirect — projects with stale lastProjectId**: falls back to
   first project, writes new `lastProjectId`.
4. **`/` redirect — projects with no lastProjectId**: lands on first
   project, writes `lastProjectId`.
5. **AppSwitcher "+ New project"**: renders the item and clicks navigate
   to `/projects/setup`.
6. **Setup wizard Cancel (with lastProjectId)**: Cancel control rendered;
   click → navigates to `/projects/$lastProjectId`.
7. **Setup wizard Cancel (no lastProjectId)**: Cancel control not
   rendered.

No new integration tests required (no API surface changes).

## Migration & Rollout

- Pure frontend change; no DB / API migration.
- Users with a valid `lastProjectId` in localStorage: behaviour unchanged
  (they were already redirected past `/projects`).
- Users without `lastProjectId` and at least one project: now skip the
  list and land directly on a project — strictly better UX.
- Users with zero projects: behaviour unchanged (already auto-redirected
  from list to setup, just without the flicker).
- Bookmarks to `/projects` or `/projects/new`: will 404 after deletion.
  Acceptable — neither URL is documented externally and both are
  authenticated dashboard URLs. If we want to be polite, add a one-line
  catch-all redirect from these paths to `/`. **Decision:** add the
  catch-all to soften the change for any in-flight bookmark.

## Open Questions

None as of approval. Implementation may surface small follow-ups (e.g.,
exact `SetupTopbar` API), which are local choices and don't change the
spec.
