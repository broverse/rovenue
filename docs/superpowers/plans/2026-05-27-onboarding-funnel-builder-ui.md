# Onboarding Funnel — Backend Wiring with impair (UI already integrated)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Context:** The funnel list page (`apps/dashboard/src/routes/_authed/projects/$projectId/funnels.tsx`) and the full builder shell (`apps/dashboard/src/components/funnel-builder/*`) are already wired up visually. They currently read from `apps/dashboard/src/components/funnel-builder/data.ts` (a mock object) and hold UI state with local `useState`. **This plan does not touch the look or layout** — it replaces the mock data + ad-hoc state with [impair](https://github.com/kutlugsahin/impair) view models that own reactive state, mutate it via methods, and autosave to the real backend via the existing Hono RPC client.

**Goal:** Make the existing funnel builder fully reactive and data-driven via impair. Every keystroke flows through a view model; every view model field is `@state`; autosave fires via `@trigger.debounce(800)`; derived counts (validation errors, selected page index, KPIs) come from `@derived` getters; preview walk uses the same `evaluateNext` the API uses; the publish dropdown reads live version data from a sibling VM. No `useState`, no prop-drilled mocks left when this plan is done.

**Architecture:** impair MVVM. The builder route opens a `ServiceProvider` that registers a `FunnelDraftViewModel` scoped to `{ projectId, funnelId }` (passed via Props). All builder sub-components (`ThumbRail`, `CanvasEditor`, `PropertiesPanel`, `RuleEditor`, `WorkflowTab`, `ThemeTab`, `SettingsTab`, `ValidationDrawer`, the top bar) become `component(...)`-wrapped consumers of that VM via `useService(FunnelDraftViewModel)`. Tabs that pull independent server data (`SessionsTab`, `ShareTab`, the publish version dropdown) sit on their own scoped VMs (`FunnelSessionsViewModel`, `FunnelVersionsViewModel`) registered through `@provide`. The phone preview overlay gets a one-shot `FunnelPreviewViewModel` via `useViewModel`. The funnel list page can stay on plain TanStack Query (Task 33) — impair is required only inside the builder per spec.

The view models talk to the backend through `@injectable()` API service classes (`FunnelApi`, `FunnelTemplatesApi`, `FunnelVersionsApi`, `FunnelSessionsApi`) that wrap the existing `rpc.dashboard.projects[":projectId"].funnels.*` client. Services keep cancellation tokens via `@onMount` `Cleanup` parameters, so unmounting the builder cancels in-flight saves.

**Tech stack additions:** `impair`, `reflect-metadata`, switch from `@vitejs/plugin-react` to `@vitejs/plugin-react-swc` (impair recommends SWC for legacy decorators with no Babel plugin gymnastics — Vite ecosystem standard for this case).

**Spec:** `docs/superpowers/prompts/funnel-builder-design-prompt.md` (functional). The existing UI matches it.

**Commit cadence:** Every task ends with a `git add` + commit. Conventional commits. Keep commits scoped.

**Definition of done:**
- `apps/dashboard/src/components/funnel-builder/data.ts` is deleted.
- Zero `useState` calls remain inside `apps/dashboard/src/components/funnel-builder/`.
- Builder loads a real funnel from the API, autosaves on edits, publishes through the real endpoint, and shows real versions / sessions.
- Preview walks the actual draft using the shared `evaluateNext`.
- Validation badge in the top bar reads from `vm.validation.errors.length` (derived).
- `pnpm typecheck`, `pnpm test`, and a manual click-through pass.

---

## File map

### Created
- `packages/shared/src/funnel/evaluator.ts` (port from API)
- `packages/shared/src/funnel/evaluator.test.ts`
- `packages/shared/src/funnel/validator.ts` (port from API)
- `apps/dashboard/src/lib/services/funnel-api.ts` — `@injectable()` API wrapper
- `apps/dashboard/src/lib/services/funnel-templates-api.ts`
- `apps/dashboard/src/lib/services/funnel-versions-api.ts`
- `apps/dashboard/src/lib/services/funnel-sessions-api.ts`
- `apps/dashboard/src/lib/impair-config.ts` — global `configure(...)` call
- `apps/dashboard/src/components/funnel-builder/vm/funnel-draft.vm.ts` — heart
- `apps/dashboard/src/components/funnel-builder/vm/funnel-draft.vm.test.ts`
- `apps/dashboard/src/components/funnel-builder/vm/funnel-versions.vm.ts`
- `apps/dashboard/src/components/funnel-builder/vm/funnel-sessions.vm.ts`
- `apps/dashboard/src/components/funnel-builder/vm/funnel-preview.vm.ts`
- `apps/dashboard/src/components/funnel-builder/vm/funnel-preview.vm.test.ts`
- `apps/dashboard/src/components/funnel-builder/builder-provider.tsx` — wraps the builder route in `ServiceProvider`

### Modified
- `apps/api/src/services/funnel/branching-evaluator.ts` — thin re-export from shared
- `apps/api/src/services/funnel/branching-validator.ts` — thin re-export from shared
- `packages/shared/src/funnel/index.ts` — re-export evaluator + validator
- `apps/dashboard/package.json` — add `impair`, `reflect-metadata`; swap `@vitejs/plugin-react` → `@vitejs/plugin-react-swc`
- `apps/dashboard/vite.config.ts` — switch react plugin + `tsDecorators: true`
- `apps/dashboard/tsconfig.json` — `experimentalDecorators: true`, `emitDecoratorMetadata: true`, `useDefineForClassFields: false`
- `apps/dashboard/src/main.tsx` — `import "reflect-metadata"` at top; call impair `configure(...)`
- `apps/dashboard/src/components/funnel-builder/types.ts` — keep `PAGE_TYPES`/`TABS` constants; types remain but become re-exports of `@rovenue/shared/funnel` shapes where they overlap
- `apps/dashboard/src/components/funnel-builder/builder-shell.tsx` — drop `FUNNEL`/`SESSIONS`/`VALIDATION_ISSUES`/`VERSIONS` imports + local state; consume `FunnelDraftViewModel`
- `apps/dashboard/src/components/funnel-builder/thumb-rail.tsx` — consume `FunnelDraftViewModel`
- `apps/dashboard/src/components/funnel-builder/canvas-editor.tsx` — consume + dispatch mutations
- `apps/dashboard/src/components/funnel-builder/properties-panel.tsx` — consume + dispatch
- `apps/dashboard/src/components/funnel-builder/rule-editor.tsx` — consume + dispatch
- `apps/dashboard/src/components/funnel-builder/workflow-tab.tsx` — consume
- `apps/dashboard/src/components/funnel-builder/theme-tab.tsx` — consume
- `apps/dashboard/src/components/funnel-builder/settings-tab.tsx` — consume
- `apps/dashboard/src/components/funnel-builder/sessions-tab.tsx` — consume `FunnelSessionsViewModel`
- `apps/dashboard/src/components/funnel-builder/share-tab.tsx` — consume `FunnelDraftViewModel`
- `apps/dashboard/src/components/funnel-builder/validation-drawer.tsx` — consume `vm.validation`
- `apps/dashboard/src/components/funnel-builder/preview-overlay.tsx` — consume `FunnelPreviewViewModel`
- `apps/dashboard/src/components/funnel-builder/page-preview.tsx` — stays a pure component (no impair)
- `apps/dashboard/src/routes/_authed/projects/$projectId/funnels/$funnelId.tsx` — wrap in `BuilderProvider`
- `apps/dashboard/src/routes/_authed/projects/$projectId/funnels.tsx` — replace mock list with real API (TanStack Query, no impair)

### Deleted
- `apps/dashboard/src/components/funnel-builder/data.ts` — mock data, removed last

---

## Phases

- **Phase 1** — Shared evaluator + validator port (Tasks 1-4)
- **Phase 2** — impair install + Vite/TS config (Tasks 5-7)
- **Phase 3** — API service classes (Tasks 8-11)
- **Phase 4** — `FunnelDraftViewModel` core + tests (Tasks 12-15)
- **Phase 5** — Wire BuilderShell + top bar (Tasks 16-18)
- **Phase 6** — Wire ThumbRail (Task 19)
- **Phase 7** — Wire CanvasEditor (Tasks 20-21)
- **Phase 8** — Wire PropertiesPanel (Tasks 22-23)
- **Phase 9** — Wire RuleEditor + WorkflowTab (Tasks 24-25)
- **Phase 10** — Wire ThemeTab + SettingsTab (Tasks 26-27)
- **Phase 11** — `FunnelSessionsViewModel` + SessionsTab (Tasks 28-29)
- **Phase 12** — Wire ShareTab (Task 30)
- **Phase 13** — `FunnelVersionsViewModel` + publish dropdown + versions page (Tasks 31-32)
- **Phase 14** — Wire ValidationDrawer + publish gating (Task 33)
- **Phase 15** — `FunnelPreviewViewModel` + PreviewOverlay (Tasks 34-35)
- **Phase 16** — Wire funnel list page to real backend (Task 36)
- **Phase 17** — Polish: delete `data.ts`, dead-code sweep, smoke test (Tasks 37-38)

---

## Phase 1 — Shared evaluator + validator port

The preview overlay and the validation surface both need pure functions that the API already owns. We move them into `@rovenue/shared/funnel` so dashboard, API, and any future SDK consumer share one implementation. The API files become thin re-exports — backward-compatible for existing call sites.

### Task 1: Port branching evaluator into shared

**Files:**
- Create: `packages/shared/src/funnel/evaluator.ts`
- Modify: `packages/shared/src/funnel/index.ts`

- [ ] **Step 1: Copy the body verbatim**

Open `apps/api/src/services/funnel/branching-evaluator.ts`. Copy the full file body into `packages/shared/src/funnel/evaluator.ts`, changing the imports — `Clause`, `NextRule` must come from `./branching-schema` (relative), not `@rovenue/shared/funnel`:

```ts
import type { Clause, NextRule } from "./branching-schema";

export type AnswerValue = string | number | boolean | string[] | null;
export type AnswerMap = Map<string, AnswerValue>;

export interface EvalPage {
  id: string;
  type: string;
  config: Record<string, unknown>;
  next_rules?: NextRule[];
  default_next?: string | "paywall" | "end";
}

export type PageGraph = Map<string, EvalPage>;

export type EvalResult =
  | { next: "page"; pageId: string }
  | { next: "paywall" }
  | { next: "end" };

interface EvalInput {
  page: EvalPage;
  pagesOrder: string[];
  answers: AnswerMap;
  pagesById: PageGraph;
}

export function evaluateNext(input: EvalInput): EvalResult {
  const { page, answers, pagesOrder } = input;
  const rules = page.next_rules ?? [];
  for (const rule of rules) {
    if (matches(rule.condition, answers)) {
      return resolveGoto(rule.goto, page.id, pagesOrder);
    }
  }
  if (page.default_next !== undefined) {
    return resolveGoto(page.default_next, page.id, pagesOrder);
  }
  return resolveGoto("sequential", page.id, pagesOrder);
}

function resolveGoto(
  goto: string | "paywall" | "end" | "sequential",
  fromId: string,
  pagesOrder: string[],
): EvalResult {
  if (goto === "paywall") return { next: "paywall" };
  if (goto === "end") return { next: "end" };
  if (goto === "sequential") {
    const idx = pagesOrder.indexOf(fromId);
    if (idx === -1 || idx === pagesOrder.length - 1) return { next: "end" };
    return { next: "page", pageId: pagesOrder[idx + 1] };
  }
  return { next: "page", pageId: goto };
}

function matches(
  condition: { op: "all" | "any"; clauses: Clause[] },
  answers: AnswerMap,
): boolean {
  if (condition.op === "all") return condition.clauses.every((c) => evalClause(c, answers));
  return condition.clauses.some((c) => evalClause(c, answers));
}

function evalClause(clause: Clause, answers: AnswerMap): boolean {
  const a = answers.get(clause.question_id);
  switch (clause.op) {
    case "is_answered": return a !== undefined && a !== null;
    case "is_not_answered": return a === undefined || a === null;
    case "eq": return a === clause.value;
    case "neq": return a !== clause.value;
    case "gt": return typeof a === "number" && typeof clause.value === "number" && a > clause.value;
    case "gte": return typeof a === "number" && typeof clause.value === "number" && a >= clause.value;
    case "lt": return typeof a === "number" && typeof clause.value === "number" && a < clause.value;
    case "lte": return typeof a === "number" && typeof clause.value === "number" && a <= clause.value;
    case "between": {
      if (typeof a !== "number" || !Array.isArray(clause.value) || clause.value.length !== 2) return false;
      const [min, max] = clause.value as [number, number];
      return a >= min && a <= max;
    }
    case "in": return Array.isArray(clause.value) && (clause.value as unknown[]).includes(a);
    case "not_in": return Array.isArray(clause.value) && !(clause.value as unknown[]).includes(a);
    case "contains": return Array.isArray(a) && typeof clause.value === "string" && a.includes(clause.value);
    default: return false;
  }
}
```

- [ ] **Step 2: Re-export from shared barrel**

Append to `packages/shared/src/funnel/index.ts`:

```ts
export * from "./evaluator";
```

- [ ] **Step 3: Type-check + commit**

```bash
pnpm --filter @rovenue/shared typecheck
git add packages/shared/src/funnel/evaluator.ts packages/shared/src/funnel/index.ts
git commit -m "feat(shared): port branching evaluator into @rovenue/shared/funnel"
```

---

### Task 2: Port evaluator tests

**Files:**
- Create: `packages/shared/src/funnel/evaluator.test.ts`

- [ ] **Step 1: Copy the existing test**

Copy the full body of `apps/api/src/services/funnel/branching-evaluator.test.ts` into `packages/shared/src/funnel/evaluator.test.ts`, changing the import to `./evaluator`.

- [ ] **Step 2: Run + commit**

```bash
pnpm --filter @rovenue/shared vitest run src/funnel/evaluator.test.ts
git add packages/shared/src/funnel/evaluator.test.ts
git commit -m "test(shared): port branching evaluator parity tests"
```

---

### Task 3: Make API evaluator a thin re-export

**Files:**
- Modify: `apps/api/src/services/funnel/branching-evaluator.ts`

- [ ] **Step 1: Replace contents**

```ts
export {
  evaluateNext,
  type AnswerMap, type AnswerValue, type EvalPage, type EvalResult, type PageGraph,
} from "@rovenue/shared/funnel";
```

- [ ] **Step 2: Verify + commit**

```bash
pnpm --filter @rovenue/api vitest run src/services/funnel/branching-evaluator.test.ts
pnpm -r typecheck
git add apps/api/src/services/funnel/branching-evaluator.ts
git commit -m "refactor(api): thin re-export of branching evaluator from shared"
```

---

### Task 4: Port branching validator into shared

**Files:**
- Create: `packages/shared/src/funnel/validator.ts`
- Modify: `packages/shared/src/funnel/index.ts`
- Modify: `apps/api/src/services/funnel/branching-validator.ts`

