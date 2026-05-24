# Skip the Projects-List Landing Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After login, the authenticated dashboard user lands directly on their last/first project (or on the setup wizard if they have none) — no intermediate projects-list page — and can create more projects from the sidebar AppSwitcher.

**Architecture:** Pure frontend change in `apps/dashboard`. The root route's `beforeLoad` does a `queryClient.ensureQueryData` of the projects list, then redirects synchronously. The legacy `/projects` and `/projects/new` route files become 2-line redirect-only routes (preserves bookmarks). A `+ New project` item is appended to the existing sidebar `AppSwitcher` menu. The setup wizard's topbar grows an optional `onCancel` prop, wired from `/projects/setup` to return to `lastProjectId` when one exists.

**Tech Stack:** React 18, TanStack Router (file-based, `createFileRoute`), TanStack Query, Vitest + jsdom + Testing Library, i18next, Hono RPC client.

**Spec:** `docs/superpowers/specs/2026-05-25-skip-projects-list-landing-design.md`

---

## File Map

**Modify:**
- `apps/dashboard/src/routes/index.tsx` — replace redirect logic (Task 4)
- `apps/dashboard/src/routes/_authed/projects.index.tsx` — become redirect-only (Task 5)
- `apps/dashboard/src/routes/_authed/projects.new.tsx` — become redirect-only (Task 5)
- `apps/dashboard/src/components/dashboard/app-switcher.tsx` — add `+ New project` menu item (Task 2)
- `apps/dashboard/src/components/project-setup/setup-topbar.tsx` — fix `/projects` links and add cancel-back (Task 3, Task 7)
- `apps/dashboard/src/components/project-setup/project-setup-wizard.tsx` — accept and forward `onCancel` (Task 3)
- `apps/dashboard/src/routes/_authed/projects.setup.tsx` — read `lastProjectId` and pass `onCancel` (Task 3)
- `apps/dashboard/src/components/projects/DeleteProjectDialog.tsx` — post-delete navigation (Task 7)
- `apps/dashboard/src/components/account/account-topbar.tsx` — logo link target (Task 7)
- `apps/dashboard/src/i18n/locales/en.json` — add/remove keys (Task 1, 3, 8)

**Delete (after verifying no consumers):**
- `apps/dashboard/src/components/layout/TopNav.tsx`
- `apps/dashboard/src/components/layout/ProjectSwitcher.tsx`
- `apps/dashboard/src/components/projects/ProjectCard.tsx`
- `apps/dashboard/src/components/projects/CreateProjectForm.tsx`

**Tests (create):**
- `apps/dashboard/tests/routes/index-redirect.test.tsx` — Task 4 tests
- `apps/dashboard/tests/components/app-switcher.test.tsx` — Task 2 tests
- `apps/dashboard/tests/components/setup-topbar-cancel.test.tsx` — Task 3 tests

---

## Pre-flight: Confirm test infrastructure

- [ ] **Step 0.1: Inspect the existing test setup**

Run:
```bash
cat apps/dashboard/tests/setup.ts
find apps/dashboard/tests -type f -name '*.test.*' | head -10
```

Expected: `tests/setup.ts` exists (referenced by `vitest.config.ts`). Note any helpers (Testing Library setup, i18n mock, router test wrapper). If a router test wrapper already exists, reuse it; if not, each test that needs routing will build a minimal in-memory router per the pattern in Task 4 step 3.

- [ ] **Step 0.2: Confirm test command**

Run:
```bash
pnpm --filter @rovenue/dashboard test --run -- --reporter=default tests/setup.ts 2>&1 | head -5
```
Expected: exits cleanly (or with "No test suite found" — both are fine; we just want to confirm vitest invocation works).

---

## Task 1: Add the `appSwitcher.newProject` i18n key

**Files:**
- Modify: `apps/dashboard/src/i18n/locales/en.json` (the `appSwitcher` block currently has keys `switchProject` and `projects`; add `newProject`)

This i18n key lands before its consumer so later tasks can import it.

- [ ] **Step 1: Add the key**

Edit the `appSwitcher` block (around line 385) to read:

