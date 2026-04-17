# Dashboard Phase 1 — Auth, Projects, Subscribers

**Status:** Draft
**Date:** 2026-04-18
**Scope:** Stand up the dashboard from the empty Vite scaffold through the first shippable surface area: OAuth login/signup, project CRUD, and a subscriber list + detail view.

---

## 1. Context

`apps/dashboard` today is a bare Vite + React project with a single `<h1>Rovenue Dashboard</h1>` component. No router, state layer, component kit, auth, or tests. Every downstream feature we built in the API (audiences, experiments, feature flags, audit logs, DLQ webhooks, health monitoring, subscriber transfer) has no UI yet.

This spec covers the foundation plus the two most load-bearing surfaces:

- **Authentication** — Better Auth (GitHub + Google OAuth, no email/password) already runs at `/api/auth/*` on the API. The dashboard needs to integrate the Better Auth React client, gate routes by session, and redirect through the OAuth flow.
- **Projects** — users need to create projects, switch between them, and manage basic settings (name, webhook URL, rotate webhook secret, delete). All downstream features are project-scoped, so without this there is no path to any other surface.
- **Subscribers** — the most-requested read surface: a searchable, paginated list of subscribers per project plus a detail pane showing purchases, access, credit balance, experiment assignments, and recent outgoing webhooks.

Out of scope for this phase: charts/analytics, audience/experiment/flag UI, audit log viewer, failed webhook management UI, health status dashboard, subscriber transfer UI, i18n. Each of these is its own phase.

---

## 2. Architecture

Two tracks delivered in order:

1. **Backend** — add the missing dashboard endpoints that Phase 1 needs. Ship as its own PR so the frontend can consume stable, typed routes instead of mocks.
2. **Frontend** — scaffold the dashboard (router, auth gate, data layer, layout, theme) and implement the two feature surfaces on top.

**Why backend-first.** Parallelising frontend against a mock API drifts: shape mismatches, missing fields, incorrect error envelopes. With the backend settled and typed request/response schemas published in `@rovenue/shared`, the frontend hooks compile against real types and integration is tight.

**Commit granularity.**

- Backend PR: one commit per route family (projects, subscribers) plus one for the wire-up.
- Frontend PR: separate commits for (a) scaffold (deps, tailwind v4, hero ui provider, router, query client, auth client), (b) layout shell + auth gate, (c) projects surface, (d) subscribers surface, (e) tests.

---

## 3. Backend — Missing Endpoints

All endpoints live under `/dashboard` behind `requireDashboardAuth` (Better Auth session) and `assertProjectAccess(projectId, userId, role)`. Every mutation writes an awaited `audit({...})` entry. Responses follow the existing `{ data }` / `{ error: { code, message } }` envelope.