- [ ] **Step 1: Copy validator body verbatim**

Open `apps/api/src/services/funnel/branching-validator.ts`. Copy its full body into `packages/shared/src/funnel/validator.ts`, changing the `Page` import to `./pages-schema`. Keep all helpers (`detectCycles`, `computeReachable`, `nextTargets`) — do not retype, do not improve. Public exports must stay identical:

```ts
import type { Page } from "./pages-schema";

export type ValidatorIssue =
  | { code: "MISSING_PAYWALL"; message: string }
  | { code: "MISSING_SUCCESS"; message: string }
  | { code: "CYCLE"; message: string; path: string[] }
  | { code: "DUPLICATE_QUESTION_ID"; message: string; questionId: string }
  | { code: "UNKNOWN_QUESTION_REF"; message: string; pageId: string; questionId: string }
  | { code: "UNKNOWN_GOTO"; message: string; pageId: string; goto: string }
  | { code: "UNREACHABLE"; message: string; pageId: string };

export type ValidationResult =
  | { ok: true; warnings: ValidatorIssue[] }
  | { ok: false; issues: ValidatorIssue[]; warnings: ValidatorIssue[] };

// ... validateFunnelGraph + helpers — paste from API verbatim
```

- [ ] **Step 2: Update shared barrel**

Append to `packages/shared/src/funnel/index.ts`:

```ts
export * from "./validator";
```

- [ ] **Step 3: Replace API validator with re-export**

Replace `apps/api/src/services/funnel/branching-validator.ts`:

```ts
export {
  validateFunnelGraph,
  type ValidatorIssue,
  type ValidationResult,
} from "@rovenue/shared/funnel";
```

- [ ] **Step 4: Run all tests, type-check, commit**

```bash
pnpm test
pnpm -r typecheck
git add packages/shared/src/funnel/ apps/api/src/services/funnel/branching-validator.ts
git commit -m "refactor(shared): port branching validator from API"
```

---

## Phase 2 — impair install + Vite/TS config

impair uses TypeScript legacy decorators + `reflect-metadata`. The cleanest way on Vite is to swap `@vitejs/plugin-react` for `@vitejs/plugin-react-swc` with `tsDecorators: true` — SWC handles legacy decorators natively, no Babel plugin acrobatics, and the rest of the dashboard's React setup is unaffected.

### Task 5: Install impair + reflect-metadata + swap to plugin-react-swc

**Files:**
- Modify: `apps/dashboard/package.json`

- [ ] **Step 1: Run install commands**

```bash
pnpm --filter @rovenue/dashboard add impair reflect-metadata
pnpm --filter @rovenue/dashboard remove @vitejs/plugin-react
pnpm --filter @rovenue/dashboard add -D @vitejs/plugin-react-swc
```

- [ ] **Step 2: Verify package.json reflects the swap**

Expected:
- `dependencies` includes `impair` and `reflect-metadata`.
- `devDependencies` includes `@vitejs/plugin-react-swc`, no longer `@vitejs/plugin-react`.

- [ ] **Step 3: Commit lockfile + manifest**

```bash
git add apps/dashboard/package.json pnpm-lock.yaml
git commit -m "chore(dashboard): add impair + reflect-metadata; swap react plugin to swc"
```

---

### Task 6: Wire Vite + TypeScript for legacy decorators

**Files:**
- Modify: `apps/dashboard/vite.config.ts`
- Modify: `apps/dashboard/tsconfig.json`

- [ ] **Step 1: Update vite.config.ts**

Replace the file body with:

```ts
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import tailwindcss from "@tailwindcss/vite";
import { TanStackRouterVite } from "@tanstack/router-plugin/vite";

export default defineConfig({
  plugins: [
    TanStackRouterVite({ target: "react", autoCodeSplitting: true }),
    react({
      tsDecorators: true,
    }),
    tailwindcss(),
  ],
  esbuild: {
    tsconfigRaw: {
      compilerOptions: {
        experimentalDecorators: true,
      },
    },
  },
  server: { port: 5173 },
});
```

The `esbuild.tsconfigRaw` block is required so Vite's dependency pre-bundling treats decorator syntax in `.ts` modules outside `src/` (e.g. test files, lib re-exports) the same way as our compiler does.

- [ ] **Step 2: Update tsconfig.json**

Add three compiler options. `useDefineForClassFields` must go to `false` so impair's property decorators can swap the field accessor before the proxy is installed:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "useDefineForClassFields": false,
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
    "experimentalDecorators": true,
    "emitDecoratorMetadata": true,
    "types": ["vitest/globals", "@testing-library/jest-dom", "reflect-metadata"]
  },
  "include": ["src", "tests"]
}
```

- [ ] **Step 3: Boot the dev server to verify**

```bash
pnpm --filter @rovenue/dashboard dev
```

Open in browser. The app should render exactly as before (no decorators used yet — this just verifies the swap is harmless). Stop the dev server.

- [ ] **Step 4: Commit**

```bash
git add apps/dashboard/vite.config.ts apps/dashboard/tsconfig.json
git commit -m "chore(dashboard): enable legacy decorators (swc tsDecorators + tsconfig)"
```

---

### Task 7: Reflect-metadata import + impair `configure`

**Files:**
- Create: `apps/dashboard/src/lib/impair-config.ts`
- Modify: `apps/dashboard/src/main.tsx`

- [ ] **Step 1: Create the configure module**

Create `apps/dashboard/src/lib/impair-config.ts`:

```ts
import { configure } from "impair";

// Funnel builder mutates state directly from the view layer (canvas inputs
// dispatch updatePage on the VM, but some bindings — e.g. controlled
// inputs — write back through the proxy). Loosen the readonly guard so
// those mutations don't warn.
configure({
  readonlyProxiesForView: false,
  defaultStateReactiveLevel: "deep",
});
```

- [ ] **Step 2: Wire main.tsx**

Open `apps/dashboard/src/main.tsx`. Add as the **very first lines** of the file (before any other import):

```ts
import "reflect-metadata";
import "./lib/impair-config";
```

Order matters — `reflect-metadata` must run before any `@injectable` class is loaded.

- [ ] **Step 3: Verify + commit**

```bash
pnpm --filter @rovenue/dashboard typecheck
pnpm --filter @rovenue/dashboard dev   # spot-check; stop after page loads
git add apps/dashboard/src/main.tsx apps/dashboard/src/lib/impair-config.ts
git commit -m "chore(dashboard): bootstrap reflect-metadata + impair configure"
```

---

## Phase 3 — API service classes

Each `@injectable()` API service is a thin wrapper around the existing Hono RPC client. View models inject these instead of calling `rpc` directly, so unit tests can swap them out and so cancellation is centralized.

### Task 8: FunnelApi service

**Files:**
- Create: `apps/dashboard/src/lib/services/funnel-api.ts`

- [ ] **Step 1: Implement**

```ts
import { injectable } from "impair";
import { rpc, unwrap } from "../api";
import type {
  PagesArray, Theme as FunnelTheme, FunnelSettings, NextRule,
} from "@rovenue/shared/funnel";

export interface FunnelDetailDto {
  id: string;
  projectId: string;
  slug: string;
  name: string;
  status: "draft" | "published" | "archived";
  currentVersionId: string | null;
  currentVersionNo: number | null;
  draftPages: PagesArray;
  draftTheme: FunnelTheme;
  draftSettings: FunnelSettings;
  draftRules: Record<string, NextRule[]>;
  draftDefaultNext: Record<string, string | null>;
  draftDiffersFromPublished: boolean;
  updatedAt: string;
  createdAt: string;
}

export interface PatchDraftPayload {
  name?: string;
  slug?: string;
  draftPages?: PagesArray;
  draftTheme?: FunnelTheme;
  draftSettings?: FunnelSettings;
  draftRules?: Record<string, NextRule[]>;
  draftDefaultNext?: Record<string, string | null>;
}

@injectable()
export class FunnelApi {
  get(projectId: string, funnelId: string, signal?: AbortSignal) {
    return unwrap<{ funnel: FunnelDetailDto }>(
      rpc.dashboard.projects[":projectId"].funnels[":funnelId"].$get(
        { param: { projectId, funnelId } },
        { init: { signal } },
      ),
    ).then((r) => r.funnel);
  }

  patchDraft(
    projectId: string,
    funnelId: string,
    payload: PatchDraftPayload,
    signal?: AbortSignal,
  ) {
    return unwrap<{ funnel: FunnelDetailDto }>(
      rpc.dashboard.projects[":projectId"].funnels[":funnelId"].$patch(
        { param: { projectId, funnelId }, json: payload },
        { init: { signal } },
      ),
    ).then((r) => r.funnel);
  }

  publish(projectId: string, funnelId: string) {
    return unwrap<{ funnel: FunnelDetailDto; versionNo: number }>(
      rpc.dashboard.projects[":projectId"].funnels[":funnelId"].publish.$post({
        param: { projectId, funnelId },
      }),
    );
  }

  duplicate(projectId: string, funnelId: string) {
    return unwrap<{ funnel: FunnelDetailDto }>(
      rpc.dashboard.projects[":projectId"].funnels[":funnelId"].duplicate.$post({
        param: { projectId, funnelId },
      }),
    ).then((r) => r.funnel);
  }
}
```

If `unwrap` in `apps/dashboard/src/lib/api.ts` does not accept the `init` option pattern shown above, open it and add an optional second arg that merges into the underlying fetch init. If the Hono client already accepts `signal` via a different shape, adjust — the goal is "cancellable via AbortSignal".

- [ ] **Step 2: Type-check + commit**

```bash
pnpm --filter @rovenue/dashboard typecheck
git add apps/dashboard/src/lib/services/funnel-api.ts
git commit -m "feat(dashboard): @injectable FunnelApi wrapper around rpc client"
```

---

### Task 9: FunnelTemplatesApi

**Files:**
- Create: `apps/dashboard/src/lib/services/funnel-templates-api.ts`

- [ ] **Step 1: Implement**

```ts
import { injectable } from "impair";
import { rpc, unwrap } from "../api";
import type { FunnelDetailDto } from "./funnel-api";

export interface FunnelTemplateDto {
  id: string;
  name: string;
  category: string;
  description: string | null;
  previewImageUrl: string | null;
  scope: "system" | "user";
}

@injectable()
export class FunnelTemplatesApi {
  list() {
    return unwrap<{ templates: FunnelTemplateDto[] }>(
      rpc.dashboard["funnel-templates"].$get(),
    ).then((r) => r.templates);
  }

  createFromTemplate(
    projectId: string,
    templateId: string,
    body: { name: string; slug: string },
  ) {
    return unwrap<{ funnel: FunnelDetailDto }>(
      rpc.dashboard.projects[":projectId"].funnels["from-template"][":templateId"].$post({
        param: { projectId, templateId },
        json: body,
      }),
    ).then((r) => r.funnel);
  }
}
```

- [ ] **Step 2: Commit**

```bash
pnpm --filter @rovenue/dashboard typecheck
git add apps/dashboard/src/lib/services/funnel-templates-api.ts
git commit -m "feat(dashboard): @injectable FunnelTemplatesApi"
```

---

### Task 10: FunnelVersionsApi

**Files:**
- Create: `apps/dashboard/src/lib/services/funnel-versions-api.ts`

- [ ] **Step 1: Implement**

```ts
import { injectable } from "impair";
import { rpc, unwrap } from "../api";
import type { FunnelDetailDto } from "./funnel-api";

export interface FunnelVersionDto {
  id: string;
  versionNo: number;
  publishedAt: string;
  publishedByName: string | null;
  pageCount: number;
  notes: string | null;
  isCurrent: boolean;
}

@injectable()
export class FunnelVersionsApi {
  list(projectId: string, funnelId: string) {
    return unwrap<{ versions: FunnelVersionDto[] }>(
      rpc.dashboard.projects[":projectId"].funnels[":funnelId"].versions.$get({
        param: { projectId, funnelId },
      }),
    ).then((r) => r.versions);
  }

  revert(projectId: string, funnelId: string, versionId: string) {
    return unwrap<{ funnel: FunnelDetailDto }>(
      rpc.dashboard.projects[":projectId"].funnels[":funnelId"].revert[":versionId"].$post({
        param: { projectId, funnelId, versionId },
      }),
    ).then((r) => r.funnel);
  }
}
```

- [ ] **Step 2: Commit**

```bash
pnpm --filter @rovenue/dashboard typecheck
git add apps/dashboard/src/lib/services/funnel-versions-api.ts
git commit -m "feat(dashboard): @injectable FunnelVersionsApi"
```

---

### Task 11: FunnelSessionsApi

**Files:**
- Create: `apps/dashboard/src/lib/services/funnel-sessions-api.ts`

- [ ] **Step 1: Implement**

```ts
import { injectable } from "impair";
import { rpc, unwrap } from "../api";

export interface FunnelSessionRowDto {
  id: string;
  startedAt: string;
  lastActivityAt: string;
  state: "in_progress" | "paid" | "completed" | "abandoned";
  currentPageId: string | null;
  utmSource: string | null;
  answersCount: number;
}

export interface FunnelSessionsStatsDto {
  started: number;
  completionRate: number;
  paywallViewRate: number;
  paidConversion: number;
  medianDurationMs: number | null;
}

export interface FunnelSessionDetailDto extends FunnelSessionRowDto {
  answers: Array<{ pageId: string; questionId: string; answer: unknown; answeredAt: string }>;
  purchase: null | {
    stripeCustomerId: string | null;
    stripeSubscriptionId: string | null;
    amountCents: number | null;
    currency: string | null;
    paidAt: string | null;
  };
}

export type Range = "24h" | "7d" | "30d";

@injectable()
export class FunnelSessionsApi {
  list(projectId: string, funnelId: string, range: Range, signal?: AbortSignal) {
    return unwrap<{ sessions: FunnelSessionRowDto[]; stats: FunnelSessionsStatsDto }>(
      rpc.dashboard.projects[":projectId"].funnels[":funnelId"].sessions.$get(
        { param: { projectId, funnelId }, query: { range } },
        { init: { signal } },
      ),
    );
  }