```json
"appSwitcher": {
  "switchProject": "Switch project",
  "projects": "Projects",
  "newProject": "New project"
},
```

(Preserve the closing brace and any trailing comma — only `switchProject` / `projects` / `newProject` keys are required here. Use the file's existing formatting; if the order differs, append `newProject` last.)

- [ ] **Step 2: Lint-check JSON validity**

Run:
```bash
node -e "JSON.parse(require('fs').readFileSync('apps/dashboard/src/i18n/locales/en.json','utf8'))" && echo OK
```
Expected: `OK`

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/i18n/locales/en.json
git commit -m "i18n(dashboard): add appSwitcher.newProject key"
```

---

## Task 2: Add `+ New project` to AppSwitcher

**Files:**
- Modify: `apps/dashboard/src/components/dashboard/app-switcher.tsx`
- Test: `apps/dashboard/tests/components/app-switcher.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard/tests/components/app-switcher.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { I18nextProvider } from "react-i18next";
import i18next from "i18next";
import { AppSwitcher } from "../../src/components/dashboard/app-switcher";

const navigateSpy = vi.fn();
vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-router")>(
    "@tanstack/react-router",
  );
  return { ...actual, useNavigate: () => navigateSpy };
});

vi.mock("../../src/lib/hooks/useProjects", () => ({
  useProjects: () => ({
    data: [
      { id: "p1", name: "Alpha", slug: "alpha" },
      { id: "p2", name: "Beta", slug: "beta" },
    ],
  }),
}));

beforeEach(async () => {
  navigateSpy.mockReset();
  if (!i18next.isInitialized) {
    await i18next.init({
      lng: "en",
      resources: {
        en: {
          translation: {
            appSwitcher: {
              switchProject: "Switch project",
              projects: "Projects",
              newProject: "New project",
            },
            common: { current: "current" },
          },
        },
      },
    });
  }
});

function renderSwitcher() {
  const client = new QueryClient();
  return render(
    <I18nextProvider i18n={i18next}>
      <QueryClientProvider client={client}>
        <AppSwitcher projectId="p1" projectName="Alpha" />
      </QueryClientProvider>
    </I18nextProvider>,
  );
}

describe("AppSwitcher", () => {
  it("offers a + New project entry that navigates to /projects/setup", async () => {
    const user = userEvent.setup();
    renderSwitcher();
    await user.click(screen.getByTitle("Switch project"));
    const newItem = await screen.findByText("New project");
    await user.click(newItem);
    expect(navigateSpy).toHaveBeenCalledWith({ to: "/projects/setup" });
  });
});
```

- [ ] **Step 2: Run the test — expect FAIL**

Run:
```bash
pnpm --filter @rovenue/dashboard test --run tests/components/app-switcher.test.tsx
```
Expected: fails with "Unable to find an element with the text: New project" (the menu item does not exist yet).

- [ ] **Step 3: Implement the menu item**

Open `apps/dashboard/src/components/dashboard/app-switcher.tsx` and:

1. Change the lucide-react import line to add `Plus`:
   ```ts
   import { ChevronDown, Plus } from "lucide-react";
   ```

2. Inside `<Menu.Popup>`, immediately **after** the closing `)})` of the projects `.map(...)` block (and before `</Menu.Popup>`), insert:

   ```tsx
   <div className="my-1 h-px bg-rv-divider" />
   <Menu.Item
     onClick={() => void navigate({ to: "/projects/setup" })}
     className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[13px] text-rv-mute-700 outline-none data-[highlighted]:bg-rv-c4 data-[highlighted]:text-foreground"
   >
     <Plus size={13} className="text-rv-mute-500" />
     <span className="flex-1">{t("appSwitcher.newProject")}</span>
   </Menu.Item>
   ```

- [ ] **Step 4: Run the test — expect PASS**

Run:
```bash
pnpm --filter @rovenue/dashboard test --run tests/components/app-switcher.test.tsx
```
Expected: 1 passed.

- [ ] **Step 5: Type-check**

Run:
```bash
pnpm --filter @rovenue/dashboard typecheck
```
Expected: 0 errors.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/components/dashboard/app-switcher.tsx apps/dashboard/tests/components/app-switcher.test.tsx
git commit -m "feat(dashboard): + New project entry in AppSwitcher menu"
```