### 3.1 `apps/api/src/routes/dashboard/projects.ts` (new)

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/dashboard/projects` | — (auth only) | List the caller's projects via `ProjectMember`. Each row includes the user's role. Response: `{ projects: Array<{ id, name, role, createdAt }> }`. |
| POST | `/dashboard/projects` | — (auth only) | Create project + `ProjectMember(OWNER)` + default "All Users" audience + one public API key + one secret API key, inside a single `$transaction`. Returns the project + the plaintext API keys (shown once). |
| GET | `/dashboard/projects/:id` | VIEWER | Detail including counts (subscribers, experiments, flags, active api keys), webhook URL, and API key metadata (prefix + createdAt, never plaintext). |
| PATCH | `/dashboard/projects/:id` | ADMIN | Update `name`, `webhookUrl`, `settings` (Json). `webhookSecret` has its own endpoint. |
| POST | `/dashboard/projects/:id/webhook-secret/rotate` | OWNER | Generate a new secret, persist, audit `{ rotated: true }` (redacted). Returns the new secret once. |
| DELETE | `/dashboard/projects/:id` | OWNER | Hard delete. Prisma cascades handle related rows. Audit record is written before the delete inside a transaction. |

**Zod input schemas** live alongside the route file. Pagination, sorting, and filtering are not needed on the project list because each user typically has a handful.

### 3.2 `apps/api/src/routes/dashboard/subscribers.ts` (new)

| Method | Path | Role | Description |
|---|---|---|---|
| GET | `/dashboard/projects/:projectId/subscribers` | VIEWER | Cursor-paginated list. Query params: `?cursor=` (opaque base64 of `{createdAt, id}`), `?limit=` (1–100, default 50), `?q=` (search over `appUserId` ILIKE + `attributes::text` ILIKE). Filters out `deletedAt IS NOT NULL`. Sort: `createdAt DESC, id DESC`. Response: `{ subscribers, nextCursor }`. |
| GET | `/dashboard/projects/:projectId/subscribers/:id` | VIEWER | Full detail fetched via `Promise.all`: subscriber row, last 50 purchases (joined with product + revenueEvents), active `SubscriberAccess`, credit balance + last 20 `CreditLedger` entries, `ExperimentAssignment` list (with variant + convertedAt), last 20 `OutgoingWebhook`. Merged into one response. |

### 3.3 Wire-up

- `apps/api/src/routes/dashboard/index.ts` mounts `projectsRoute` and `subscribersRoute`.
- `assertProjectAccess` already accepts `minimumRole` — every mutation passes `MemberRole.ADMIN` or `MemberRole.OWNER` as appropriate.
- Cursor pagination helper goes in `apps/api/src/lib/pagination.ts` (new; 2–3 exported functions: `encodeCursor`, `decodeCursor`, `buildWhereClause`) so the later analytics + audit-log list surfaces can reuse it.

### 3.4 Testing

- `apps/api/tests/dashboard-projects.test.ts` — happy path on every verb; forbidden (non-member) returns 403; VIEWER cannot mutate; POST creates default audience + both API keys atomically.
- `apps/api/tests/dashboard-subscribers.test.ts` — cursor round-trip; ILIKE search; forbidden cross-project; soft-deleted subscribers are excluded; detail payload shape.

Uses the existing `vi.mock('@rovenue/db', ...)` + `vi.hoisted` pattern from `tests/dashboard-routes.test.ts`.

---

## 4. Frontend — Stack

Every choice is locked:

| Concern | Pick | Version |
|---|---|---|
| Build | Vite | `^5.1` (existing) |
| UI runtime | React | `^19.0` (upgrade from 18) |
| Router | `@tanstack/react-router` | latest |
| Server state | `@tanstack/react-query` | latest |
| Tables | `@tanstack/react-table` | latest |
| Components | `@heroui/react` | `^3.0.3` |
| Styling | `tailwindcss` + `@tailwindcss/vite` | `^4.0` |
| Auth | `better-auth` (react client) | matches API workspace |
| Theming | `next-themes` | `^0.4` |
| Test | `vitest` + `@testing-library/react` + `msw` | Vitest `^1.x`, MSW `^2.x` |

**React 19 + Tailwind 4** are both required by Hero UI 3.x. The React 19 upgrade also aligns the dashboard with `packages/sdk-rn` which already expects React 19 (this resolves the pnpm peer warnings reported at install time). Tailwind 4 moves to a CSS-first config — no `tailwind.config.js` required; `@import "tailwindcss"` + `@theme` block in `src/index.css`.

---

## 5. Frontend — File Layout

```
apps/dashboard/src/
├── main.tsx                    # providers: QueryClient, Router, HeroUI, ThemeProvider
├── router.tsx                  # router tree registry (TanStack Router file-based)
│
├── routes/                     # file-based routing
│   ├── __root.tsx              # outer shell
│   ├── index.tsx               # / → redirect to /projects or /login
│   ├── login.tsx               # public — OAuth buttons
│   ├── _authed.tsx             # auth gate layout
│   ├── _authed/
│   │   ├── projects.tsx              # /projects — list + "new"
│   │   ├── projects.new.tsx          # /projects/new — create form
│   │   └── projects.$projectId/
│   │       ├── route.tsx             # project layout: topnav, project switcher, sidenav
│   │       ├── index.tsx             # /projects/:projectId — overview
│   │       ├── settings.tsx          # /projects/:projectId/settings
│   │       └── subscribers/
│   │           ├── index.tsx         # list
│   │           └── $id.tsx           # detail
│
├── components/
│   ├── layout/                 # TopNav, ProjectSwitcher, SideNav
│   ├── auth/                   # OAuthButton
│   ├── projects/               # ProjectCard, CreateProjectForm, SettingsForm, RotateSecretDialog, DeleteProjectDialog
│   └── subscribers/            # SubscribersTable, SubscriberDetailPanel, AccessTable, PurchasesTable, CreditLedgerTable, AssignmentsList
│
├── lib/
│   ├── api.ts                  # typed fetch wrapper, credentials:'include', envelope unwrap, ApiError
│   ├── auth.ts                 # createAuthClient({ baseURL: VITE_API_URL }) + useSession
│   ├── queryClient.ts          # QueryClient defaults
│   └── hooks/
│       ├── useProjects.ts
│       ├── useProject.ts
│       ├── useCreateProject.ts
│       ├── useUpdateProject.ts
│       ├── useRotateWebhookSecret.ts
│       ├── useDeleteProject.ts
│       ├── useSubscribers.ts   # useInfiniteQuery, cursor-based
│       └── useSubscriber.ts
│
├── index.css                   # @import "tailwindcss" + @theme
└── tests/                      # per-route smoke + critical flows
```

Each file stays focused on one responsibility. `components/*/` directories can grow, but routes are entry points only — any non-trivial logic lives in a hook or a component.

---

## 6. Data Layer

`lib/api.ts` exports a single `api<TResponse>(path, init?)`:

- Base URL from `import.meta.env.VITE_API_URL`.
- `credentials: 'include'` on every request (Better Auth cookies).
- `Content-Type: application/json` on non-GET when `init.body` exists.
- Unwraps `{ data }` → `TResponse`. On `{ error: { code, message } }` throws `ApiError(code, message, httpStatus)`.
- 401 short-circuits to `authClient.signOut()` + redirect to `/login` (a centralised interceptor, not per-hook).

Request/response types live in `@rovenue/shared`. The backend's Zod schemas already represent the canonical shapes; we export inferred types from there so one edit to a schema ripples to both sides.

`QueryClient` defaults:
- `staleTime: 30_000`
- `gcTime: 5 * 60_000`
- `retry: (count, err) => !(err instanceof ApiError && err.status === 401) && count < 2`
- `refetchOnWindowFocus: false` initially; re-enable per-query where useful.

Mutations invalidate via `queryClient.invalidateQueries({ queryKey })` — conventional keys: `['projects']`, `['project', id]`, `['subscribers', projectId, filters]`, `['subscriber', id]`.

---

## 7. Auth Flow

1. `/login` renders two Hero UI `Button` OAuth entries (GitHub, Google). Each calls `authClient.signIn.social({ provider, callbackURL: '/projects' })`.
2. Better Auth's `/api/auth/*` handler runs the OAuth dance and sets the session cookie.
3. `_authed.tsx` uses `beforeLoad`:
   ```ts
   beforeLoad: async () => {
     const session = await authClient.getSession();
     if (!session.data) throw redirect({ to: '/login' });
   },
   ```
4. Descendant routes access the session via `useSession()` from the auth client.
5. Logout: `authClient.signOut()` + `navigate({ to: '/login' })`.

Both OAuth buttons render unconditionally. Provider availability is controlled by API env vars (`GITHUB_CLIENT_*`, `GOOGLE_CLIENT_*`) — missing credentials surface as a Better Auth error on redirect, which the login page catches and renders in the error banner. A future `/api/auth/providers` enumerator can hide unavailable buttons, but that is not worth the round-trip in Phase 1.

---

## 8. Project Tenancy

URL-scoped: `/projects/:projectId/...`.

- `projects.$projectId/route.tsx` has a `loader` that calls `useProject(projectId)`; a 404 triggers the default TanStack Router error boundary with "Project not found".
- The project object is placed in route context so every descendant reads it via `Route.useLoaderData()`.
- `<ProjectSwitcher>` in the top nav lists the user's memberships (`useProjects()`) and navigates on select.
- `localStorage.lastProjectId` is the soft redirect target from `/` — falls back to the first project in the list, or `/projects/new` when the user has none.

---

## 9. UI Surfaces

### 9.1 Login (`/login`)

One centred card. Title "Sign in to Rovenue". Two Hero UI `Button`s with GitHub and Google icons. Error banner above the buttons on OAuth failure (read from URL error query param that Better Auth emits).

### 9.2 Project list (`/projects`)

Grid of `<ProjectCard>` (name, role badge, createdAt) + a "Create project" CTA. Empty state: centred card with a prompt and a single CTA to `/projects/new`.

### 9.3 Project create (`/projects/new`)

Single-field form (name, min 2 / max 80 chars). On submit: show a success dialog with the two API keys (public + secret) and a "Copy" action. Copy dismissal navigates to `/projects/:id`.

### 9.4 Project overview (`/projects/:projectId`)

Four stat cards: subscriber count, purchases count (lifetime), active experiments, active feature flags — all read from `GET /dashboard/projects/:id` detail payload. Placeholder in Phase 1 since most counts are downstream features; render what the detail endpoint already provides.

### 9.5 Project settings (`/projects/:projectId/settings`)

Sections:
- **General** — name, webhookUrl (inline edit → PATCH)
- **Webhook secret** — masked, with "Rotate" button opening a confirmation dialog; success dialog exposes new secret once
- **Danger zone** — "Delete project" button opening a confirm-by-typing dialog; OWNER only (hide for ADMIN/VIEWER)

### 9.6 Subscribers list (`/projects/:projectId/subscribers`)

`@tanstack/react-table` with columns:

| appUserId | firstSeenAt | lastSeenAt | purchases count | active access (badges) | deletedAt? (hidden by default) |

- Search input (debounced 300 ms) feeding `?q=` to the API.
- `useInfiniteQuery` with cursor pagination, "Load more" sentinel using `IntersectionObserver`.
- Row click → `/projects/:projectId/subscribers/:id`.
- Initial page size 50; configurable per user via a Hero UI `Select`.

### 9.7 Subscriber detail (`/projects/:projectId/subscribers/:id`)

Header: appUserId, attributes (JSON viewer, collapsible), timestamps.

Four sections underneath, each a Hero UI `Card`:

1. **Access** — `AccessTable` (entitlementKey, expiresAt, store)
2. **Purchases** — `PurchasesTable` (last 50, each row with product, store, amount, status, linked revenueEvents count)
3. **Credits** — current balance + `CreditLedgerTable` (last 20 entries)
4. **Experiments** — assignments list (experiment key, variant, convertedAt)

No mutations in Phase 1 — this is a read surface.

---

## 10. Testing

- **Unit / smoke** — Every route file has a test that renders under `<MemoryRouter>` + MSW handlers, asserts the visible content reflects the mocked API.
- **Forms** — `projects.new` happy + validation (empty name); `settings` happy + webhook URL validation.
- **Critical flows** — login redirect to `/projects`; unauthenticated access to an `_authed` route redirects to `/login`; project switcher updates the route; subscribers search triggers a new query; infinite scroll loads the next page.
- **MSW** — handlers in `tests/msw/handlers.ts` covering every Phase 1 endpoint. One fixture file per resource.

No Playwright / e2e in Phase 1 — MSW-backed integration tests cover the highest-risk paths; e2e is a later investment.

---

## 11. Non-Goals

- Charts / analytics (Phase 2)
- Audience / Experiment / Feature Flag UI (Phase 2)
- Audit log viewer (Phase 2)
- Failed webhook management UI (Phase 2)
- Health status dashboard (Phase 2)
- Subscriber transfer UI (Phase 2)
- Multi-language support (Phase 3+)
- Custom branding / theme per project (Phase 3+)

---

## 12. Deliverables Summary

**Backend PR** (`feat(api): dashboard projects + subscribers endpoints`)
- 2 new route files + 1 pagination helper
- 2 new test files
- `dashboard/index.ts` wire-up
- `@rovenue/shared` exports for request/response types

**Frontend PR** (`feat(dashboard): phase 1 — auth, projects, subscribers`)
- Dependency upgrade: React 19, Hero UI 3, Tailwind 4, TanStack Router/Query/Table, Better Auth client, next-themes, MSW
- Vite config: `@tailwindcss/vite`, routing
- Layout shell, auth gate, data layer
- Projects + Subscribers surfaces
- Test suite with MSW handlers

**Acceptance criteria**
- `pnpm --filter @rovenue/api test` green
- `pnpm --filter @rovenue/dashboard test` green
- `pnpm --filter @rovenue/dashboard build` produces a production bundle without type errors
- Manual smoke against a local stack: sign in with GitHub, create a project, add a subscriber via the public SDK API, see it in the dashboard list and detail views.