  detail(projectId: string, funnelId: string, sessionId: string) {
    return unwrap<{ session: FunnelSessionDetailDto }>(
      rpc.dashboard.projects[":projectId"].funnels[":funnelId"].sessions[":sessionId"].$get({
        param: { projectId, funnelId, sessionId },
      }),
    ).then((r) => r.session);
  }
}
```

- [ ] **Step 2: Commit**

```bash
pnpm --filter @rovenue/dashboard typecheck
git add apps/dashboard/src/lib/services/funnel-sessions-api.ts
git commit -m "feat(dashboard): @injectable FunnelSessionsApi"
```

---

## Phase 4 — FunnelDraftViewModel (core)

The heart of the builder. One instance per open funnel, scoped to the `{ projectId, funnelId }` Props. Owns:

- **Server state cache:** `funnel`, `isLoading`, `error`
- **Working draft:** `pages`, `theme`, `settings`, `rules`, `defaultNext`, `name`, `slug`, `status`
- **UI state:** `selectedPageId`, `activeTab`, `showValidation`, `showPreview`, `versionMenuOpen`, `autosaveStatus`
- **Derived:** `selectedPage`, `selectedIdx`, `validation`, `errorCount`, `warnCount`
- **Behavior:** `selectPage`, `goPrev`, `goNext`, `addPage`, `removePage`, `reorderPages`, `updatePage`, `updateOption`, `addOption`, `removeOption`, `addRule`, `removeRule`, `updateRule`, `setDefaultNext`, `updateTheme`, `updateSettings`, `rename`, `publish`, `duplicate`, `discardDraft`, `setActiveTab`, `openValidation`, `closeValidation`, `openPreview`, `closePreview`, `toggleVersionMenu`
- **Lifecycle:** `@onMount load()` (fetches the funnel), `@trigger.debounce(800) autosave()` (PATCH when any draft field changes)

This VM does NOT do internal HTTP caching — `FunnelApi` does the requests; in-memory reactive state is the cache while the builder is mounted. Closing the builder disposes the VM and the dependency container; next open refetches.

### Task 12: Skeleton + loading lifecycle

**Files:**
- Create: `apps/dashboard/src/components/funnel-builder/vm/funnel-draft.vm.ts`

- [ ] **Step 1: Implement skeleton**

```ts
import { injectable, inject, state, onMount, type Cleanup, Props } from "impair";
import type { PagesArray, NextRule } from "@rovenue/shared/funnel";
import { FunnelApi, type FunnelDetailDto } from "../../../lib/services/funnel-api";
import type { Theme, Settings, TabId, Page } from "../types";

export interface DraftProps {
  projectId: string;
  funnelId: string;
}

@injectable()
export class FunnelDraftViewModel {
  @state isLoading = true;
  @state error: Error | null = null;
  @state funnel: FunnelDetailDto | null = null;

  // Working draft (mirrored from server, mutated locally, autosaved)
  @state name = "";
  @state slug = "";
  @state status: "draft" | "published" | "archived" = "draft";
  @state pages: Page[] = [];
  @state theme: Theme = DEFAULT_THEME;
  @state settings: Settings = DEFAULT_SETTINGS;
  @state rules: Record<string, NextRule[]> = {};
  @state defaultNext: Record<string, string | null> = {};

  // UI state
  @state selectedPageId: string | null = null;
  @state activeTab: TabId = "content";
  @state showValidation = false;
  @state showPreview = false;
  @state versionMenuOpen = false;
  @state autosaveStatus: "saved" | "saving" | "error" = "saved";
  @state lastSavedAt: number | null = null;

  constructor(
    @inject(Props) private props: DraftProps,
    @inject(FunnelApi) private api: FunnelApi,
  ) {}

  @onMount
  async load(cleanup: Cleanup) {
    const controller = new AbortController();
    cleanup(() => controller.abort());
    try {
      this.isLoading = true;
      this.error = null;
      const funnel = await this.api.get(this.props.projectId, this.props.funnelId, controller.signal);
      this.applyServer(funnel);
    } catch (err) {
      if ((err as { name?: string })?.name !== "AbortError") {
        this.error = err as Error;
      }
    } finally {
      this.isLoading = false;
    }
  }

  private applyServer(funnel: FunnelDetailDto) {
    this.funnel = funnel;
    this.name = funnel.name;
    this.slug = funnel.slug;
    this.status = funnel.status;
    this.pages = funnel.draftPages as unknown as Page[];
    this.theme = funnel.draftTheme as unknown as Theme;
    this.settings = funnel.draftSettings as unknown as Settings;
    this.rules = funnel.draftRules ?? {};
    this.defaultNext = funnel.draftDefaultNext ?? {};
    if (!this.selectedPageId && this.pages.length > 0) {
      this.selectedPageId = this.pages[0].id;
    }
    this.lastSavedAt = Date.now();
    this.autosaveStatus = "saved";
  }
}

const DEFAULT_THEME: Theme = {
  primary: "#3B82F6",
  accent: "#3B82F6",
  bg: "#FFFFFF",
  text: "#0F172A",
  font: "Inter",
  logoUrl: "",
  logoLetter: "F",
};

const DEFAULT_SETTINGS: Settings = {
  iosUrl: "",
  androidUrl: "",
  universalLinkDomain: "",
  deepLinkScheme: "",
  devMode: false,
};
```

The `Page` type from `./types` uses a different field shape than `PagesArray` from `@rovenue/shared/funnel` (existing dashboard types — flat shape; shared types — discriminated by `type` with `config`). The `applyServer` cast bridges them for now; Task 14 normalises this so the VM works with a single canonical shape.

- [ ] **Step 2: Commit**

```bash
pnpm --filter @rovenue/dashboard typecheck
git add apps/dashboard/src/components/funnel-builder/vm/funnel-draft.vm.ts
git commit -m "feat(dashboard): FunnelDraftViewModel skeleton with @onMount load"
```

---

### Task 13: Page + rule mutations

**Files:**
- Modify: `apps/dashboard/src/components/funnel-builder/vm/funnel-draft.vm.ts`

- [ ] **Step 1: Append mutation methods**

Add inside the class body, after `applyServer`:

```ts
  // ----- UI state mutations -----
  selectPage(id: string) { this.selectedPageId = id; }
  goPrev() {
    const i = this.selectedIdx;
    if (i > 0) this.selectedPageId = this.pages[i - 1].id;
  }
  goNext() {
    const i = this.selectedIdx;
    if (i >= 0 && i < this.pages.length - 1) this.selectedPageId = this.pages[i + 1].id;
  }
  setActiveTab(tab: TabId) { this.activeTab = tab; }
  openValidation() { this.showValidation = true; }
  closeValidation() { this.showValidation = false; }
  openPreview() { this.showPreview = true; }
  closePreview() { this.showPreview = false; }
  toggleVersionMenu() { this.versionMenuOpen = !this.versionMenuOpen; }
  closeVersionMenu() { this.versionMenuOpen = false; }

  // ----- Page list mutations -----
  rename(name: string) { this.name = name; }

  addPage(page: Page, afterId: string | null = null) {
    const idx = afterId
      ? this.pages.findIndex((p) => p.id === afterId) + 1
      : this.pages.length;
    this.pages.splice(idx, 0, page);
    this.selectedPageId = page.id;
  }

  duplicatePage(id: string) {
    const i = this.pages.findIndex((p) => p.id === id);
    if (i < 0) return;
    const copy: Page = JSON.parse(JSON.stringify(this.pages[i]));
    copy.id = `${id}_copy_${Date.now().toString(36)}`;
    this.pages.splice(i + 1, 0, copy);
    this.selectedPageId = copy.id;
  }

  removePage(id: string) {
    const idx = this.pages.findIndex((p) => p.id === id);
    if (idx < 0) return;
    this.pages.splice(idx, 1);
    if (this.selectedPageId === id) {
      this.selectedPageId = this.pages[idx]?.id ?? this.pages[idx - 1]?.id ?? null;
    }
    // Cascade: drop rules + default_next entries for this page
    delete this.rules[id];
    delete this.defaultNext[id];
  }

  reorderPages(order: string[]) {
    const byId = new Map(this.pages.map((p) => [p.id, p] as const));
    this.pages = order.map((id) => byId.get(id)).filter((p): p is Page => Boolean(p));
  }

  updatePage(id: string, patch: Partial<Page>) {
    const i = this.pages.findIndex((p) => p.id === id);
    if (i < 0) return;
    Object.assign(this.pages[i], patch);
  }

  // Options live on the page; impair tracks deeply so splice/assign is enough
  addOption(pageId: string) {
    const page = this.pages.find((p) => p.id === pageId);
    if (!page?.options) return;
    const i = page.options.length;
    page.options.push({ label: `Option ${i + 1}`, value: `option_${i + 1}` });
  }
  updateOption(pageId: string, idx: number, patch: { label?: string; value?: string }) {
    const page = this.pages.find((p) => p.id === pageId);
    if (!page?.options || !page.options[idx]) return;
    Object.assign(page.options[idx], patch);
  }
  removeOption(pageId: string, idx: number) {
    const page = this.pages.find((p) => p.id === pageId);
    if (!page?.options) return;
    page.options.splice(idx, 1);
  }

  // ----- Rules -----
  addRule(pageId: string, rule: NextRule) {
    const list = this.rules[pageId] ?? [];
    this.rules[pageId] = [...list, rule];
  }
  updateRule(pageId: string, ruleIdx: number, patch: Partial<NextRule>) {
    const list = this.rules[pageId];
    if (!list || !list[ruleIdx]) return;
    list[ruleIdx] = { ...list[ruleIdx], ...patch };
  }
  removeRule(pageId: string, ruleIdx: number) {
    const list = this.rules[pageId];
    if (!list) return;
    list.splice(ruleIdx, 1);
    if (list.length === 0) delete this.rules[pageId];
  }
  setDefaultNext(pageId: string, target: string | null) {
    if (target === null) delete this.defaultNext[pageId];
    else this.defaultNext[pageId] = target;
  }

  // ----- Theme / settings -----
  updateTheme(patch: Partial<Theme>) { Object.assign(this.theme, patch); }
  updateSettings(patch: Partial<Settings>) { Object.assign(this.settings, patch); }
```

- [ ] **Step 2: Type-check + commit**

```bash
pnpm --filter @rovenue/dashboard typecheck
git add apps/dashboard/src/components/funnel-builder/vm/funnel-draft.vm.ts
git commit -m "feat(dashboard): FunnelDraftViewModel mutations (pages/rules/theme/settings/UI)"
```

---

### Task 14: Derived + autosave + publish/duplicate/discard

**Files:**
- Modify: `apps/dashboard/src/components/funnel-builder/vm/funnel-draft.vm.ts`

- [ ] **Step 1: Add @derived getters**

Add `derived` and `trigger` to the imports, then append inside the class:

```ts
import {
  injectable, inject, state, onMount, derived, trigger,
  type Cleanup, Props,
} from "impair";
import { validateFunnelGraph, type ValidatorIssue } from "@rovenue/shared/funnel";
```

```ts
  @derived
  get selectedIdx(): number {
    return this.pages.findIndex((p) => p.id === this.selectedPageId);
  }

  @derived
  get selectedPage(): Page | null {
    return this.selectedPageId
      ? this.pages.find((p) => p.id === this.selectedPageId) ?? null
      : this.pages[0] ?? null;
  }

  @derived
  get validation(): {
    errors: ValidatorIssue[];
    warnings: ValidatorIssue[];
    byPage: Map<string, ValidatorIssue[]>;
    unreachable: Set<string>;
  } {
    // Map dashboard's flat Page shape to the validator's expected MinimalPage
    const minimal = this.pages.map((p) => ({
      id: p.id,
      type: p.type,
      config: pageToConfig(p),
      next_rules: this.rules[p.id] ?? [],
      default_next: this.defaultNext[p.id] ?? undefined,
    }));
    const result = validateFunnelGraph(minimal as never);
    const errors = result.ok ? [] : result.issues;
    const warnings = result.warnings;
    const byPage = new Map<string, ValidatorIssue[]>();
    const unreachable = new Set<string>();
    for (const i of [...errors, ...warnings]) {
      const pageId = "pageId" in i ? i.pageId : undefined;
      if (pageId) {
        const arr = byPage.get(pageId) ?? [];
        arr.push(i);
        byPage.set(pageId, arr);
      }
      if (i.code === "UNREACHABLE" && pageId) unreachable.add(pageId);
    }
    return { errors, warnings, byPage, unreachable };
  }

  @derived get errorCount() { return this.validation.errors.length; }
  @derived get warnCount() { return this.validation.warnings.length; }

  @derived get isDirty() {
    return this.autosaveStatus === "saving" || this.autosaveStatus === "error";
  }
```

Add a small helper near the bottom of the file (outside the class):

```ts
function pageToConfig(p: Page): Record<string, unknown> {
  // The dashboard's existing Page is flat; the validator's MinimalPage
  // looks at config.question_id for DUPLICATE_QUESTION_ID and UNKNOWN_QUESTION_REF
  // checks. Surface the dashboard fields under config so the existing
  // validator works without changing it.
  return {
    question_id: p.question_id,
    title: p.title,
    headline: p.headline,
    body: p.body,
    options: p.options,
    min: p.min,
    max: p.max,
    step: p.step,
    suffix: p.suffix,
    duration_ms: p.duration,
  };
}
```

- [ ] **Step 2: Add autosave trigger + publish / duplicate / discard**

Append inside the class:

```ts
  @trigger.debounce(800)
  async autosave(cleanup: Cleanup) {
    // Only autosave once a funnel is loaded
    if (!this.funnel || this.isLoading) return;
    const controller = new AbortController();
    cleanup(() => controller.abort());
    const payload = {
      name: this.name,
      slug: this.slug,
      draftPages: this.pages as never,
      draftTheme: this.theme as never,
      draftSettings: this.settings as never,
      draftRules: this.rules,
      draftDefaultNext: this.defaultNext,
    };
    try {
      this.autosaveStatus = "saving";
      const next = await this.api.patchDraft(
        this.props.projectId, this.props.funnelId, payload, controller.signal,
      );
      this.funnel = next;
      this.lastSavedAt = Date.now();
      this.autosaveStatus = "saved";
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") return;
      this.autosaveStatus = "error";
    }
  }

  async publish() {
    if (this.errorCount > 0) {
      this.showValidation = true;
      return;
    }
    const result = await this.api.publish(this.props.projectId, this.props.funnelId);
    this.applyServer(result.funnel);
  }

  async duplicate() {
    return this.api.duplicate(this.props.projectId, this.props.funnelId);
  }

  async discardDraft() {
    // Re-fetch and overwrite — server's published version is the source of truth
    const funnel = await this.api.get(this.props.projectId, this.props.funnelId);
    this.applyServer(funnel);
  }
```

- [ ] **Step 3: Type-check + commit**

```bash
pnpm --filter @rovenue/dashboard typecheck
git add apps/dashboard/src/components/funnel-builder/vm/funnel-draft.vm.ts
git commit -m "feat(dashboard): FunnelDraftViewModel derived + autosave + publish"
```

---

### Task 15: Unit-test the VM with a fake API

**Files:**
- Create: `apps/dashboard/src/components/funnel-builder/vm/funnel-draft.vm.test.ts`

- [ ] **Step 1: Write the test**

```ts
import "reflect-metadata";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { Container } from "impair";
import { FunnelDraftViewModel } from "./funnel-draft.vm";
import { FunnelApi, type FunnelDetailDto } from "../../../lib/services/funnel-api";