---

## Task 3: Add Cancel affordance to the setup wizard

**Files:**
- Modify: `apps/dashboard/src/components/project-setup/setup-topbar.tsx`
- Modify: `apps/dashboard/src/components/project-setup/project-setup-wizard.tsx`
- Modify: `apps/dashboard/src/routes/_authed/projects.setup.tsx`
- Modify: `apps/dashboard/src/i18n/locales/en.json`
- Test: `apps/dashboard/tests/components/setup-topbar-cancel.test.tsx`

- [ ] **Step 1: Add the `projectSetup.cancel` i18n key**

In `apps/dashboard/src/i18n/locales/en.json`, locate the `projectSetup` block and add a `cancel` key. If `projectSetup.close` already exists (it does — `"X"` aria label), put `cancel` next to it:

```json
"projectSetup": {
  ...existing keys...,
  "cancel": "Cancel"
},
```

Validate:
```bash
node -e "JSON.parse(require('fs').readFileSync('apps/dashboard/src/i18n/locales/en.json','utf8'))" && echo OK
```
Expected: `OK`.

- [ ] **Step 2: Write the failing component test**

Create `apps/dashboard/tests/components/setup-topbar-cancel.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { I18nextProvider } from "react-i18next";
import i18next from "i18next";
import { SetupTopbar } from "../../src/components/project-setup/setup-topbar";

vi.mock("@tanstack/react-router", async () => {
  const actual = await vi.importActual<typeof import("@tanstack/react-router")>(
    "@tanstack/react-router",
  );
  return {
    ...actual,
    Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  };
});

beforeEach(async () => {
  if (!i18next.isInitialized) {
    await i18next.init({
      lng: "en",
      resources: {
        en: {
          translation: {
            topNav: { appName: "Rovenue" },
            projectSetup: {
              crumb: { workspace: "Workspace", projects: "Projects", newProject: "New project" },
              close: "Close",
              cancel: "Cancel",
              mode: { create: "Create", update: "Update" },
            },
          },
        },
      },
    });
  }
});

describe("SetupTopbar Cancel affordance", () => {
  it("renders a Cancel control when onCancel is provided", async () => {
    const onCancel = vi.fn();
    render(
      <I18nextProvider i18n={i18next}>
        <SetupTopbar mode="create" projectName={null} onCancel={onCancel} />
      </I18nextProvider>,
    );
    const cancelBtn = screen.getByRole("button", { name: /cancel/i });
    await userEvent.setup().click(cancelBtn);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("hides the Cancel control when onCancel is omitted", () => {
    render(
      <I18nextProvider i18n={i18next}>
        <SetupTopbar mode="create" projectName={null} />
      </I18nextProvider>,
    );
    expect(screen.queryByRole("button", { name: /cancel/i })).toBeNull();
  });
});
```

- [ ] **Step 3: Run — expect FAIL**

```bash
pnpm --filter @rovenue/dashboard test --run tests/components/setup-topbar-cancel.test.tsx
```
Expected: 2 failures — the prop doesn't exist and no button is rendered.

- [ ] **Step 4: Implement Cancel in `SetupTopbar`**

Open `apps/dashboard/src/components/project-setup/setup-topbar.tsx`.

1. Extend the props type:

```ts
type SetupTopbarProps = {
  mode: SetupMode;
  projectName: string | null;
  onModeChange?: (next: SetupMode) => void;
  showModeSwitch?: boolean;
  onCancel?: () => void;
};
```

2. Destructure `onCancel` in the component signature:

```tsx
export function SetupTopbar({
  mode,
  projectName,
  onModeChange,
  showModeSwitch,
  onCancel,
}: SetupTopbarProps) {
```

3. Replace the trailing `<Link to="/projects">...<X .../></Link>` block with a conditional Cancel button + the existing close link. The full bottom of the header (after the mode-switch block) becomes:

```tsx
      {onCancel ? (
        <Button
          type="button"
          variant="light"
          size="sm"
          onPress={onCancel}
          className="text-rv-mute-600 hover:text-foreground"
        >
          {t("projectSetup.cancel")}
        </Button>
      ) : (
        <Link to="/">
          <Button variant="light" size="icon" aria-label={t("projectSetup.close")}>
            <X className="size-3.5" strokeWidth={2} aria-hidden="true" />
          </Button>
        </Link>
      )}
```

(Note: this also fixes the close link target from `/projects` to `/` — the root-route redirect handles the rest.)

- [ ] **Step 5: Forward `onCancel` through the wizard**

In `apps/dashboard/src/components/project-setup/project-setup-wizard.tsx`:

1. Extend props:

```ts
type ProjectSetupWizardProps = {
  mode: SetupMode;
  initialForm?: SetupForm;
  projectName?: string | null;
  onSubmit: (form: SetupForm) => void;
  isSubmitting?: boolean;
  onCancel?: () => void;
};
```

2. Destructure `onCancel` in the function signature.

3. Pass it to `<SetupTopbar>`:

```tsx
<SetupTopbar mode={mode} projectName={projectName ?? null} onCancel={onCancel} />
```

- [ ] **Step 6: Wire from the setup route**

In `apps/dashboard/src/routes/_authed/projects.setup.tsx`, update `ProjectSetupCreate` to compute the cancel handler:

```tsx
function ProjectSetupCreate() {
  const navigate = useNavigate();
  const createProject = useCreateProject();

  const lastProjectId =
    typeof localStorage !== "undefined"
      ? localStorage.getItem("lastProjectId")
      : null;

  const handleCancel = lastProjectId
    ? () => {
        void navigate({
          to: "/projects/$projectId",
          params: { projectId: lastProjectId },
        });
      }
    : undefined;

  const handleSubmit = (form: SetupForm) => {
    createProject.mutate(
      { name: form.name, slug: form.slug },
      {
        onSuccess: (result) => {
          if (typeof localStorage !== "undefined") {
            localStorage.setItem("lastProjectId", result.project.id);
          }
          navigate({
            to: "/projects/$projectId",
            params: { projectId: result.project.id },
          });
        },
      },
    );
  };

  return (
    <ProjectSetupWizard
      mode="create"
      onSubmit={handleSubmit}
      isSubmitting={createProject.isPending}
      onCancel={handleCancel}
    />
  );
}
```

- [ ] **Step 7: Run the test — expect PASS**

```bash
pnpm --filter @rovenue/dashboard test --run tests/components/setup-topbar-cancel.test.tsx
```
Expected: 2 passed.

- [ ] **Step 8: Type-check**

```bash
pnpm --filter @rovenue/dashboard typecheck
```
Expected: 0 errors.

- [ ] **Step 9: Commit**

```bash
git add apps/dashboard/src/components/project-setup/setup-topbar.tsx \
        apps/dashboard/src/components/project-setup/project-setup-wizard.tsx \
        apps/dashboard/src/routes/_authed/projects.setup.tsx \
        apps/dashboard/src/i18n/locales/en.json \
        apps/dashboard/tests/components/setup-topbar-cancel.test.tsx
git commit -m "feat(dashboard): setup wizard Cancel returns to last project"
```

---

## Task 4: Rewrite `/` redirect logic

**Files:**
- Modify: `apps/dashboard/src/routes/index.tsx`
- Test: `apps/dashboard/tests/routes/index-redirect.test.tsx`

The strategy: extract the redirect resolution into a pure helper (`resolveLandingTarget`) so it's unit-testable without spinning up the router. The route's `beforeLoad` calls the helper after `ensureQueryData`.

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard/tests/routes/index-redirect.test.tsx`:

```tsx
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveLandingTarget } from "../../src/routes/index";

describe("resolveLandingTarget", () => {
  const projects = [
    { id: "p1", name: "Alpha", slug: "alpha" },
    { id: "p2", name: "Beta", slug: "beta" },
  ];

  let storage: Record<string, string>;
  beforeEach(() => {
    storage = {};
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => (k in storage ? storage[k]! : null),
        setItem: (k: string, v: string) => { storage[k] = v; },
        removeItem: (k: string) => { delete storage[k]; },
      },
    });
  });
  afterEach(() => {
    // @ts-expect-error — cleanup
    delete globalThis.localStorage;
  });

  it("returns setup when project list is empty", () => {
    expect(resolveLandingTarget([])).toEqual({ kind: "setup" });
  });

  it("returns last project when lastProjectId is in the list", () => {
    storage.lastProjectId = "p2";
    expect(resolveLandingTarget(projects)).toEqual({
      kind: "project",
      projectId: "p2",
      wroteLastProjectId: false,
    });
  });

  it("falls back to first project when lastProjectId is stale", () => {
    storage.lastProjectId = "deleted";
    const result = resolveLandingTarget(projects);
    expect(result).toEqual({
      kind: "project",
      projectId: "p1",
      wroteLastProjectId: true,
    });
    expect(storage.lastProjectId).toBe("p1");
  });

  it("falls back to first project when no lastProjectId is stored", () => {
    const result = resolveLandingTarget(projects);
    expect(result).toEqual({
      kind: "project",
      projectId: "p1",
      wroteLastProjectId: true,
    });
    expect(storage.lastProjectId).toBe("p1");
  });
});
```

- [ ] **Step 2: Run — expect FAIL**

```bash
pnpm --filter @rovenue/dashboard test --run tests/routes/index-redirect.test.tsx
```
Expected: import error — `resolveLandingTarget` does not exist.

- [ ] **Step 3: Rewrite `routes/index.tsx`**

Replace the file content entirely with:

```tsx
import { createFileRoute, redirect } from "@tanstack/react-router";
import type { ProjectSummary } from "@rovenue/shared";
import { getSession } from "../lib/auth";
import { rpc, unwrap } from "../lib/api";
import { queryClient } from "../lib/queryClient";

export type LandingTarget =
  | { kind: "setup" }
  | { kind: "project"; projectId: string; wroteLastProjectId: boolean };

export function resolveLandingTarget(projects: ProjectSummary[]): LandingTarget {
  if (projects.length === 0) return { kind: "setup" };

  const stored =
    typeof localStorage !== "undefined"
      ? localStorage.getItem("lastProjectId")
      : null;
  const matched = stored && projects.find((p) => p.id === stored)?.id;
  if (matched) {
    return { kind: "project", projectId: matched, wroteLastProjectId: false };
  }

  const fallback = projects[0]!.id;
  try {
    localStorage.setItem("lastProjectId", fallback);
  } catch {
    // ignore quota / private mode
  }
  return { kind: "project", projectId: fallback, wroteLastProjectId: true };
}

export const Route = createFileRoute("/")({
  beforeLoad: async () => {
    const session = await getSession();
    if (!session.data) {
      throw redirect({ to: "/login", search: { error: undefined } });
    }

    const res = await queryClient.ensureQueryData({
      queryKey: ["projects"],
      queryFn: () =>
        unwrap<{ projects: ProjectSummary[] }>(rpc.dashboard.projects.$get()),
    });

    const target = resolveLandingTarget(res.projects);
    if (target.kind === "setup") {
      throw redirect({ to: "/projects/setup" });
    }
    throw redirect({
      to: "/projects/$projectId",
      params: { projectId: target.projectId },
    });
  },
});
```

- [ ] **Step 4: Run the test — expect PASS**

```bash
pnpm --filter @rovenue/dashboard test --run tests/routes/index-redirect.test.tsx
```
Expected: 4 passed.

- [ ] **Step 5: Type-check**

```bash
pnpm --filter @rovenue/dashboard typecheck
```
Expected: 0 errors. If `ProjectSummary` is not exported from `@rovenue/shared` at the expected path, fix the import to match `useProjects.ts`'s import (it uses the same name from the same package — should be identical).

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/routes/index.tsx apps/dashboard/tests/routes/index-redirect.test.tsx
git commit -m "feat(dashboard): land on last/first project, skip /projects list"
```

---

## Task 5: Convert `/projects` and `/projects/new` to redirect-only routes