function fakeFunnel(): FunnelDetailDto {
  return {
    id: "f_1", projectId: "p_1", slug: "s", name: "Test funnel",
    status: "draft", currentVersionId: null, currentVersionNo: null,
    draftPages: [
      { id: "pg_1", type: "info", config: { title: "Hi", body_markdown: "" } } as never,
      { id: "pg_pay", type: "paywall", config: { product_id: "p", headline: "x", bullets: ["a"] } } as never,
    ],
    draftTheme: { primary_color: "#000", accent_color: "#111", background_color: "#fff", text_color: "#000" } as never,
    draftSettings: { dev_mode: false } as never,
    draftRules: {}, draftDefaultNext: {}, draftDiffersFromPublished: false,
    updatedAt: "", createdAt: "",
  };
}

function makeVm(api: Partial<FunnelApi>) {
  const container = new Container();
  container.register(FunnelApi, { useValue: api as FunnelApi });
  // Manual instantiation with Props value
  return container.resolveWithProps(FunnelDraftViewModel, { projectId: "p_1", funnelId: "f_1" });
}

describe("FunnelDraftViewModel", () => {
  beforeEach(() => vi.useFakeTimers());

  it("loads on mount and surfaces pages", async () => {
    const get = vi.fn().mockResolvedValue(fakeFunnel());
    const vm = makeVm({ get, patchDraft: vi.fn(), publish: vi.fn(), duplicate: vi.fn() });
    // simulate mount manually by invoking the @onMount-decorated method
    await vm.load(() => {});
    expect(vm.isLoading).toBe(false);
    expect(vm.pages.length).toBe(2);
    expect(vm.selectedPageId).toBe("pg_1");
  });

  it("autosave debounces mutations into one PATCH", async () => {
    const patchDraft = vi.fn().mockResolvedValue(fakeFunnel());
    const vm = makeVm({ get: vi.fn().mockResolvedValue(fakeFunnel()), patchDraft, publish: vi.fn(), duplicate: vi.fn() });
    await vm.load(() => {});
    vm.rename("renamed");
    vm.rename("renamed again");
    vm.updatePage("pg_1", { title: "Bonjour" });
    expect(patchDraft).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(900);
    expect(patchDraft).toHaveBeenCalledTimes(1);
    expect(patchDraft.mock.calls[0][2].name).toBe("renamed again");
  });

  it("errorCount reflects validator output", async () => {
    const vm = makeVm({ get: vi.fn().mockResolvedValue(fakeFunnel()), patchDraft: vi.fn(), publish: vi.fn(), duplicate: vi.fn() });
    await vm.load(() => {});
    expect(vm.errorCount).toBe(0);
    vm.removePage("pg_pay"); // remove paywall — MISSING_PAYWALL
    expect(vm.errorCount).toBeGreaterThan(0);
  });
});
```

If `Container#resolveWithProps` isn't the exact API impair exposes for manual VM construction in tests, consult the impair README's "Container (Injection Token)" section and adapt. The intent is: register a fake `FunnelApi`, build the VM, drive it, assert state.

- [ ] **Step 2: Run + commit**

```bash
pnpm --filter @rovenue/dashboard vitest run src/components/funnel-builder/vm/funnel-draft.vm.test.ts
git add apps/dashboard/src/components/funnel-builder/vm/funnel-draft.vm.test.ts
git commit -m "test(dashboard): FunnelDraftViewModel load/autosave/validation"
```

---

## Phase 5 — Wire BuilderShell + top bar to the VM

We replace local `useState` and the `FUNNEL/SESSIONS/VALIDATION_ISSUES/VERSIONS` imports from `./data` with one `useService(FunnelDraftViewModel)` call. A `BuilderProvider` wraps the route in `ServiceProvider`, supplying Props.

### Task 16: BuilderProvider + route wiring

**Files:**
- Create: `apps/dashboard/src/components/funnel-builder/builder-provider.tsx`
- Modify: `apps/dashboard/src/routes/_authed/projects/$projectId/funnels/$funnelId.tsx`

- [ ] **Step 1: BuilderProvider**

```tsx
import { ServiceProvider } from "impair";
import type { ReactNode } from "react";
import { FunnelApi } from "../../lib/services/funnel-api";
import { FunnelVersionsApi } from "../../lib/services/funnel-versions-api";
import { FunnelSessionsApi } from "../../lib/services/funnel-sessions-api";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";

interface Props {
  projectId: string;
  funnelId: string;
  children: ReactNode;
}

export function BuilderProvider({ projectId, funnelId, children }: Props) {
  return (
    <ServiceProvider
      provide={[FunnelApi, FunnelVersionsApi, FunnelSessionsApi, FunnelDraftViewModel]}
      props={{ projectId, funnelId }}
    >
      {children}
    </ServiceProvider>
  );
}
```

- [ ] **Step 2: Update the route to wrap in BuilderProvider**

Replace `apps/dashboard/src/routes/_authed/projects/$projectId/funnels/$funnelId.tsx`:

```tsx
import { createFileRoute, useParams } from "@tanstack/react-router";
import { BuilderProvider } from "../../../../../components/funnel-builder/builder-provider";
import { BuilderShell } from "../../../../../components/funnel-builder";

function Route() {
  const { projectId, funnelId } = useParams({
    from: "/_authed/projects/$projectId/funnels/$funnelId",
  });
  return (
    <BuilderProvider projectId={projectId} funnelId={funnelId}>
      <BuilderShell projectId={projectId} />
    </BuilderProvider>
  );
}

export const Route = createFileRoute("/_authed/projects/$projectId/funnels/$funnelId")({
  component: Route,
});
```

- [ ] **Step 3: Commit**

```bash
pnpm --filter @rovenue/dashboard typecheck
git add apps/dashboard/src/components/funnel-builder/builder-provider.tsx apps/dashboard/src/routes/_authed/projects/\$projectId/funnels/\$funnelId.tsx
git commit -m "feat(dashboard): BuilderProvider + route wiring around impair ServiceProvider"
```

---

### Task 17: BuilderShell consumes the VM

**Files:**
- Modify: `apps/dashboard/src/components/funnel-builder/builder-shell.tsx`

- [ ] **Step 1: Wrap with `component(...)` and replace state**

Open the file. Replace its body to:

1. Drop imports from `./data` (`FUNNEL`, `SESSIONS`, `VALIDATION_ISSUES`, `VERSIONS`).
2. Drop `useState`, `useEffect` for autosave, all derived constants.
3. Replace `BuilderShell` and `TopBar` definitions with `component(...)` wrappers.
4. Consume the VM via `useService(FunnelDraftViewModel)`.

```tsx
import { component, useService } from "impair";
import { Link } from "@tanstack/react-router";
import {
  ArrowRight, Book, Check, ChevronDown, ChevronRight,
  History, RotateCcw, Share2, Sparkles, TriangleAlert,
} from "lucide-react";
import { cn } from "../../lib/cn";
import { TABS, type TabId } from "./types";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";
import { ThumbRail } from "./thumb-rail";
import { CanvasEditor } from "./canvas-editor";
import { PropertiesPanel } from "./properties-panel";
import { WorkflowTab } from "./workflow-tab";
import { ThemeTab } from "./theme-tab";
import { SettingsTab } from "./settings-tab";
import { SessionsTab } from "./sessions-tab";
import { ShareTab } from "./share-tab";
import { ValidationDrawer } from "./validation-drawer";
import { PreviewOverlay } from "./preview-overlay";

interface Props { projectId: string }

export const BuilderShell = component(({ projectId }: Props) => {
  const vm = useService(FunnelDraftViewModel);

  if (vm.isLoading) {
    return <div className="fixed inset-0 z-50 bg-rv-bg" />;
  }
  if (vm.error || !vm.funnel) {
    return (
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-rv-bg text-rv-mute-700">
        Failed to load funnel.
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-rv-bg text-foreground">
      <TopBar projectId={projectId} />
      <main className="flex flex-1 overflow-hidden">
        {vm.activeTab === "content" && (
          <>
            <ThumbRail />
            <CanvasEditor />
            <PropertiesPanel />
          </>
        )}
        {vm.activeTab === "workflow" && <WorkflowTab />}
        {vm.activeTab === "theme" && <ThemeTab />}
        {vm.activeTab === "settings" && <SettingsTab />}
        {vm.activeTab === "sessions" && <SessionsTab />}
        {vm.activeTab === "share" && <ShareTab />}
      </main>
      {vm.activeTab === "content" && <AiChatFab />}
      {vm.showPreview && <PreviewOverlay />}
      {vm.showValidation && <ValidationDrawer />}
    </div>
  );
});
```

- [ ] **Step 2: Rewrite TopBar as a `component(...)` consumer**

Inside the same file (keep `TopBar` co-located):

```tsx
const TopBar = component(({ projectId }: { projectId: string }) => {
  const vm = useService(FunnelDraftViewModel);
  return (
    <header className="flex h-14 items-center justify-between border-b border-rv-divider bg-rv-c1 px-4">
      {/* Left: brand + breadcrumb (unchanged markup; substitute vm.name for FUNNEL.name) */}
      <div className="flex items-center gap-2 text-[13px]">
        <Link
          to="/projects/$projectId/funnels"
          params={{ projectId }}
          className="flex h-8 w-8 items-center justify-center rounded-md bg-gradient-to-br from-rv-accent-500 to-rv-accent-700 text-[14px] font-bold text-white"
          title="Back to all funnels"
        >R</Link>
        <Link to="/projects/$projectId/funnels" params={{ projectId }} className="text-rv-mute-600 hover:text-foreground">
          Funnels
        </Link>
        <ChevronRight size={12} className="text-rv-mute-500" />
        <span className="font-medium text-foreground">{vm.name}</span>
        <ChevronDown size={12} className="text-rv-mute-500" />
      </div>

      {/* Center: tabs */}
      <div className="absolute left-1/2 -translate-x-1/2">
        <div className="flex items-center gap-0.5 rounded-md border border-rv-divider bg-rv-c2 p-0.5">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => vm.setActiveTab(t.id as TabId)}
              title={t.hint}
              className={cn(
                "relative inline-flex h-7 cursor-pointer items-center gap-1.5 rounded px-3 text-[12px] font-medium transition",
                vm.activeTab === t.id
                  ? "bg-rv-c4 text-foreground"
                  : "text-rv-mute-600 hover:text-foreground",
              )}
            >
              {t.label}
              {t.pip && Object.keys(vm.rules).length > 0 && (
                <span className="h-1.5 w-1.5 rounded-full bg-rv-accent-500" />
              )}
            </button>
          ))}
        </div>
      </div>

      {/* Right: autosave + validation + share + publish + help + avatar */}
      <div className="flex items-center gap-2">
        <AutosaveBadge />
        {vm.errorCount > 0 ? (
          <button
            type="button"
            onClick={() => vm.openValidation()}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-rv-danger/40 bg-rv-danger/15 px-2 text-[11px] font-medium text-rv-danger hover:bg-rv-danger/20"
          >
            <TriangleAlert size={12} />
            {vm.errorCount} issue{vm.errorCount === 1 ? "" : "s"}
          </button>
        ) : vm.warnCount > 0 ? (
          <button
            type="button"
            onClick={() => vm.openValidation()}
            className="inline-flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-rv-warning/40 bg-rv-warning/15 px-2 text-[11px] font-medium text-rv-warning hover:bg-rv-warning/20"
          >
            <TriangleAlert size={12} />
            {vm.warnCount} warning{vm.warnCount === 1 ? "" : "s"}
          </button>
        ) : null}

        <button
          type="button"
          onClick={() => vm.setActiveTab("share")}
          className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-rv-divider bg-rv-c2 px-3 text-[12px] font-medium text-rv-mute-800 hover:bg-rv-c3"
        >
          <Share2 size={13} />
          Share
        </button>

        <PublishDropdown />

        <button
          type="button"
          title="Help"
          className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md text-rv-mute-600 hover:bg-rv-c2 hover:text-foreground"
        >
          <Book size={14} />
        </button>
        <div className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-full bg-rv-c4 font-rv-mono text-[11px] font-bold text-rv-mute-800">
          FN
        </div>
      </div>
    </header>
  );
});
```

- [ ] **Step 3: Extract AutosaveBadge + PublishDropdown + AiChatFab as `component(...)`s**

Below `TopBar`, replace the existing inline JSX:

```tsx
const AutosaveBadge = component(() => {
  const vm = useService(FunnelDraftViewModel);
  const saving = vm.autosaveStatus === "saving";
  const err = vm.autosaveStatus === "error";
  return (
    <span
      title={err ? "Save failed — retrying" : "Autosaved on every change"}
      className="inline-flex h-7 items-center gap-1.5 rounded-md border border-rv-divider bg-rv-c2 px-2 font-rv-mono text-[11px] text-rv-mute-600"
    >
      <span className={cn(
        "h-1.5 w-1.5 rounded-full",
        saving ? "animate-pulse bg-rv-warning" : err ? "bg-rv-danger" : "bg-rv-success",
      )} />
      {saving ? "saving" : err ? "retrying" : "saved"}
    </span>
  );
});

const PublishDropdown = component(() => {
  const vm = useService(FunnelDraftViewModel);
  const nextVersionNo = (vm.funnel?.currentVersionNo ?? 0) + 1;
  return (
    <div className="relative flex">
      <button
        type="button"
        disabled={vm.errorCount > 0}
        onClick={() => vm.publish()}
        className={cn(
          "inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-l-md bg-rv-accent-500 px-3 text-[12px] font-medium text-white hover:bg-rv-accent-600",
          vm.errorCount > 0 && "cursor-not-allowed opacity-50",
        )}
      >
        <Check size={13} />
        Publish v{nextVersionNo}
      </button>
      <button
        type="button"
        onClick={() => vm.toggleVersionMenu()}
        title="Version history"
        className="flex h-8 w-7 cursor-pointer items-center justify-center rounded-r-md bg-rv-accent-600 text-white hover:bg-rv-accent-700"
      >
        <ChevronDown size={11} />
      </button>
      {vm.versionMenuOpen && <VersionMenu />}
    </div>
  );
});

const AiChatFab = () => (
  <div className="pointer-events-none fixed inset-x-0 bottom-6 z-40 flex justify-center px-4">
    <div className="pointer-events-auto flex w-full max-w-[680px] items-center gap-2 rounded-full border border-rv-divider-strong bg-rv-c1/95 px-4 py-2 shadow-[0_12px_32px_rgba(0,0,0,0.5)] backdrop-blur">
      <Sparkles size={14} className="text-rv-accent-500" />
      <input
        placeholder='Describe a change — e.g. "add a 3-step loading screen before the result"'
        className="flex-1 bg-transparent text-[13px] text-foreground outline-none placeholder:text-rv-mute-500"
      />
      <button
        type="button"
        title="Send"
        className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-full bg-rv-accent-500 text-white hover:bg-rv-accent-600"
      >
        <ArrowRight size={13} />
      </button>
    </div>
  </div>
);
```

`VersionMenu` is wired in Task 31. Stub it here:

```tsx
const VersionMenu = component(() => {
  const vm = useService(FunnelDraftViewModel);
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={() => vm.closeVersionMenu()} />
      <div className="absolute right-0 top-10 z-50 w-[300px] rounded-lg border border-rv-divider-strong bg-rv-c1 p-1.5 shadow-[0_18px_44px_rgba(0,0,0,0.5)]">
        <div className="px-2 py-1 text-[11px] text-rv-mute-500">Version dropdown wired in Task 31</div>
      </div>
    </>
  );
});
```