**Files:**
- Modify: `apps/dashboard/src/routes/_authed/projects.index.tsx`
- Modify: `apps/dashboard/src/routes/_authed/projects.new.tsx`

The route files stay so any bookmark to `/projects` or `/projects/new` is softly redirected to `/`, where the new landing logic decides the right destination. All previous content (list view, legacy creation form, `TopNav`, `ProjectCard`, `CreateProjectForm` imports) is removed.

- [ ] **Step 1: Replace `projects.index.tsx`**

Write the full new content of `apps/dashboard/src/routes/_authed/projects.index.tsx`:

```tsx
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authed/projects/")({
  beforeLoad: () => {
    throw redirect({ to: "/" });
  },
});
```

- [ ] **Step 2: Replace `projects.new.tsx`**

Write the full new content of `apps/dashboard/src/routes/_authed/projects.new.tsx`:

```tsx
import { createFileRoute, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authed/projects/new")({
  beforeLoad: () => {
    throw redirect({ to: "/" });
  },
});
```

- [ ] **Step 3: Regenerate route tree**

Run:
```bash
pnpm --filter @rovenue/dashboard typecheck
```
Expected: 0 errors. TanStack Router's Vite plugin regenerates `routeTree.gen.ts` on dev/build, but typecheck reads the current file. If typecheck errors point at stale generated types, run a dev build once:
```bash
pnpm --filter @rovenue/dashboard build
```
and re-run typecheck.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/src/routes/_authed/projects.index.tsx \
        apps/dashboard/src/routes/_authed/projects.new.tsx
git commit -m "refactor(dashboard): /projects and /projects/new become redirect-only"
```

---

## Task 6: Verify and clean up `routes/_authed/projects/$projectId/route.tsx`

The grep for `TopNav | ProjectSwitcher | CreateProjectForm | ProjectCard` matched this file. It is the wrapper route for the project dashboard and should NOT depend on any of the about-to-be-deleted components. Find and remove the stray import.

**Files:**
- Modify (probably): `apps/dashboard/src/routes/_authed/projects/$projectId/route.tsx`

- [ ] **Step 1: Inspect the file**

Run:
```bash
grep -n 'TopNav\|ProjectSwitcher\|CreateProjectForm\|ProjectCard' apps/dashboard/src/routes/_authed/projects/$projectId/route.tsx
```
Expected: 1+ lines naming one of the four symbols.

- [ ] **Step 2: Determine the right replacement**

Open the file. Three patterns are likely:
- **(a)** The import is for `ProjectCard` and is dead (unused symbol) — delete the import line.
- **(b)** It's for `TopNav` used inside the wrapper — replace with no header (the inner pages render `DashboardShell` which has its own Topbar) **or** verify the inner page already renders the shell and delete the `TopNav` usage.
- **(c)** It's for `ProjectSwitcher` used somewhere — delete the import and the usage (the sidebar `AppSwitcher` covers this case).

Pick whichever applies. If unsure which inner content to delete, follow the principle: the wrapper route should be a thin `Outlet`-renderer; any chrome belongs in the child pages' shells.

- [ ] **Step 3: Re-grep to confirm clean**

Run:
```bash
grep -n 'TopNav\|ProjectSwitcher\|CreateProjectForm\|ProjectCard' apps/dashboard/src/routes/_authed/projects/$projectId/route.tsx
```
Expected: no matches.

- [ ] **Step 4: Type-check + smoke**

```bash
pnpm --filter @rovenue/dashboard typecheck
```
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/routes/_authed/projects/\$projectId/route.tsx
git commit -m "refactor(dashboard): drop orphan layout imports from project route wrapper"
```

---

## Task 7: Repoint remaining `/projects` links to `/`

**Files:**
- Modify: `apps/dashboard/src/components/projects/DeleteProjectDialog.tsx`
- Modify: `apps/dashboard/src/components/account/account-topbar.tsx`
- (`setup-topbar.tsx` was already fixed in Task 3.)

The new landing route is `/`, which resolves to the right destination. Any "go back home" link should target `/`.

- [ ] **Step 1: DeleteProjectDialog**

In `apps/dashboard/src/components/projects/DeleteProjectDialog.tsx`, find line ~93:

```tsx
void navigate({ to: "/projects" });
```

Replace with:

```tsx
try { localStorage.removeItem("lastProjectId"); } catch {}
void navigate({ to: "/" });
```

(Clearing `lastProjectId` ensures the root redirect doesn't bounce back to the just-deleted project.)

- [ ] **Step 2: account-topbar**

In `apps/dashboard/src/components/account/account-topbar.tsx`, find:

```tsx
<Link to="/projects" className="flex shrink-0 items-center gap-2 font-semibold">
```

Replace with:

```tsx
<Link to="/" className="flex shrink-0 items-center gap-2 font-semibold">
```

- [ ] **Step 3: Confirm no `/projects` link strings remain in component code**

Run:
```bash
grep -RIn 'to="/projects"\|to: "/projects"' apps/dashboard/src/ | grep -v routeTree.gen.ts
```
Expected: empty output (or only matches that are not yet refactored — investigate each). Acceptable matches: none. The `routes/_authed/projects.*` files are route definitions, not links, so they shouldn't appear.

- [ ] **Step 4: Type-check**

```bash
pnpm --filter @rovenue/dashboard typecheck
```
Expected: 0 errors.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/projects/DeleteProjectDialog.tsx \
        apps/dashboard/src/components/account/account-topbar.tsx
git commit -m "refactor(dashboard): repoint /projects links to / for landing logic"
```

---

## Task 8: Delete orphan components

**Files (delete):**
- `apps/dashboard/src/components/layout/TopNav.tsx`
- `apps/dashboard/src/components/layout/ProjectSwitcher.tsx`
- `apps/dashboard/src/components/projects/ProjectCard.tsx`
- `apps/dashboard/src/components/projects/CreateProjectForm.tsx`

- [ ] **Step 1: Confirm no remaining importers**

Run, one by one (a single command per symbol so each result is easy to read):
```bash
grep -RIln 'from.*layout/TopNav' apps/dashboard/src/
grep -RIln 'from.*layout/ProjectSwitcher' apps/dashboard/src/
grep -RIln 'ProjectCard' apps/dashboard/src/
grep -RIln 'CreateProjectForm' apps/dashboard/src/
```
Expected: each command prints no matches (or only the file being deleted itself, which is fine since it's about to go).

If any production importer remains (i.e. a file you haven't touched yet), STOP and refactor that consumer first. Otherwise proceed.

- [ ] **Step 2: Delete the files**

```bash
rm apps/dashboard/src/components/layout/TopNav.tsx \
   apps/dashboard/src/components/layout/ProjectSwitcher.tsx \
   apps/dashboard/src/components/projects/ProjectCard.tsx \
   apps/dashboard/src/components/projects/CreateProjectForm.tsx
```

If `components/layout/` is now empty, also remove the empty directory:
```bash
rmdir apps/dashboard/src/components/layout/ 2>/dev/null || true
```

- [ ] **Step 3: Type-check and run all tests**

```bash
pnpm --filter @rovenue/dashboard typecheck
pnpm --filter @rovenue/dashboard test --run
```
Expected: 0 typecheck errors. All tests pass (the three new tests + any pre-existing).

- [ ] **Step 4: Commit**

```bash
git add -A apps/dashboard/src/components/
git commit -m "chore(dashboard): delete orphan layout & legacy project components"
```

---

## Task 9: Remove obsolete i18n keys

**Files:**
- Modify: `apps/dashboard/src/i18n/locales/en.json`

- [ ] **Step 1: Identify candidates**

Run:
```bash
grep -n 'projects.list\|projects.new\|topNav' apps/dashboard/src/i18n/locales/en.json
```
Note the keys' locations.

- [ ] **Step 2: Confirm none are still referenced in source**

For each top-level key candidate (e.g. `projects.list`, `projects.new`, and the entire `topNav` block if `TopNav.tsx` is gone), grep the source:
```bash
grep -RIn 't("projects.list\|t("projects.new\|t("topNav' apps/dashboard/src/
```

Important: the `setup-topbar.tsx` keeps using `t("topNav.appName")` (the brand-mark text), so the `topNav` block should NOT be removed in its entirety — only confirm we're not leaving dead leaves. If `topNav.appName` is the only key referenced, leave it alone.

Expected: only `topNav.appName` references remain. No matches for `projects.list.*` or `projects.new.*`.

- [ ] **Step 3: Delete the dead blocks**

Edit `en.json` to remove the entire `projects.list` block and the entire `projects.new` block. Keep the rest of the `projects` namespace intact.

If the `topNav` block contained more than `appName`, delete the unused leaves (only `appName` survives).

- [ ] **Step 4: Validate JSON**

```bash
node -e "JSON.parse(require('fs').readFileSync('apps/dashboard/src/i18n/locales/en.json','utf8'))" && echo OK
```
Expected: `OK`.

- [ ] **Step 5: Type-check and tests**

```bash
pnpm --filter @rovenue/dashboard typecheck
pnpm --filter @rovenue/dashboard test --run
```
Expected: 0 errors, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/i18n/locales/en.json
git commit -m "i18n(dashboard): drop projects.list and projects.new dead keys"
```

---

## Task 10: Manual smoke test

The new landing flow can only be fully validated with a running dev server + a live session.

- [ ] **Step 1: Start the stack**

In one terminal:
```bash
docker compose up -d
```
In another:
```bash
pnpm --filter @rovenue/api dev
```
In a third:
```bash
pnpm --filter @rovenue/dashboard dev
```

- [ ] **Step 2: Path A — existing user, has projects**

1. Open http://localhost:5173 in a browser with a logged-in session that has at least one project (the `test` project from the screenshot is fine).
2. Confirm: lands directly on `/projects/<id>` (Overview), no flicker through `/projects`.
3. Open the sidebar AppSwitcher (click the project name top-left).
4. Confirm: project list shows, with a divider and `+ New project` item at the bottom.
5. Click `+ New project` — should navigate to `/projects/setup`. Cancel button should be visible (since `lastProjectId` is set).
6. Click `Cancel` — should return to the previous project.

- [ ] **Step 3: Path B — user with zero projects**

In DevTools console:
```js
localStorage.removeItem("lastProjectId");
```
Then via the API (or by hand-deleting all memberships) ensure the logged-in user has zero projects. Reload `/`.
Confirm: lands on `/projects/setup`. Cancel button is hidden.
Submit the wizard — should land on the new project's Overview, and the AppSwitcher dropdown now lists it.

- [ ] **Step 4: Path C — bookmarked /projects and /projects/new**

1. Navigate manually to http://localhost:5173/projects — should immediately bounce to `/` and then the project Overview.
2. Navigate to http://localhost:5173/projects/new — same behaviour.

- [ ] **Step 5: Stop the stack**

```bash
docker compose down
```

- [ ] **Step 6: Final commit (only if any docs/CHANGELOG updates are warranted)**

If no further code changes were needed during smoke testing, no commit is required. If the smoke testing surfaced a bug, fix it with its own commit referencing the failing path (A / B / C).

---

## Self-Review Notes (author)

- **Spec coverage:**
  - §1 New landing logic — Task 4 ✓
  - §2 Routes & files to delete — Task 5 (convert) + Task 8 (delete components) ✓
  - §3 Sidebar `AppSwitcher` "+ New project" — Task 2 ✓
  - §4 `ProjectSetupWizard` Cancel — Task 3 ✓
  - §5 i18n keys — Task 1 (add appSwitcher.newProject), Task 3 (add projectSetup.cancel), Task 9 (remove obsolete) ✓
  - §6 Cross-link cleanup — Task 7 ✓
  - §"Bookmarks" Decision (catch-all redirect) — Task 5 ✓
  - §Testing 1–7 — Tasks 2/3/4 unit tests + Task 10 manual smoke ✓
- **Placeholder scan:** no TODO/TBD; every code step contains the actual edit.
- **Type consistency:** `resolveLandingTarget`'s return type and the `LandingTarget` union match between test (Task 4 step 1) and impl (step 3). `onCancel?: () => void` propagates identically across `SetupTopbar` → `ProjectSetupWizard` → `projects.setup.tsx`.