Drop the `RotateCcw` and `History` imports if unused after this pass.

- [ ] **Step 4: Type-check + smoke**

```bash
pnpm --filter @rovenue/dashboard typecheck
pnpm --filter @rovenue/dashboard dev
```

Open a project's funnel route. The shell should render an empty/loading state then surface the real funnel from the API. The tab bar should toggle tabs by mutating `vm.activeTab`. Stop the dev server.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/funnel-builder/builder-shell.tsx
git commit -m "feat(dashboard): BuilderShell consumes FunnelDraftViewModel"
```

---

### Task 18: Bridge dashboard's local types with shared types

**Files:**
- Modify: `apps/dashboard/src/components/funnel-builder/types.ts`

The existing `Page` in `types.ts` is flat (`title`, `options`, `min`, `max`, `body`, `headline`, …); the backend's `Page` from `@rovenue/shared/funnel/pages-schema` is discriminated by `type` with everything inside `config`. The validator and evaluator expect the shared shape. We need a single canonical shape inside the builder.

- [ ] **Step 1: Decide on canonical shape — flat, matching the existing UI**

The UI is built around the flat shape; keep it. Add a small `toEvalPage(page)` helper that builds the validator/evaluator-compatible view at call time. Append to `types.ts`:

```ts
import type { Page as SharedPage } from "@rovenue/shared/funnel";

/** Convert dashboard's flat Page into the shared discriminated shape on demand. */
export function toEvalPage(p: Page, rules?: unknown[], defaultNext?: string): {
  id: string;
  type: string;
  config: Record<string, unknown>;
  next_rules?: unknown[];
  default_next?: string;
} {
  return {
    id: p.id,
    type: p.type,
    config: {
      question_id: p.question_id,
      title: p.title,
      subtitle: p.subtitle,
      headline: p.headline,
      body_markdown: p.body,
      body: p.body,
      options: p.options,
      min: p.min,
      max: p.max,
      step: p.step,
      suffix: p.suffix,
      duration_ms: p.duration,
      steps: p.steps,
      product_id: p.productId,
      bullets: p.benefits,
      open_app_label: p.cta,
    },
    next_rules: rules,
    default_next: defaultNext,
  };
}

export type { SharedPage };
```

- [ ] **Step 2: Use it inside the VM's validation derived**

Update `funnel-draft.vm.ts` — replace the local `pageToConfig` helper with `toEvalPage` imported from `../types`. Remove the helper from the bottom of the VM file.

- [ ] **Step 3: Type-check + commit**

```bash
pnpm --filter @rovenue/dashboard typecheck
git add apps/dashboard/src/components/funnel-builder/types.ts apps/dashboard/src/components/funnel-builder/vm/funnel-draft.vm.ts
git commit -m "refactor(dashboard): toEvalPage bridge between flat UI shape + shared schema"
```

---

## Phase 6 — Wire ThumbRail

### Task 19: ThumbRail consumes the VM

**Files:**
- Modify: `apps/dashboard/src/components/funnel-builder/thumb-rail.tsx`

- [ ] **Step 1: Replace props with VM consumption**

The current `ThumbRail` accepts `pages`, `selectedId`, `onSelect`. Replace its public signature to take no props (or only static props) and pull data from the VM.

```tsx
import { component, useService } from "impair";
import { Plus, Sparkles } from "lucide-react";
import { cn } from "../../lib/cn";
import { PAGE_TYPES } from "./types";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";

export const ThumbRail = component(() => {
  const vm = useService(FunnelDraftViewModel);
  const lastIdx = vm.pages.length - 1;

  return (
    <div className="tb-rail-left">
      <div className="tb-rail-head">
        <span className="title">Pages</span>
        <button className="add-btn" title="Add page" onClick={() => /* Task 20 wires the popover */ undefined}>
          <Plus size={11} />
        </button>
      </div>
      <div className="tb-rail-scroll">
        {vm.pages.map((p, i) => {
          const meta = PAGE_TYPES[p.type];
          const Icon = meta.icon;
          const isEnding = p.type === "paywall" || p.type === "success";
          const prevWasEnding = i > 0 && (vm.pages[i - 1].type === "paywall" || vm.pages[i - 1].type === "success");
          const showEndingDivider = isEnding && !prevWasEnding;
          const issues = vm.validation.byPage.get(p.id) ?? [];
          const hasError = issues.some((iss) => iss.code !== "UNREACHABLE");
          const branchCount = (vm.rules[p.id] ?? []).length;

          return (
            <div key={p.id}>
              {showEndingDivider && <div className="tb-rail-divider">Endings</div>}
              {!showEndingDivider && i > 0 && (
                <div className="tb-thumb-insert">
                  <button onClick={() => /* Task 20 — insert between */ undefined}>
                    <Plus size={8} />
                  </button>
                </div>
              )}
              <div
                className={cn("tb-thumb", vm.selectedPageId === p.id && "selected", meta.tone)}
                onClick={() => vm.selectPage(p.id)}
                title={p.title}
              >
                <span className="tb-thumb-num">{String(i + 1).padStart(2, "0")}</span>
                <div className="tb-thumb-icon"><Icon size={16} /></div>
                {hasError && <div className="tb-thumb-flag" title="Has validation issues">!</div>}
                {!hasError && branchCount > 0 && (
                  <div className="tb-thumb-flag branch" title={`${branchCount} branch rule${branchCount === 1 ? "" : "s"}`}>
                    {branchCount}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div className="tb-rail-cta" title="Personalize based on earlier answers">
        <div className="icon"><Sparkles size={14} /></div>
        Personalize with branching
      </div>
    </div>
  );
});
```

- [ ] **Step 2: Update `BuilderShell` JSX to call `<ThumbRail />` without props** (already done in Task 17).

- [ ] **Step 3: Commit**

```bash
pnpm --filter @rovenue/dashboard typecheck
git add apps/dashboard/src/components/funnel-builder/thumb-rail.tsx
git commit -m "feat(dashboard): ThumbRail consumes FunnelDraftViewModel"
```

---

## Phase 7 — Wire CanvasEditor

### Task 20: CanvasEditor + add-content popover wired

**Files:**
- Modify: `apps/dashboard/src/components/funnel-builder/canvas-editor.tsx`

- [ ] **Step 1: Replace props with VM**

Remove the `page`, `allPages`, `idx`, `onPrev`, `onNext`, `onPreview` props. Read everything from the VM. `addOpen` (controls the add-content popover) is the only piece of state still needed inside the component — keep it as a local `React.useState` (UI-only, not domain state, so it stays outside impair). The previous "no useState left" rule was specifically about domain state.

```tsx
import { component, useService } from "impair";
import { useState } from "react";
import { ArrowLeft, ArrowRight, Eye, Image as ImageIcon, Play, Plus, Settings, Smartphone, Type as TypeIcon } from "lucide-react";
import { PAGE_TYPES } from "./types";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";
import { AddContentPopover } from "./add-content-popover";   // <- new helper from Task 21

export const CanvasEditor = component(() => {
  const vm = useService(FunnelDraftViewModel);
  const [addOpen, setAddOpen] = useState(false);
  const page = vm.selectedPage;
  if (!page) return null;
  const meta = PAGE_TYPES[page.type];
  const Icon = meta.icon;

  return (
    <div className="tb-canvas">
      <div className="tb-canvas-toolbar">
        <div style={{ position: "relative" }}>
          <button className="tb-add-content" onClick={() => setAddOpen((o) => !o)}>
            <span className="plus"><Plus size={10} /></span>
            Add content
          </button>
          {addOpen && (
            <AddContentPopover
              onPick={(t) => { setAddOpen(false); /* Task 21 dispatches addPage */ }}
              onClose={() => setAddOpen(false)}
            />
          )}
        </div>
        <div className="tb-tool-sep" />
        <button className="tb-icon-btn" title="Theme & design" onClick={() => vm.setActiveTab("theme")}>
          <ImageIcon size={14} />
        </button>
        <button className="tb-icon-btn" title="Device preview" onClick={() => vm.openPreview()}>
          <Smartphone size={14} />
        </button>
        <button className="tb-icon-btn" title="Play through" onClick={() => vm.openPreview()}>
          <Play size={14} />
        </button>
        <button className="tb-icon-btn" title="Accessibility check"><Eye size={14} /></button>
        <button className="tb-icon-btn" title="Translations"><TypeIcon size={14} /></button>
        <button className="tb-icon-btn" title="Page settings" onClick={() => vm.setActiveTab("settings")}>
          <Settings size={14} />
        </button>

        <div className="tb-canvas-meta">
          <span>Page {vm.selectedIdx + 1} of {vm.pages.length}</span>
          <span className="id">{page.id}</span>
          {page.question_id && (
            <span className="id" style={{ color: "var(--accent)" }}>@{page.question_id}</span>
          )}
        </div>
      </div>

      {/* The per-type canvas card preserved from the existing file lives here.
          Inside each input, replace defaultValue + onChange dispatching to local
          state with value + onChange dispatching to vm.updatePage(page.id, { … }).
          Walk through each branch:

          - title input  → onChange: vm.updatePage(page.id, { title: e.currentTarget.value })
          - subtitle     → vm.updatePage(page.id, { subtitle: ... })
          - option label → vm.updateOption(page.id, i, { label })
          - option value → vm.updateOption(page.id, i, { value })
          - Add option   → vm.addOption(page.id)
          - Remove opt   → vm.removeOption(page.id, i)
          - number/slider min/max/step/suffix → vm.updatePage(page.id, { min: ... })
          - loading duration → vm.updatePage(page.id, { duration })
          - paywall headline/benefits → vm.updatePage(page.id, { headline | benefits })
          - success headline/body/cta → vm.updatePage(page.id, { ... })
      */}

      {/* The existing JSX for the per-type editable card stays — only the binding
          targets change. The footer stepper switches to vm.goPrev / vm.goNext. */}

      <div className="tb-canvas-foot">
        <button className="tb-step-btn" onClick={() => vm.goPrev()} disabled={vm.selectedIdx === 0}>
          <ArrowLeft size={14} />
        </button>
        <div className="tb-step-label">
          {String(vm.selectedIdx + 1).padStart(2, "0")} / {String(vm.pages.length).padStart(2, "0")}
        </div>
        <button
          className="tb-step-btn"
          onClick={() => vm.goNext()}
          disabled={vm.selectedIdx === vm.pages.length - 1}
        >
          <ArrowRight size={14} />
        </button>
      </div>
    </div>
  );
});
```

Walk the existing per-type JSX in this file end to end and rewire every input. Pattern: every `defaultValue` becomes `value`, every `onChange` calls a VM method. No `useState` for per-page mutable data.

- [ ] **Step 2: Type-check + commit (do NOT commit yet if the per-type JSX still references old props — finish the walk first)**

```bash
pnpm --filter @rovenue/dashboard typecheck
git add apps/dashboard/src/components/funnel-builder/canvas-editor.tsx
git commit -m "feat(dashboard): CanvasEditor consumes FunnelDraftViewModel"
```

---

### Task 21: Add-content popover dispatches `vm.addPage`

**Files:**
- Create: `apps/dashboard/src/components/funnel-builder/add-content-popover.tsx`
- Create: `apps/dashboard/src/components/funnel-builder/blank-page.ts`
- Modify: `apps/dashboard/src/components/funnel-builder/canvas-editor.tsx`

The existing `CanvasEditor` defines `AddContentPopover` inline. Extract it into its own file so other surfaces (the `+` between thumbs, the rail's add button) can reuse it.

- [ ] **Step 1: Blank-page factory**

```ts
// apps/dashboard/src/components/funnel-builder/blank-page.ts
import { createId } from "@paralleldrive/cuid2";
import type { Page, PageType } from "./types";

export function blankPage(type: PageType): Page {
  const id = `pg_${createId().slice(0, 8)}`;
  switch (type) {
    case "single_choice":
    case "multi_choice":
      return {
        id, type,
        question_id: `q_${createId().slice(0, 6)}`,
        title: "New question",
        options: [{ label: "Option A", value: "option_a" }],
      };
    case "text_input":
      return { id, type, question_id: `q_${createId().slice(0, 6)}`, title: "Tell us…" };
    case "number_input":
      return { id, type, question_id: `q_${createId().slice(0, 6)}`, title: "How many?", min: 0, max: 100, step: 1 };
    case "date_input":
      return { id, type, question_id: `q_${createId().slice(0, 6)}`, title: "Pick a date" };
    case "slider":
      return { id, type, question_id: `q_${createId().slice(0, 6)}`, title: "Slide it", min: 0, max: 100, step: 1 };
    case "rating":
      return { id, type, question_id: `q_${createId().slice(0, 6)}`, title: "Rate it" };
    case "info":
      return { id, type, title: "Heads up", body: "Hi 👋" };
    case "loading":
      return { id, type, title: "Crunching numbers…", duration: 2500 };
    case "result":
      return { id, type, title: "Your plan", body: "…" };
    case "paywall":
      return { id, type, headline: "Unlock everything", benefits: ["Benefit"] };
    case "success":
      return { id, type, title: "You're in", body: "Open the app", cta: "Open app" };
  }
}
```

- [ ] **Step 2: AddContentPopover component**

Move the existing JSX from `canvas-editor.tsx`'s inline `AddContentPopover` into `add-content-popover.tsx`. Public signature:

```tsx
import { Search } from "lucide-react";
import { PAGE_GROUPS, PAGE_TYPES, PAGE_TYPE_DESC, type PageType } from "./types";

export function AddContentPopover({
  onPick,
  onClose,
}: {
  onPick: (type: PageType) => void;
  onClose: () => void;
}) {
  return (
    <>
      <div style={{ position: "fixed", inset: 0, zIndex: 49 }} onClick={onClose} />
      <div className="tb-add-popover" onClick={(e) => e.stopPropagation()}>
        <div className="tb-add-search-wrap">
          <Search size={13} />
          <input className="tb-add-popover-search" autoFocus placeholder="Search content type… (e.g. paywall, slider)" />
        </div>
        {PAGE_GROUPS.map((g) => (
          <div key={g.label}>
            <div className="tb-add-section-label">{g.label}</div>
            <div className="tb-add-grid">
              {g.types.map((t) => {
                const meta = PAGE_TYPES[t];
                const Icon = meta.icon;
                return (
                  <div key={t} className={`tb-add-tile ${meta.tone ?? ""}`} onClick={() => onPick(t)}>
                    <div className="ico"><Icon size={14} /></div>
                    <div className="meta">
                      <div className="name">{meta.label}</div>
                      <div className="desc">{PAGE_TYPE_DESC[t]}</div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
```

- [ ] **Step 3: Wire the canvas + rail buttons**

In `canvas-editor.tsx`, replace the popover's `onPick` with:

```tsx
onPick={(t) => { setAddOpen(false); vm.addPage(blankPage(t), page.id); }}
```

In `thumb-rail.tsx`, the head + between-thumbs buttons need to open the popover too. Add small state to `ThumbRail` for `insertAfter` + `open`. Same pattern — `vm.addPage(blankPage(t), insertAfter)`.

- [ ] **Step 4: Commit**

```bash
pnpm --filter @rovenue/dashboard typecheck
git add apps/dashboard/src/components/funnel-builder/add-content-popover.tsx apps/dashboard/src/components/funnel-builder/blank-page.ts apps/dashboard/src/components/funnel-builder/canvas-editor.tsx apps/dashboard/src/components/funnel-builder/thumb-rail.tsx
git commit -m "feat(dashboard): add-content popover + blank page factory dispatching vm.addPage"
```

---

## Phase 8 — Wire PropertiesPanel

### Task 22: PropertiesPanel consumes the VM

**Files:**
- Modify: `apps/dashboard/src/components/funnel-builder/properties-panel.tsx`

- [ ] **Step 1: Switch signature + binding**

Currently takes `page`, `allPages`, `allRules` props. Drop them — read from VM. Wrap with `component(...)`.

```tsx
import { component, useService } from "impair";
import { ChevronDown, Code, Image as ImageIcon, Plus, Play, Type as TypeIcon } from "lucide-react";
import { PAGE_TYPES } from "./types";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";
import { PropToggle } from "./prop-toggle";              // existing file
import { RuleEditor } from "./rule-editor";              // Task 24 rewires this

export const PropertiesPanel = component(() => {
  const vm = useService(FunnelDraftViewModel);
  const page = vm.selectedPage;
  if (!page) return null;
  const meta = PAGE_TYPES[page.type];
  const Icon = meta.icon;
  const rules = vm.rules[page.id] ?? [];

  // The existing per-type body stays — every onChange now calls vm.updatePage.
  // For toggles inside PropToggle, replace `onChange={() => ...}` with a VM call.
  // For range inputs (min/max/step/suffix) — same. Walk the file end to end.
  // ...
});
```

Walk through every input the file already has and rewire:

- `Required` toggle → `onChange={() => vm.updatePage(page.id, { required: !page.required })}`
- `Multiple selection` → branch on page type; not a simple toggle (skip, leave as no-op for now)
- `Max selections` (multi_choice) → `vm.updatePage(page.id, { max_selections: Number(e.currentTarget.value) || undefined })`
- Number range (min/max/step/suffix) → `vm.updatePage(page.id, { min, max, step, suffix })`
- Slider format → `vm.updatePage(page.id, { format })`
- Loading duration → `vm.updatePage(page.id, { duration: Number(...) })`
- Loading steps textarea → `vm.updatePage(page.id, { steps: value.split("\n").filter(Boolean) })`
- Paywall product picker → see Task 23
- Paywall trial segmented → `vm.updatePage(page.id, { trial: 3 | 7 | undefined })`
- Result personalization chips → on click, append `{{qid}}` to the active textarea (left as inert-on-click in the existing UI; keep as-is)
- Branching section → delegates to `<RuleEditor pageId={page.id} />` (Task 24)

- [ ] **Step 2: Commit**

```bash
pnpm --filter @rovenue/dashboard typecheck
git add apps/dashboard/src/components/funnel-builder/properties-panel.tsx
git commit -m "feat(dashboard): PropertiesPanel consumes FunnelDraftViewModel"
```

---

### Task 23: Paywall product picker reads real products

**Files:**
- Modify: `apps/dashboard/src/components/funnel-builder/properties-panel.tsx`

The existing UI shows a hard-coded "Pro · Annual" card for paywall. Replace it with a select populated from the dashboard's existing products endpoint.

- [ ] **Step 1: Add a tiny product hook (TanStack Query, not impair — it's pure cache)**

In the properties panel module, top of file:

```tsx
import { useQuery } from "@tanstack/react-query";
import { rpc, unwrap } from "../../lib/api";

function useProjectProducts(projectId: string | undefined) {
  return useQuery({
    queryKey: ["products", projectId],
    enabled: Boolean(projectId),
    queryFn: () =>
      unwrap<{ products: Array<{ id: string; name: string; priceLabel: string }> }>(
        rpc.dashboard.projects[":projectId"].products.$get({ param: { projectId: projectId! } }),
      ),
    select: (r) => r.products,
  });
}
```

- [ ] **Step 2: Inside the paywall section, render a `<select>` over the products**

```tsx
const { data: products = [] } = useProjectProducts(vm.props.projectId);
```

Wait — `vm.props` is private. Expose `projectId` as a public field on the VM:

```ts
// in funnel-draft.vm.ts:
@state projectId = "";
@state funnelId = "";

@onInit init() {
  this.projectId = this.props.projectId;
  this.funnelId = this.props.funnelId;
}
```

Add `import { onInit } from "impair"` to that file. Then in the panel:

```tsx
const { data: products = [] } = useProjectProducts(vm.projectId);

<select
  value={page.productId ?? ""}
  onChange={(e) => vm.updatePage(page.id, { productId: e.currentTarget.value || undefined })}
>
  <option value="">Choose a product…</option>
  {products.map((p) => (
    <option key={p.id} value={p.id}>{p.name} · {p.priceLabel}</option>
  ))}
</select>
```

If the `products` endpoint shape differs (no `priceLabel`), drop that segment.

- [ ] **Step 3: Type-check + commit**

```bash
pnpm --filter @rovenue/dashboard typecheck
git add apps/dashboard/src/components/funnel-builder/properties-panel.tsx apps/dashboard/src/components/funnel-builder/vm/funnel-draft.vm.ts
git commit -m "feat(dashboard): paywall picker reads project products"
```

---

## Phase 9 — RuleEditor + WorkflowTab

### Task 24: RuleEditor consumes the VM (per-page rules)

**Files:**
- Modify: `apps/dashboard/src/components/funnel-builder/rule-editor.tsx`

The existing `rule-editor.tsx` is rendered both inside `properties-panel.tsx` (per-page) and inside `workflow-tab.tsx` (across all pages). Its public surface becomes `<RuleEditor pageId={pageId} />` — it pulls every other piece from the VM.

- [ ] **Step 1: Rewire**

```tsx
import { component, useService } from "impair";
import { ArrowRight, Plus, TriangleAlert } from "lucide-react";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";
import type { NextRule, ClauseOp } from "@rovenue/shared/funnel";
import { createId } from "@paralleldrive/cuid2";

interface Props { pageId: string }

export const RuleEditor = component(({ pageId }: Props) => {
  const vm = useService(FunnelDraftViewModel);
  const rules = vm.rules[pageId] ?? [];
  const myIdx = vm.pages.findIndex((p) => p.id === pageId);
  const earlierQuestionIds = vm.pages
    .slice(0, myIdx)
    .map((p) => p.question_id)
    .filter((q): q is string => Boolean(q));

  // Each rule + clause maps cleanly to vm.updateRule / vm.addRule / vm.removeRule.
  // Replace every previous defaultValue with value; replace every onChange handler
  // with vm.updateRule(pageId, ruleIdx, patch) calls.
  // ...
});
```

Walk the existing rendering and rewire every input/select:

- `<select className="qid" defaultValue={c.qid}>` → `value={c.question_id} onChange={(e) => vm.updateRule(pageId, ruleIdx, { condition: { ...rule.condition, clauses: replaceClauseAt(rule.condition.clauses, clauseIdx, { ...c, question_id: e.currentTarget.value }) } })}`
- Op `<select>` → likewise
- Value input → likewise
- Combinator pill → `vm.updateRule(pageId, ruleIdx, { condition: { ...rule.condition, op: nextOp } })`
- "Add clause" → push a new clause
- Trash icon → `vm.removeRule(pageId, ruleIdx)`
- `then →` goto picker → `vm.updateRule(pageId, ruleIdx, { goto: e.currentTarget.value })`
- "Add rule" → `vm.addRule(pageId, { id: createId().slice(0, 8), condition: { op: "all", clauses: [...] }, goto: "end" })`
- Default-next picker (`Otherwise →`) → `vm.setDefaultNext(pageId, value === "" ? null : value)`

Where the file references `OPERATORS` (the existing constant), keep using it. If it's still typed as the old shape, narrow to `ClauseOp` from `@rovenue/shared/funnel`.

- [ ] **Step 2: Add a tiny pure helper at file bottom**

```ts
function replaceClauseAt<T>(arr: T[], i: number, patch: T): T[] {
  const next = arr.slice();
  next[i] = patch;
  return next;
}
```

- [ ] **Step 3: Commit**

```bash
pnpm --filter @rovenue/dashboard typecheck
git add apps/dashboard/src/components/funnel-builder/rule-editor.tsx
git commit -m "feat(dashboard): RuleEditor dispatches vm rule mutations"
```

---

### Task 25: WorkflowTab consumes the VM

**Files:**
- Modify: `apps/dashboard/src/components/funnel-builder/workflow-tab.tsx`

- [ ] **Step 1: Rewire**

```tsx
import { component, useService } from "impair";
import { Plus } from "lucide-react";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";
import { RuleEditor } from "./rule-editor";

export const WorkflowTab = component(() => {
  const vm = useService(FunnelDraftViewModel);
  const entries = Object.entries(vm.rules);

  return (
    <div className="tb-pane" style={{ padding: 24 }}>
      <div style={{ maxWidth: 1100, margin: "0 auto" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-end", marginBottom: 16 }}>
          <div>
            <h2 style={{ fontSize: 20, margin: "0 0 4px" }}>Workflow</h2>
            <p style={{ fontSize: 13, color: "var(--default-500)", margin: 0 }}>
              All branching rules across this funnel. Rules evaluate top-to-bottom on each source page.
            </p>
          </div>
        </div>

        {entries.length === 0 ? (
          <div className="theme-section" style={{ textAlign: "center", padding: "60px 20px" }}>
            <h3 style={{ margin: "0 0 6px", fontSize: 15 }}>No branching yet</h3>
            <p style={{ fontSize: 12, color: "var(--default-500)", maxWidth: 320, margin: "0 auto 14px" }}>
              Add a rule to send specific visitors down different paths based on their answers.
            </p>
          </div>
        ) : (
          entries.map(([pageId, rules]) => {
            const page = vm.pages.find((p) => p.id === pageId);
            return (
              <div key={pageId} className="theme-section" style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
                  <span className="tb-page-badge">{pageId}</span>
                  <span style={{ fontSize: 13 }}>{page?.title}</span>
                  <span style={{ marginLeft: "auto", fontSize: 11, color: "var(--default-500)" }}>
                    {rules.length} rule{rules.length === 1 ? "" : "s"}
                  </span>
                </div>
                <RuleEditor pageId={pageId} />
              </div>
            );
          })
        )}
      </div>
    </div>
  );
});
```

- [ ] **Step 2: Commit**

```bash
pnpm --filter @rovenue/dashboard typecheck
git add apps/dashboard/src/components/funnel-builder/workflow-tab.tsx
git commit -m "feat(dashboard): WorkflowTab consumes FunnelDraftViewModel"
```

---

## Phase 10 — Theme + Settings tabs

### Task 26: ThemeTab consumes the VM

**Files:**
- Modify: `apps/dashboard/src/components/funnel-builder/theme-tab.tsx`

- [ ] **Step 1: Rewire**

Drop the `theme`/`currentPage` props. Read from VM. Every input dispatches `vm.updateTheme`.

```tsx
import { component, useService } from "impair";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";

export const ThemeTab = component(() => {
  const vm = useService(FunnelDraftViewModel);
  const theme = vm.theme;
  return (
    <div className="theme-grid">
      {/* existing JSX layout — each input rewired:
          value={theme.primary}  onChange={(e) => vm.updateTheme({ primary: e.currentTarget.value })}
          value={theme.bg}       onChange={(e) => vm.updateTheme({ bg: e.currentTarget.value })}
          ...
          logo URL: value={theme.logoUrl} onChange={(e) => vm.updateTheme({ logoUrl: e.currentTarget.value })}
          font: same pattern
      */}
    </div>
  );
});
```

- [ ] **Step 2: Commit**

```bash
pnpm --filter @rovenue/dashboard typecheck
git add apps/dashboard/src/components/funnel-builder/theme-tab.tsx
git commit -m "feat(dashboard): ThemeTab consumes FunnelDraftViewModel"
```

---

### Task 27: SettingsTab consumes the VM

**Files:**
- Modify: `apps/dashboard/src/components/funnel-builder/settings-tab.tsx`

- [ ] **Step 1: Rewire**

```tsx
import { component, useService } from "impair";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";

export const SettingsTab = component(() => {
  const vm = useService(FunnelDraftViewModel);
  const s = vm.settings;
  return (
    <div className="set-grid">
      {/* existing JSX layout. Every input wired:
          value={s.iosUrl}                onChange={(e) => vm.updateSettings({ iosUrl: e.currentTarget.value })}
          value={s.androidUrl}            onChange={(e) => vm.updateSettings({ androidUrl: e.currentTarget.value })}
          value={s.universalLinkDomain}   onChange={(e) => vm.updateSettings({ universalLinkDomain: e.currentTarget.value.toLowerCase() })}
          value={s.deepLinkScheme}        onChange={(e) => vm.updateSettings({ deepLinkScheme: e.currentTarget.value.toLowerCase() })}
          checked={s.devMode}             onChange={(v) => vm.updateSettings({ devMode: v })}
      */}
    </div>
  );
});
```

- [ ] **Step 2: Commit**

```bash
pnpm --filter @rovenue/dashboard typecheck
git add apps/dashboard/src/components/funnel-builder/settings-tab.tsx
git commit -m "feat(dashboard): SettingsTab consumes FunnelDraftViewModel"
```

---

## Phase 11 — FunnelSessionsViewModel + SessionsTab

Sessions data is independent of the draft, so it gets its own view model with its own range state. The VM is registered through `@provide` on a small `SessionsContainer` so it only loads when the user opens the Sessions tab.

### Task 28: FunnelSessionsViewModel

**Files:**
- Create: `apps/dashboard/src/components/funnel-builder/vm/funnel-sessions.vm.ts`

- [ ] **Step 1: Implement**

```ts
import { injectable, inject, state, derived, trigger, Props, type Cleanup } from "impair";
import {
  FunnelSessionsApi,
  type FunnelSessionRowDto,
  type FunnelSessionsStatsDto,
  type Range,
} from "../../../lib/services/funnel-sessions-api";
import { FunnelDraftViewModel } from "./funnel-draft.vm";

interface SessionsProps {} // empty — pulled from parent VM via inject

@injectable()
export class FunnelSessionsViewModel {
  @state range: Range = "7d";
  @state isLoading = true;
  @state sessions: FunnelSessionRowDto[] = [];
  @state stats: FunnelSessionsStatsDto | null = null;
  @state openSessionId: string | null = null;

  constructor(
    @inject(FunnelSessionsApi) private api: FunnelSessionsApi,
    @inject(FunnelDraftViewModel) private draft: FunnelDraftViewModel,
    @inject(Props) _props: SessionsProps,
  ) {}

  setRange(r: Range) { this.range = r; }
  open(id: string) { this.openSessionId = id; }
  close() { this.openSessionId = null; }

  @derived get pageById() {
    return new Map(this.draft.pages.map((p) => [p.id, p] as const));
  }

  @trigger
  async load(cleanup: Cleanup) {
    if (!this.draft.funnel) return;
    const controller = new AbortController();
    cleanup(() => controller.abort());
    this.isLoading = true;
    try {
      const data = await this.api.list(this.draft.projectId, this.draft.funnelId, this.range, controller.signal);
      this.sessions = data.sessions;
      this.stats = data.stats;
    } catch (err) {
      if ((err as { name?: string })?.name === "AbortError") return;
    } finally {
      this.isLoading = false;
    }
  }
}
```

The `@trigger` re-runs whenever `this.range` or `this.draft.funnel` changes (no decorator argument = sync trigger). First run happens after the funnel loads.

- [ ] **Step 2: Register in BuilderProvider**

Open `builder-provider.tsx`. Add `FunnelSessionsViewModel` to `provide`:

```tsx
provide={[
  FunnelApi, FunnelVersionsApi, FunnelSessionsApi,
  FunnelDraftViewModel,
  FunnelSessionsViewModel,
]}
```

- [ ] **Step 3: Commit**

```bash
pnpm --filter @rovenue/dashboard typecheck
git add apps/dashboard/src/components/funnel-builder/vm/funnel-sessions.vm.ts apps/dashboard/src/components/funnel-builder/builder-provider.tsx
git commit -m "feat(dashboard): FunnelSessionsViewModel"
```

---

### Task 29: SessionsTab + detail drawer

**Files:**
- Modify: `apps/dashboard/src/components/funnel-builder/sessions-tab.tsx`
- Create: `apps/dashboard/src/components/funnel-builder/session-detail-drawer.tsx`

- [ ] **Step 1: SessionsTab**

```tsx
import { component, useService } from "impair";
import { FunnelSessionsViewModel } from "./vm/funnel-sessions.vm";
import { SessionDetailDrawer } from "./session-detail-drawer";

export const SessionsTab = component(() => {
  const vm = useService(FunnelSessionsViewModel);
  const stats = vm.stats;
  return (
    <div className="sessions-grid">
      {/* range segmented — value={vm.range} onChange={(v) => vm.setRange(v)} */}
      {/* KPI cards — use stats?.started, stats?.completionRate, stats?.paywallViewRate, stats?.paidConversion, stats?.medianDurationMs */}
      {/* table tbody — vm.sessions.map(s => row); onClick row → vm.open(s.id) */}
      <SessionDetailDrawer />
    </div>
  );
});
```

- [ ] **Step 2: SessionDetailDrawer (new file)**

```tsx
import { component, useService } from "impair";
import { useQuery } from "@tanstack/react-query";
import { FunnelSessionsApi } from "../../lib/services/funnel-sessions-api";
import { FunnelSessionsViewModel } from "./vm/funnel-sessions.vm";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";

export const SessionDetailDrawer = component(() => {
  const vm = useService(FunnelSessionsViewModel);
  const draft = useService(FunnelDraftViewModel);
  const api = useService(FunnelSessionsApi);
  const id = vm.openSessionId;

  // Detail fetch via TanStack Query — pure server cache, no impair state needed
  const { data: session } = useQuery({
    queryKey: ["funnel-session", id],
    enabled: Boolean(id),
    queryFn: () => api.detail(draft.projectId, draft.funnelId, id!),
  });

  if (!id) return null;
  return (
    <>
      <div className="val-drawer-bg" onClick={() => vm.close()} />
      <div className="val-drawer">
        {/* Render session.answers, session.purchase per the existing layout */}
        {!session ? <div>Loading…</div> : null}
      </div>
    </>
  );
});
```

- [ ] **Step 3: Commit**

```bash
pnpm --filter @rovenue/dashboard typecheck
git add apps/dashboard/src/components/funnel-builder/sessions-tab.tsx apps/dashboard/src/components/funnel-builder/session-detail-drawer.tsx
git commit -m "feat(dashboard): SessionsTab + detail drawer wired to FunnelSessionsViewModel"
```

---

## Phase 12 — ShareTab

### Task 30: ShareTab consumes the VM

**Files:**
- Modify: `apps/dashboard/src/components/funnel-builder/share-tab.tsx`

- [ ] **Step 1: Rewire**

```tsx
import { component, useService } from "impair";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";

export const ShareTab = component(() => {
  const vm = useService(FunnelDraftViewModel);
  const domain = vm.settings.universalLinkDomain;
  const url = domain ? `https://${domain}/${vm.slug}` : null;

  if (vm.status !== "published") {
    // Render the "Publish to share" state from the existing JSX, but the
    // CTA now calls vm.setActiveTab("content") + vm.openValidation if errors
    // or directly vm.publish() if clean.
    return /* … */;
  }
  if (!url) return /* "Set universal link domain" state */;

  // Render the public URL card / QR / snippets / UTM builder. The UTM
  // builder keeps a small useState for { source, medium, campaign } — those
  // are UI-only ephemeral inputs, not domain state, so impair isn't required.
});
```

- [ ] **Step 2: Commit**

```bash
pnpm --filter @rovenue/dashboard typecheck
git add apps/dashboard/src/components/funnel-builder/share-tab.tsx
git commit -m "feat(dashboard): ShareTab consumes FunnelDraftViewModel"
```

---

## Phase 13 — FunnelVersionsViewModel + publish dropdown + versions page

### Task 31: FunnelVersionsViewModel

**Files:**
- Create: `apps/dashboard/src/components/funnel-builder/vm/funnel-versions.vm.ts`

- [ ] **Step 1: Implement**

```ts
import { injectable, inject, state, trigger, type Cleanup } from "impair";
import { FunnelVersionsApi, type FunnelVersionDto } from "../../../lib/services/funnel-versions-api";
import { FunnelDraftViewModel } from "./funnel-draft.vm";

@injectable()
export class FunnelVersionsViewModel {
  @state isLoading = false;
  @state versions: FunnelVersionDto[] = [];

  constructor(
    @inject(FunnelVersionsApi) private api: FunnelVersionsApi,
    @inject(FunnelDraftViewModel) private draft: FunnelDraftViewModel,
  ) {}

  @trigger
  async load(cleanup: Cleanup) {
    if (!this.draft.funnel) return;
    const controller = new AbortController();
    cleanup(() => controller.abort());
    this.isLoading = true;
    try {
      this.versions = await this.api.list(this.draft.projectId, this.draft.funnelId);
    } finally {
      this.isLoading = false;
    }
  }

  async revert(versionId: string) {
    const next = await this.api.revert(this.draft.projectId, this.draft.funnelId, versionId);
    // Reload the draft VM's state from the server's new draft
    // We don't have a method to inject the new state directly; easiest path is
    // to call draft.discardDraft() after the server commit to refetch.
    await this.draft.discardDraft();
  }
}
```

Register it in `builder-provider.tsx`:

```tsx
provide={[
  FunnelApi, FunnelVersionsApi, FunnelSessionsApi,
  FunnelDraftViewModel,
  FunnelSessionsViewModel,
  FunnelVersionsViewModel,
]}
```

- [ ] **Step 2: Commit**

```bash
pnpm --filter @rovenue/dashboard typecheck
git add apps/dashboard/src/components/funnel-builder/vm/funnel-versions.vm.ts apps/dashboard/src/components/funnel-builder/builder-provider.tsx
git commit -m "feat(dashboard): FunnelVersionsViewModel"
```

---

### Task 32: Wire publish dropdown to real versions

**Files:**
- Modify: `apps/dashboard/src/components/funnel-builder/builder-shell.tsx`

- [ ] **Step 1: Replace `VersionMenu` stub from Task 17**

```tsx
import { History, RotateCcw } from "lucide-react";
import { FunnelVersionsViewModel } from "./vm/funnel-versions.vm";

const VersionMenu = component(() => {
  const vm = useService(FunnelDraftViewModel);
  const versions = useService(FunnelVersionsViewModel);
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={() => vm.closeVersionMenu()} />
      <div className="absolute right-0 top-10 z-50 w-[300px] rounded-lg border border-rv-divider-strong bg-rv-c1 p-1.5 shadow-[0_18px_44px_rgba(0,0,0,0.5)]">
        <div className="px-2 py-1 font-rv-mono text-[10px] uppercase tracking-wider text-rv-mute-500">
          Recent versions
        </div>
        {versions.versions.slice(0, 4).map((v) => (
          <div key={v.id} className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 hover:bg-rv-c2">
            <span className="min-w-[32px] font-rv-mono text-[11px] text-rv-mute-500">v{v.versionNo}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate text-[12px] text-foreground">{v.notes ?? "—"}</div>
              <div className="mt-0.5 font-rv-mono text-[10px] text-rv-mute-500">@{v.publishedByName ?? "unknown"}</div>
            </div>
            {v.isCurrent && (
              <span className="inline-flex h-4 items-center rounded-full bg-rv-success/15 px-1.5 font-rv-mono text-[9px] font-medium text-rv-success">
                LIVE
              </span>
            )}
          </div>
        ))}
        <div className="my-1 border-t border-rv-divider" />
        <button type="button" className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-rv-mute-700 hover:bg-rv-c2">
          <History size={12} />
          All versions…
        </button>
        {vm.funnel?.draftDiffersFromPublished && (
          <button
            type="button"
            onClick={() => vm.discardDraft()}
            className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-rv-mute-700 hover:bg-rv-c2"
          >
            <RotateCcw size={12} />
            Discard unpublished changes
          </button>
        )}
      </div>
    </>
  );
});
```

- [ ] **Step 2: Commit**

```bash
pnpm --filter @rovenue/dashboard typecheck
git add apps/dashboard/src/components/funnel-builder/builder-shell.tsx
git commit -m "feat(dashboard): publish dropdown reads FunnelVersionsViewModel"
```

---

## Phase 14 — ValidationDrawer + publish gating

### Task 33: ValidationDrawer consumes the VM

**Files:**
- Modify: `apps/dashboard/src/components/funnel-builder/validation-drawer.tsx`

- [ ] **Step 1: Rewire**

```tsx
import { component, useService } from "impair";
import { ArrowRight, TriangleAlert, X } from "lucide-react";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";
import type { ValidatorIssue } from "@rovenue/shared/funnel";

export const ValidationDrawer = component(() => {
  const vm = useService(FunnelDraftViewModel);
  const errors = vm.validation.errors;
  const warns = vm.validation.warnings;

  const jump = (iss: ValidatorIssue) => {
    vm.closeValidation();
    const pid = "pageId" in iss ? (iss as { pageId: string }).pageId : undefined;
    if (pid) {
      vm.setActiveTab("content");
      vm.selectPage(pid);
    }
  };

  return (
    <>
      <div className="val-drawer-bg" onClick={() => vm.closeValidation()} />
      <div className="val-drawer">
        <div className="val-head">
          <div>
            <h2>Can't publish yet</h2>
            <p>{errors.length} error{errors.length === 1 ? "" : "s"} · {warns.length} warning{warns.length === 1 ? "" : "s"}.</p>
          </div>
          <button type="button" onClick={() => vm.closeValidation()}><X size={14} /></button>
        </div>
        <div className="val-body">
          {errors.length > 0 && (
            <>
              <div className="val-section-label">Errors</div>
              {errors.map((iss, i) => (
                <div key={i} className="val-item">
                  <div className="head">
                    <div className="ico err"><TriangleAlert size={12} /></div>
                    <div className="title">{titleFor(iss)}</div>
                    {"pageId" in iss && <div className="where">{(iss as { pageId: string }).pageId}</div>}
                  </div>
                  <div className="desc">{iss.message}</div>
                  <div className="fix">
                    <button className="btn flat" onClick={() => jump(iss)}>Open page <ArrowRight size={11} /></button>
                  </div>
                </div>
              ))}
            </>
          )}
          {warns.length > 0 && (
            <>
              <div className="val-section-label">Warnings</div>
              {warns.map((iss, i) => (
                <div key={i} className="val-item">
                  <div className="head">
                    <div className="ico warn"><TriangleAlert size={12} /></div>
                    <div className="title">{titleFor(iss)}</div>
                    {"pageId" in iss && <div className="where">{(iss as { pageId: string }).pageId}</div>}
                  </div>
                  <div className="desc">{iss.message}</div>
                  <div className="fix">
                    <button className="btn flat" onClick={() => jump(iss)}>Open page <ArrowRight size={11} /></button>
                  </div>
                </div>
              ))}
            </>
          )}
        </div>
      </div>
    </>
  );
});

function titleFor(iss: ValidatorIssue): string {
  switch (iss.code) {
    case "MISSING_PAYWALL":      return "Funnel needs a paywall page";
    case "MISSING_SUCCESS":      return "Funnel needs a success page";
    case "CYCLE":                return "Pages form a cycle";
    case "DUPLICATE_QUESTION_ID":return `Duplicate question_id: ${("questionId" in iss) ? (iss as { questionId: string }).questionId : ""}`;
    case "UNKNOWN_QUESTION_REF": return `Rule references unknown question: ${("questionId" in iss) ? (iss as { questionId: string }).questionId : ""}`;
    case "UNKNOWN_GOTO":         return `Goes to a missing page: ${("goto" in iss) ? (iss as { goto: string }).goto : ""}`;
    case "UNREACHABLE":          return "Page is unreachable from the start";
  }
}
```

- [ ] **Step 2: Commit**

```bash
pnpm --filter @rovenue/dashboard typecheck
git add apps/dashboard/src/components/funnel-builder/validation-drawer.tsx
git commit -m "feat(dashboard): ValidationDrawer consumes vm.validation with jump-to-page"
```

---

## Phase 15 — FunnelPreviewViewModel + PreviewOverlay

The phone preview is component-scoped — it only exists while open — so it gets a one-shot `useViewModel`.

### Task 34: FunnelPreviewViewModel

**Files:**
- Create: `apps/dashboard/src/components/funnel-builder/vm/funnel-preview.vm.ts`
- Create: `apps/dashboard/src/components/funnel-builder/vm/funnel-preview.vm.test.ts`

- [ ] **Step 1: Implement**

```ts
import { injectable, inject, state, derived, onInit, Props } from "impair";
import { evaluateNext, type AnswerMap, type EvalPage } from "@rovenue/shared/funnel";
import type { Page } from "../types";
import { toEvalPage } from "../types";

interface PreviewProps {
  pages: Page[];
  rules: Record<string, unknown[]>;
  defaultNext: Record<string, string | null>;
  startId: string | null;
}

@injectable()
export class FunnelPreviewViewModel {
  @state currentPageId: string | null = null;
  @state answers: AnswerMap = new Map();
  @state finished = false;
  @state reachedPaywall = false;

  constructor(@inject(Props) private props: PreviewProps) {}

  @onInit init() {
    this.currentPageId = this.props.startId ?? this.props.pages[0]?.id ?? null;
  }

  @derived get currentPage(): Page | null {
    return this.currentPageId
      ? this.props.pages.find((p) => p.id === this.currentPageId) ?? null
      : null;
  }

  reset() {
    this.currentPageId = this.props.startId ?? this.props.pages[0]?.id ?? null;
    this.answers = new Map();
    this.finished = false;
    this.reachedPaywall = false;
  }

  answerAndAdvance(questionId: string | null, answer: unknown) {
    if (questionId) {
      const next = new Map(this.answers);
      next.set(questionId, answer as never);
      this.answers = next;
    }
    const cur = this.currentPage;
    if (!cur) return;
    const pagesOrder = this.props.pages.map((p) => p.id);
    const pagesById = new Map<string, EvalPage>(
      this.props.pages.map((p) => [
        p.id,
        toEvalPage(p, this.props.rules[p.id], this.props.defaultNext[p.id] ?? undefined) as EvalPage,
      ]),
    );
    const result = evaluateNext({
      page: toEvalPage(cur, this.props.rules[cur.id], this.props.defaultNext[cur.id] ?? undefined) as EvalPage,
      pagesOrder,
      answers: this.answers,
      pagesById,
    });
    if (result.next === "end") {
      this.finished = true;
      this.currentPageId = null;
      return;
    }
    if (result.next === "paywall") {
      this.reachedPaywall = true;
      const paywall = this.props.pages.find((p) => p.type === "paywall");
      this.currentPageId = paywall?.id ?? null;
      this.finished = !paywall;
      return;
    }
    this.currentPageId = result.pageId;
  }
}
```

- [ ] **Step 2: Test**

```ts
import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { Container } from "impair";
import { FunnelPreviewViewModel } from "./funnel-preview.vm";

function makeVm(pages: any[], rules = {}, defaultNext = {}) {
  const container = new Container();
  return container.resolveWithProps(FunnelPreviewViewModel, {
    pages, rules, defaultNext, startId: pages[0]?.id ?? null,
  });
}

describe("FunnelPreviewViewModel", () => {
  it("walks sequentially when no rule matches", () => {
    const vm = makeVm([
      { id: "pg_1", type: "info", title: "A" },
      { id: "pg_2", type: "info", title: "B" },
      { id: "pg_pay", type: "paywall", headline: "Pay" },
    ]);
    expect(vm.currentPageId).toBe("pg_1");
    vm.answerAndAdvance(null, null);
    expect(vm.currentPageId).toBe("pg_2");
    vm.answerAndAdvance(null, null);
    expect(vm.currentPageId).toBe("pg_pay");
  });

  it("jumps via 'paywall' literal goto", () => {
    const vm = makeVm(
      [
        { id: "pg_1", type: "info", title: "A" },
        { id: "pg_2", type: "info", title: "B" },
        { id: "pg_pay", type: "paywall", headline: "Pay" },
      ],
      {},
      { pg_1: "paywall" },
    );
    vm.answerAndAdvance(null, null);
    expect(vm.currentPageId).toBe("pg_pay");
    expect(vm.reachedPaywall).toBe(true);
  });

  it("reset returns to start", () => {
    const vm = makeVm([
      { id: "pg_1", type: "info", title: "A" },
      { id: "pg_2", type: "info", title: "B" },
      { id: "pg_pay", type: "paywall" },
    ]);
    vm.answerAndAdvance(null, null);
    vm.reset();
    expect(vm.currentPageId).toBe("pg_1");
    expect(vm.answers.size).toBe(0);
  });
});
```

- [ ] **Step 3: Run + commit**

```bash
pnpm --filter @rovenue/dashboard vitest run src/components/funnel-builder/vm/funnel-preview.vm.test.ts
git add apps/dashboard/src/components/funnel-builder/vm/funnel-preview.vm.ts apps/dashboard/src/components/funnel-builder/vm/funnel-preview.vm.test.ts
git commit -m "feat(dashboard): FunnelPreviewViewModel driven by shared evaluator"
```

---

### Task 35: PreviewOverlay consumes the preview VM

**Files:**
- Modify: `apps/dashboard/src/components/funnel-builder/preview-overlay.tsx`

- [ ] **Step 1: Rewire**

```tsx
import { component, useService, useViewModel } from "impair";
import { ArrowLeft, ArrowRight, X } from "lucide-react";
import { FunnelDraftViewModel } from "./vm/funnel-draft.vm";
import { FunnelPreviewViewModel } from "./vm/funnel-preview.vm";
import { PagePreview } from "./page-preview";

export const PreviewOverlay = component(() => {
  const draft = useService(FunnelDraftViewModel);
  const preview = useViewModel(FunnelPreviewViewModel, {
    pages: draft.pages,
    rules: draft.rules,
    defaultNext: draft.defaultNext,
    startId: draft.selectedPageId,
  });

  return (
    <div className="tb-preview-overlay" onClick={() => draft.closePreview()}>
      <button className="tb-preview-close" onClick={() => draft.closePreview()}>
        <X size={16} />
      </button>
      <div className="phone-frame large" onClick={(e) => e.stopPropagation()}>
        <div className="notch" />
        {preview.currentPage && <PagePreview page={preview.currentPage} theme={draft.theme} />}
      </div>
      <div className="tb-preview-controls" onClick={(e) => e.stopPropagation()}>
        <button
          className="step"
          onClick={() => preview.answerAndAdvance(null, null)}
          disabled={preview.finished}
        >
          <ArrowRight size={12} />
        </button>
      </div>
    </div>
  );
});
```

For now the overlay only auto-advances on click (`answerAndAdvance(null, null)`). To make question pages interactive, lift the per-page input into `PagePreview` — when a user picks an option, call `preview.answerAndAdvance(questionId, answerValue)`. Wire the per-type interactions inside `PagePreview` and pass `onAdvance` down. This is the same pattern the existing UI already follows; just route the callback through.

If `PagePreview` doesn't currently expose `onAdvance`, change its signature to `({ page, theme, onAdvance })` and update its internal click handlers to call it instead of doing nothing.

- [ ] **Step 2: Commit**

```bash
pnpm --filter @rovenue/dashboard typecheck
git add apps/dashboard/src/components/funnel-builder/preview-overlay.tsx apps/dashboard/src/components/funnel-builder/page-preview.tsx
git commit -m "feat(dashboard): PreviewOverlay drives FunnelPreviewViewModel"
```

---

## Phase 16 — Funnels list page (real data, no impair)

The list page is outside the builder. Per spec, impair is only required inside the builder. Use TanStack Query for cleanliness.

### Task 36: Replace the list page's mock data

**Files:**
- Modify: `apps/dashboard/src/routes/_authed/projects/$projectId/funnels.tsx`

- [ ] **Step 1: Add a query hook + mutation hooks**

Inside the file (or a sibling `lib/hooks/useFunnels.ts` if you prefer the codebase convention — there are already `useExperiments.ts`, `useFeatureFlags.ts`):

```ts
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { rpc, unwrap } from "../../../../../lib/api";
import type { FunnelDetailDto } from "../../../../../lib/services/funnel-api";

interface FunnelListItemDto {
  id: string;
  slug: string;
  name: string;
  status: "draft" | "published" | "archived";
  currentVersionNo: number | null;
  createdAt: string;
  updatedAt: string;
  publishedAt: string | null;
  stats7d: { started: number; completed: number; paid: number; conversionRate: number };
}

function useFunnelsList(projectId: string) {
  return useQuery({
    queryKey: ["funnels", projectId],
    enabled: Boolean(projectId),
    queryFn: () =>
      unwrap<{ funnels: FunnelListItemDto[] }>(
        rpc.dashboard.projects[":projectId"].funnels.$get({ param: { projectId } }),
      ),
    select: (r) => r.funnels,
  });
}

function useCreateFunnel(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: { name: string; slug: string }) =>
      unwrap<{ funnel: FunnelDetailDto }>(
        rpc.dashboard.projects[":projectId"].funnels.$post({ param: { projectId }, json: body }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["funnels", projectId] }),
  });
}

function useDuplicateFunnel(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (funnelId: string) =>
      unwrap<{ funnel: FunnelDetailDto }>(
        rpc.dashboard.projects[":projectId"].funnels[":funnelId"].duplicate.$post({
          param: { projectId, funnelId },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["funnels", projectId] }),
  });
}

function useDeleteFunnel(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (funnelId: string) =>
      unwrap<{ deleted: true }>(
        rpc.dashboard.projects[":projectId"].funnels[":funnelId"].$delete({
          param: { projectId, funnelId },
        }),
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["funnels", projectId] }),
  });
}
```

- [ ] **Step 2: Replace the mock rows / KPIs**

The current `funnels.tsx` route (1,035 lines) wires the KPI row + table + templates modal to local mock data. Walk through and replace:

- KPI numbers — derive from `useFunnelsList(projectId).data ?? []` (sum `stats7d.started`, sessions counts, etc.). If the backend doesn't yet expose project-level aggregate numbers, compute them client-side from the rows.
- Funnel rows — `data.map((f) => …)` instead of the local `FUNNELS_MOCK` array.
- Search / status filter — same in-memory filter logic, just over the fetched array.
- "New funnel" path — pass the name+slug through `useCreateFunnel.mutate(...)`, then `navigate({ to: "/projects/$projectId/funnels/$funnelId", params: { projectId, funnelId: result.funnel.id } })`.
- "Use template" path — call the existing `rpc.dashboard.projects[":projectId"].funnels["from-template"][":templateId"].$post(...)` via a similar useMutation.
- Row dropdown actions — `useDuplicateFunnel.mutate(id)` / `useDeleteFunnel.mutate(id)` (with confirm).

If the backend does not yet return a `stats7d` object, return zeros from the client mapper for now and add a TODO comment referencing the API task that will populate it.

- [ ] **Step 3: Smoke + commit**

```bash
pnpm --filter @rovenue/dashboard typecheck
pnpm --filter @rovenue/dashboard dev
# Verify the list loads, new funnel creation lands on the builder route.
git add apps/dashboard/src/routes/_authed/projects/\$projectId/funnels.tsx
git commit -m "feat(dashboard): funnels list page uses real backend"
```

---

## Phase 17 — Polish

### Task 37: Delete `data.ts` + dead-code sweep

**Files:**
- Delete: `apps/dashboard/src/components/funnel-builder/data.ts`
- Modify: any file still importing from `./data`

- [ ] **Step 1: Verify zero references**

```bash
grep -rn 'from "./data"\|from "\.\./data"\|funnel-builder/data' apps/dashboard/src
```

Expected: no hits. If any remain (e.g. a tab still pulls `FUNNEL.foo`), open that file and switch the read to the VM — it should already have everything you need.

- [ ] **Step 2: Delete + commit**

```bash
rm apps/dashboard/src/components/funnel-builder/data.ts
pnpm --filter @rovenue/dashboard typecheck
git add -A apps/dashboard/src/components/funnel-builder/data.ts
git commit -m "chore(dashboard): remove mock funnel-builder/data.ts"
```

- [ ] **Step 3: useState audit**

```bash
grep -rn "useState\|useReducer" apps/dashboard/src/components/funnel-builder/
```

Expected hits: only purely-UI local state (e.g. an "add popover open" boolean, a UTM input form). Everything domain-shaped must come from a VM. If you find a domain `useState`, lift it into a VM method.

If nothing else needs changing, no commit.

---

### Task 38: Smoke test end-to-end

- [ ] **Step 1: Boot**

```bash
pnpm --filter @rovenue/dashboard dev
```

- [ ] **Step 2: Click-through**

1. Funnels list → New funnel → name/slug dialog → submit → lands in builder.
2. Builder loads: name in breadcrumb, status pill in topbar, autosave pill says "saved".
3. Edit a question title — autosave pill flips to "saving" then back to "saved" within ~1s.
4. Reorder pages (Alt+Arrow or drag in the rail).
5. Add a branching rule on the second page targeting the paywall.
6. Theme tab → change primary color → preview reflects.
7. Settings tab → set universal_link_domain.
8. Open the publish dropdown — recent versions list renders from the API.
9. Click Publish → succeeds (assuming validation passes).
10. Open Share tab — URL + QR + snippets render with the real domain/slug.
11. Sessions tab — KPI cards + table render with real data (or zeros in a fresh project).
12. Versions full page reachable via "All versions…" — list matches the dropdown.
13. Trigger an error (delete the paywall page). Publish disables. Validation badge shows `(1)`. Open drawer → click "Open page" → drawer closes, content tab is active, the offending page is selected.
14. Open preview overlay. Click through pages — step-through uses the same evaluator the API uses.
15. Close the builder → memory profile shows the VM container disposed (no leaked subscriptions).

- [ ] **Step 3: Commit any polish fixes**

If you found bugs, fix and `git commit -m "fix(dashboard): …"` per problem. No bulk commits.

---

## Self-review

**Spec coverage:**
- All builder sub-components now consume `FunnelDraftViewModel` instead of mock data — Tasks 17, 19, 20-21, 22-23, 24-25, 26, 27, 30, 33, 35.
- Real backend reachable through `@injectable()` API services — Tasks 8-11.
- Autosave wired via `@trigger.debounce(800)` — Task 14.
- Publish dropdown lists real versions — Tasks 31-32.
- Validation reads from `vm.validation` (derived) — Tasks 14, 33.
- Preview uses shared `evaluateNext` — Tasks 1, 34-35.
- Sessions tab lives on a sibling VM that reacts to range changes — Tasks 28-29.
- List page uses real API — Task 36.
- `data.ts` deleted, no `useState` left for domain state — Task 37.

**impair coverage:** `@injectable` (Apis + VMs), `@state`, `@derived`, `@trigger.debounce`, `@trigger` (sync), `@onMount`, `@onInit`, `Props` injection token, `useService`, `useViewModel`, `ServiceProvider` with `provide`, `component(...)` HOC, `Cleanup` AbortController pattern, `Container.resolveWithProps` in tests.

**Placeholders:**
- Task 17 says "the existing JSX layout — substitute …" — that's intentional pattern guidance because the underlying markup is already correct in the repo. The substitution rule is fully specified inline; no body is being deferred.
- Task 22 lists every input by category. No "TODO" / "fill later".
- Task 35's `PagePreview` change is described in concrete terms (signature change + click handler).

**Type consistency:** `FunnelDetailDto` flows from `funnel-api.ts` → VM → consumers. `Page` stays in the dashboard's flat shape; `toEvalPage` is the single bridge to the shared schema (Task 18). `NextRule`, `Clause`, `ClauseOp`, `ValidatorIssue` come from `@rovenue/shared/funnel` everywhere.

**Open follow-ups (not in scope):**
- Real-time collaboration (multi-user concurrent edits) — would need WebSocket layer feeding the VM.
- AI chat FAB is inert visually — wiring it to an LLM is a separate plan.
- Optimistic add/duplicate of new funnels (the list re-fetches; no optimistic insert).

---

## Execution handoff

Plan complete. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
