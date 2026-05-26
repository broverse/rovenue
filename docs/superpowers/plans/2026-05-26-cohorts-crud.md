# Cohorts CRUD + Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the dashboard cohorts page to the existing backend — Create / Edit / Delete + saved-list + hero (size + W4) + retention heatmap from `/retention`. Panels without backend endpoints stay mocked with a visible `MOCK` badge.

**Architecture:** Two new file routes (`cohorts/new`, `cohorts/$cohortId`) backed by a single `<CohortForm>` and a new `<CohortRuleBuilder>`. The existing `cohorts.tsx` is rewritten to consume `useProjectCohorts` + `useCohortRetention`; selection is driven by a `?selected=<id>` search param. No backend changes; all query/mutation hooks already exist in `apps/dashboard/src/lib/hooks/useProjectCohorts.ts`.

**Tech Stack:** React 19 + TanStack Router + TanStack Query + i18next + Vitest + MSW + Tailwind. Backend Hono + Drizzle (no changes here).

**Spec:** `docs/superpowers/specs/2026-05-26-cohorts-crud-design.md`

---

## File Inventory

**New files:**
- `apps/dashboard/src/components/cohorts/cohort-rule-builder.tsx` — structured editor for `CohortRule`
- `apps/dashboard/src/components/cohorts/cohort-form.tsx` — shared create/edit form
- `apps/dashboard/src/components/cohorts/mock-badge.tsx` — "MOCK" pill
- `apps/dashboard/src/routes/_authed/projects/$projectId/cohorts/new.tsx`
- `apps/dashboard/src/routes/_authed/projects/$projectId/cohorts/$cohortId.tsx`
- `apps/dashboard/tests/cohort-rule-builder.test.tsx`
- `apps/dashboard/tests/cohort-form.test.tsx`
- `apps/dashboard/tests/routes/cohorts.test.tsx`

**Modified files:**
- `apps/dashboard/src/routes/_authed/projects/$projectId/cohorts.tsx` — real data, search-param selection, empty/error states, header button links to `cohorts/new`
- `apps/dashboard/src/components/cohorts/saved-cohorts-rail.tsx` — accept `CohortRow[]`, single "All cohorts" heading, name filter, deterministic colour dots
- `apps/dashboard/src/components/cohorts/cohort-hero.tsx` — size + W4 from retention; `<MockBadge>` on LTV + churn
- `apps/dashboard/src/components/cohorts/retention-heatmap.tsx` — consume `CohortRetentionResponse.points`
- `apps/dashboard/src/components/cohorts/cohort-builder.tsx` — becomes read-only `CohortDefinitionCard` reading real rules; "Save" → "Edit" link
- `apps/dashboard/src/components/cohorts/index.ts` — exports
- `apps/dashboard/src/components/cohorts/mock-data.ts` — trim down (remove `SAVED_COHORTS`, `COHORT_ROWS`, `KPI_VALUES.bestCohort*`; keep LTV curves, country breakdown, member avatars, sync destinations)
- `apps/dashboard/src/i18n/locales/en.json` — `cohorts.new.*`, `cohorts.edit.*`, `cohorts.form.*`, `cohorts.delete.*`, `cohorts.mockBadge.*`, etc.
- `apps/dashboard/tests/msw/handlers.ts` — cohort GET / POST / PATCH / DELETE / retention handlers

---

## Task 1: MSW handlers for cohorts

Wire up mock-server fixtures so every later test has somewhere to talk to.

**Files:**
- Modify: `apps/dashboard/tests/msw/handlers.ts`

- [ ] **Step 1.1: Append cohort handlers**

Add these handlers to the `handlers` array in `apps/dashboard/tests/msw/handlers.ts`, just before the final `];`:

```ts
  http.get(`${BASE}/dashboard/projects/:projectId/cohorts`, () =>
    HttpResponse.json({
      data: {
        cohorts: [
          {
            id: "coh_1",
            projectId: "proj_1",
            userId: "u1",
            name: "High-value users",
            description: "Spent >$50 lifetime",
            rules: {
              match: "all",
              filters: [{ field: "country", op: "in", value: ["US", "CA"] }],
            },
            syncDestinations: [],
            metadata: {},
            createdAt: "2026-05-01T00:00:00Z",
            updatedAt: "2026-05-10T00:00:00Z",
          },
        ],
      },
    }),
  ),

  http.post(
    `${BASE}/dashboard/projects/:projectId/cohorts`,
    async ({ request }) => {
      const body = (await request.json()) as {
        name: string;
        description?: string | null;
        rules: unknown;
      };
      return HttpResponse.json({
        data: {
          cohort: {
            id: "coh_new",
            projectId: "proj_1",
            userId: "u1",
            name: body.name,
            description: body.description ?? null,
            rules: body.rules,
            syncDestinations: [],
            metadata: {},
            createdAt: "2026-05-26T00:00:00Z",
            updatedAt: "2026-05-26T00:00:00Z",
          },
        },
      });
    },
  ),

  http.get(
    `${BASE}/dashboard/projects/:projectId/cohorts/:id`,
    ({ params }) =>
      HttpResponse.json({
        data: {
          cohort: {
            id: params.id,
            projectId: "proj_1",
            userId: "u1",
            name: "High-value users",
            description: "Spent >$50 lifetime",
            rules: {
              match: "all",
              filters: [{ field: "country", op: "in", value: ["US", "CA"] }],
            },
            syncDestinations: [],
            metadata: {},
            createdAt: "2026-05-01T00:00:00Z",
            updatedAt: "2026-05-10T00:00:00Z",
          },
        },
      }),
  ),

  http.patch(
    `${BASE}/dashboard/projects/:projectId/cohorts/:id`,
    async ({ params, request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({
        data: {
          cohort: {
            id: params.id,
            projectId: "proj_1",
            userId: "u1",
            name: (body.name as string) ?? "High-value users",
            description: (body.description as string | null) ?? null,
            rules: body.rules ?? {
              match: "all",
              filters: [],
            },
            syncDestinations: [],
            metadata: {},
            createdAt: "2026-05-01T00:00:00Z",
            updatedAt: "2026-05-26T00:00:00Z",
          },
        },
      });
    },
  ),

  http.delete(
    `${BASE}/dashboard/projects/:projectId/cohorts/:id`,
    () => HttpResponse.json({ data: { deleted: true } }),
  ),

  http.get(
    `${BASE}/dashboard/projects/:projectId/cohorts/:id/retention`,
    () =>
      HttpResponse.json({
        data: {
          size: 4821,
          granularity: "week",
          periods: 13,
          points: [
            { period: 0, active: 4821, pct: 100 },
            { period: 1, active: 3961, pct: 82.1 },
            { period: 2, active: 3520, pct: 73 },
            { period: 3, active: 3208, pct: 66.5 },
            { period: 4, active: 3007, pct: 62.4 },
            { period: 5, active: 2853, pct: 59.2 },
            { period: 6, active: 2740, pct: 56.8 },
            { period: 7, active: 2643, pct: 54.8 },
            { period: 8, active: 2559, pct: 53.1 },
            { period: 9, active: 2488, pct: 51.6 },
            { period: 10, active: 2425, pct: 50.3 },
            { period: 11, active: 2371, pct: 49.2 },
            { period: 12, active: 2326, pct: 48.2 },
          ],
        },
      }),
  ),
```

- [ ] **Step 1.2: Verify tests still pass**

Run: `pnpm --filter @rovenue/dashboard test --run`
Expected: PASS (handlers added but no tests consume them yet).

- [ ] **Step 1.3: Commit**

```bash
git add apps/dashboard/tests/msw/handlers.ts
git commit -m "test(dashboard): MSW handlers for cohorts CRUD + retention"
```

---

## Task 2: MockBadge component

Tiny visual affordance — a muted "MOCK" pill with a tooltip. Built first because `cohort-hero.tsx` in Task 3 imports it.

**Files:**
- Create: `apps/dashboard/src/components/cohorts/mock-badge.tsx`

- [ ] **Step 2.1: Write the component**

Create `apps/dashboard/src/components/cohorts/mock-badge.tsx`:

```tsx
import { useTranslation } from "react-i18next";

export function MockBadge() {
  const { t } = useTranslation();
  return (
    <span
      title={t("cohorts.mockBadge.tooltip")}
      className="inline-flex items-center rounded-sm border border-rv-divider bg-rv-c2 px-1 py-px font-rv-mono text-[9px] font-medium uppercase tracking-wider text-rv-mute-500"
    >
      {t("cohorts.mockBadge.label")}
    </span>
  );
}
```

- [ ] **Step 2.2: Add i18n keys**

In `apps/dashboard/src/i18n/locales/en.json`, add under the `cohorts` object:

```json
    "mockBadge": {
      "label": "Mock",
      "tooltip": "Backend not wired yet — showing placeholder data"
    },
```

- [ ] **Step 2.3: Commit**

```bash
git add apps/dashboard/src/components/cohorts/mock-badge.tsx apps/dashboard/src/i18n/locales/en.json
git commit -m "feat(dashboard/cohorts): MockBadge component"
```

---

## Task 3: Mock-data trim and rail/hero decoupling

Strip the parts of `mock-data.ts` that will be backed by real data, and convert `cohort-hero.tsx` + `saved-cohorts-rail.tsx` so they accept real `CohortRow` shapes (no more `group` / `growth` / `dot` dependencies). Existing usages keep compiling because we feed them adapted real rows in later tasks.

**Files:**
- Modify: `apps/dashboard/src/components/cohorts/mock-data.ts`
- Modify: `apps/dashboard/src/components/cohorts/types.ts`
- Modify: `apps/dashboard/src/components/cohorts/format.ts`
- Modify: `apps/dashboard/src/components/cohorts/saved-cohorts-rail.tsx`
- Modify: `apps/dashboard/src/components/cohorts/cohort-hero.tsx`
- Modify: `apps/dashboard/src/components/cohorts/retention-heatmap.tsx`
- Modify: `apps/dashboard/src/components/cohorts/index.ts`

- [ ] **Step 3.1: Trim `mock-data.ts`**

Open `apps/dashboard/src/components/cohorts/mock-data.ts`. Delete the `SAVED_COHORTS`, `COHORT_ROWS`, and `COHORT_COLUMN_HEADERS` exports. Delete the `bestCohortName`, `bestCohortValue`, `bestCohortUsers` keys from `KPI_VALUES`. Keep: `SAMPLE_MEMBERS`, `INCLUDE_CONDITIONS`, `EXCLUDE_CONDITIONS`, `LTV_CURVES`, `COUNTRY_BREAKDOWN`, `SYNC_DESTINATIONS`, and the remaining `KPI_VALUES` fields (`groupCount`, `syncedCount`, `avgRetentionDelta`, `blendedLtv`, `blendedLtvDelta`).

- [ ] **Step 3.2: Add helpers to `format.ts`**

Append to `apps/dashboard/src/components/cohorts/format.ts`:

```ts
// Deterministic dot colour from a cohort id.
const DOT_PALETTE = [
  "#22c55e", // green
  "#a855f7", // violet
  "#f59e0b", // amber
  "#3b82f6", // blue
  "#ef4444", // red
  "#14b8a6", // teal
] as const;

export function dotColorForId(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return DOT_PALETTE[h % DOT_PALETTE.length];
}

export function w4Pct(
  points: ReadonlyArray<{ period: number; pct: number }>,
): number | null {
  return points.find((p) => p.period === 4)?.pct ?? null;
}
```

- [ ] **Step 3.3: Drop dead exports from `types.ts`**

Open `apps/dashboard/src/components/cohorts/types.ts`. Delete the `SavedCohort`, `CohortGroupKey`, `CohortDot`, `CohortRow` (the *local* one — not the shared `CohortRow` from `@rovenue/shared`), `RetentionMetric` and related local types **only if they are no longer used**. Keep `CohortMember`, `Condition`, `CountryBreakdown`, `LtvCurve`, `SyncDestination`, `SyncDestinationStatus`. Re-run the build below to catch the gaps; types not referenced after Task 2 must be removed.

For `RetentionMetric`, keep it — it stays in use by `metric-tabs.tsx` and the heatmap.

- [ ] **Step 3.4: Rewrite `saved-cohorts-rail.tsx`**

Replace the full contents of `apps/dashboard/src/components/cohorts/saved-cohorts-rail.tsx`:

```tsx
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, Search } from "lucide-react";
import type { CohortRow } from "@rovenue/shared";
import { cn } from "../../lib/cn";
import { dotColorForId } from "./format";

type Props = {
  cohorts: ReadonlyArray<CohortRow>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onNew: () => void;
};

export function SavedCohortsRail({
  cohorts,
  selectedId,
  onSelect,
  onNew,
}: Props) {
  const { t } = useTranslation();
  const [filter, setFilter] = useState("");

  const filtered = useMemo<ReadonlyArray<CohortRow>>(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return cohorts;
    return cohorts.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        (c.description ?? "").toLowerCase().includes(q),
    );
  }, [cohorts, filter]);

  return (
    <aside className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
      <header className="flex items-center justify-between border-b border-rv-divider px-3.5 py-3">
        <h4 className="text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
          {t("cohorts.saved.heading")}
        </h4>
        <button
          type="button"
          aria-label={t("cohorts.saved.newAria")}
          onClick={onNew}
          className="flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-rv-mute-500 transition hover:bg-rv-c3 hover:text-foreground"
        >
          <Plus size={12} />
        </button>
      </header>

      <div className="border-b border-rv-divider px-2.5 py-2">
        <label className="flex h-7 items-center gap-1.5 rounded-md border border-rv-divider bg-rv-c2 px-2.5 transition focus-within:border-rv-accent-500">
          <Search size={12} className="text-rv-mute-500" />
          <input
            type="text"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={t("cohorts.saved.filterPlaceholder")}
            className="flex-1 bg-transparent text-[12px] text-foreground placeholder:text-rv-mute-500 outline-none"
          />
        </label>
      </div>

      {filtered.length === 0 ? (
        <div className="px-3.5 py-6 text-center text-[12px] text-rv-mute-500">
          {cohorts.length === 0
            ? t("cohorts.list.empty")
            : t("cohorts.saved.filterEmpty")}
        </div>
      ) : (
        <div>
          <div className="bg-rv-c2 px-3.5 py-2 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
            {t("cohorts.list.allHeading")}
          </div>
          {filtered.map((item) => {
            const active = item.id === selectedId;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => onSelect(item.id)}
                className={cn(
                  "block w-full cursor-pointer border-b border-rv-divider px-3.5 py-2.5 text-left transition hover:bg-rv-c2",
                  active &&
                    "bg-[color-mix(in_srgb,var(--color-rv-accent-500)_10%,transparent)] shadow-[inset_2px_0_0_var(--color-rv-accent-500)]",
                )}
              >
                <div className="flex items-center gap-1.5 text-[13px] font-medium text-foreground">
                  <span
                    aria-hidden
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: dotColorForId(item.id) }}
                  />
                  <span className="truncate">{item.name}</span>
                </div>
                {item.description && (
                  <div className="mt-0.5 truncate font-rv-mono text-[11px] text-rv-mute-500">
                    {item.description}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      )}
    </aside>
  );
}
```

- [ ] **Step 3.5: Rewrite `cohort-hero.tsx`**

Replace the full contents of `apps/dashboard/src/components/cohorts/cohort-hero.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import type { CohortRow } from "@rovenue/shared";
import { dotColorForId } from "./format";
import { MockBadge } from "./mock-badge";
import { SAMPLE_MEMBERS } from "./mock-data";

type Props = {
  cohort: CohortRow;
  size: number | null;
  w4Pct: number | null;
};

function HeroStat({
  label,
  value,
  delta,
  mocked,
}: {
  label: string;
  value: string;
  delta?: string;
  mocked?: boolean;
}) {
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
        {label}
        {mocked && <MockBadge />}
      </div>
      <div className="mt-0.5 font-rv-mono text-[24px] font-medium tabular-nums text-foreground">
        {value}
      </div>
      {delta && (
        <div className="font-rv-mono text-[11px] text-rv-success">{delta}</div>
      )}
    </div>
  );
}

export function CohortHero({ cohort, size, w4Pct }: Props) {
  const { t } = useTranslation();
  const members = SAMPLE_MEMBERS;
  const sizeDisplay =
    size == null ? "—" : size.toLocaleString();
  const w4Display =
    w4Pct == null ? "—" : `${w4Pct.toFixed(1)}%`;
  const remainder =
    size == null ? 0 : Math.max(0, size - members.length);

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4">
      <div className="flex flex-wrap justify-between gap-5">
        <div className="min-w-[280px] flex-1">
          <div className="flex items-center gap-2 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
            <span
              aria-hidden
              className="h-2 w-2 rounded-full"
              style={{ background: dotColorForId(cohort.id) }}
            />
            {t("cohorts.hero.groupCohort", {
              group: t("cohorts.hero.defaultGroup"),
            })}
          </div>
          <h2 className="mt-1.5 mb-1 text-[22px] font-semibold leading-tight">
            {cohort.name}
          </h2>
          {cohort.description && (
            <p className="m-0 text-[13px] text-rv-mute-600">
              {cohort.description}
            </p>
          )}
          <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
            <MockBadge />
            {members.map((m) => (
              <span
                key={m.id}
                className="inline-flex items-center gap-1.5 rounded-full border border-rv-divider bg-rv-c2 py-1 pr-2 pl-1 font-rv-mono text-[11px] text-rv-mute-700"
              >
                <span className="flex h-[18px] w-[18px] items-center justify-center rounded-full bg-gradient-to-br from-rv-accent-600 to-rv-violet text-[9px] font-semibold text-white">
                  {m.initials}
                </span>
                {m.id}
              </span>
            ))}
            {remainder > 0 && (
              <span className="inline-flex items-center rounded-full border border-rv-divider bg-rv-c2 px-2.5 py-1 font-rv-mono text-[11px] text-rv-mute-500">
                {t("cohorts.hero.memberMore", {
                  count: remainder.toLocaleString(),
                })}
              </span>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-start gap-6">
          <HeroStat
            label={t("cohorts.hero.size")}
            value={sizeDisplay}
          />
          <HeroStat
            label={t("cohorts.hero.w4Retention")}
            value={w4Display}
          />
          <HeroStat
            label={t("cohorts.hero.ltv90")}
            value={t("cohorts.hero.ltv90Value")}
            delta={t("cohorts.hero.ltv90Delta")}
            mocked
          />
          <HeroStat
            label={t("cohorts.hero.monthlyChurn")}
            value={t("cohorts.hero.monthlyChurnValue")}
            delta={t("cohorts.hero.monthlyChurnDelta")}
            mocked
          />
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 3.6: Update `retention-heatmap.tsx` to accept real points**

In `apps/dashboard/src/components/cohorts/retention-heatmap.tsx`, change the `Props` type and replace the mock-data import:

```tsx
import type { CohortRetentionPoint } from "@rovenue/shared";

type Props = {
  cohortName: string;
  metric: RetentionMetric;
  onMetricChange: (next: RetentionMetric) => void;
  points: ReadonlyArray<CohortRetentionPoint>;
  size: number | null;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
};
```

Remove the `import { COHORT_COLUMN_HEADERS, COHORT_ROWS } from "./mock-data";` line. Inside the component, derive column headers and rows from `points`:

```tsx
const columnHeaders = points.map((p) =>
  p.period === 0 ? t("cohorts.retention.activation") : `W${p.period}`,
);

const row = {
  cohort: cohortName,
  size: size ?? 0,
  cells: points.map((p) => ({ period: p.period, active: p.active, pct: p.pct })),
};
```

Replace any reference to `COHORT_ROWS`/`COHORT_COLUMN_HEADERS` later in the file with `columnHeaders` / `[row]`. Render an error/empty state banner above the table when `error` is truthy, with a Retry button that calls `onRetry?.()`. When `loading && points.length === 0`, render a `<div className="px-4 py-10 text-center text-[12px] text-rv-mute-500">{t("cohorts.retention.loading")}</div>` in place of the table body.

If the existing heatmap renders a multi-row grid that depended on `COHORT_ROWS[].cohort`, collapse it to a single row driven by the props above. Helpers `formatMetricCellValue`, `metricSuffix`, `metricValue`, `retentionCellBackground`, `retentionCellText` still apply per cell — pass the new cell shape through them.

- [ ] **Step 3.7: Clean up `index.ts` exports**

In `apps/dashboard/src/components/cohorts/index.ts`, remove `SAVED_COHORTS`, `COHORT_ROWS`, `COHORT_COLUMN_HEADERS` from the `mock-data` re-export. Remove `SavedCohort`, `CohortGroupKey`, `CohortDot`, `CohortRow` from the type re-export (the local `CohortRow` was a UI type; the shared one is imported directly from `@rovenue/shared` in consumers). Add `MockBadge` to the exports and `dotColorForId`, `w4Pct` to the `format` re-exports.

- [ ] **Step 3.8: Verify build still passes**

The existing `cohorts.tsx` route still imports the now-removed symbols. We expect a build break here — that's fine; Task 13 rewrites the route. Run a typecheck and confirm the only failures are in `routes/_authed/projects/$projectId/cohorts.tsx`:

Run: `pnpm --filter @rovenue/dashboard typecheck`
Expected: Errors only in `routes/_authed/projects/$projectId/cohorts.tsx` (references to `SAVED_COHORTS`, `SAMPLE_MEMBERS` import path that moved, `SavedCohort`, `KPI_VALUES.bestCohort*`).

- [ ] **Step 3.9: Commit**

```bash
git add apps/dashboard/src/components/cohorts/
git commit -m "refactor(dashboard/cohorts): rail + hero + heatmap accept real CohortRow"
```

---

## Task 4: CohortRuleBuilder — types and codec (TDD)

Build the structured editor for `CohortRule`. Start with a pure helper module + tests so the rendering layer has a tested foundation.

**Files:**
- Create: `apps/dashboard/src/components/cohorts/rule-codec.ts`
- Create: `apps/dashboard/tests/components/cohort-rule-codec.test.ts`

- [ ] **Step 4.1: Write the failing tests**

Create `apps/dashboard/tests/components/cohort-rule-codec.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { CohortFilter } from "@rovenue/shared";
import {
  allowedOps,
  defaultFilter,
  defaultValueForOp,
  isFilterValid,
  sanitiseRule,
} from "../../src/components/cohorts/rule-codec";

describe("rule-codec", () => {
  it("returns allowed operators for each field", () => {
    expect(allowedOps("country")).toEqual(["eq", "in"]);
    expect(allowedOps("store")).toEqual(["eq", "in"]);
    expect(allowedOps("productId")).toEqual(["eq", "in"]);
    expect(allowedOps("purchaseType")).toEqual(["eq", "in"]);
    expect(allowedOps("firstSeenAfter")).toEqual(["gte"]);
    expect(allowedOps("firstSeenBefore")).toEqual(["lte"]);
  });

  it("defaultFilter('country') is a country/in/[] fragment", () => {
    expect(defaultFilter("country")).toEqual({
      field: "country",
      op: "in",
      value: [],
    });
  });

  it("defaultFilter('firstSeenAfter') uses gte and empty string", () => {
    expect(defaultFilter("firstSeenAfter")).toEqual({
      field: "firstSeenAfter",
      op: "gte",
      value: "",
    });
  });

  it("defaultValueForOp returns [] for in, '' for eq, '' for gte/lte", () => {
    expect(defaultValueForOp("in")).toEqual([]);
    expect(defaultValueForOp("eq")).toEqual("");
    expect(defaultValueForOp("gte")).toEqual("");
    expect(defaultValueForOp("lte")).toEqual("");
  });

  it("isFilterValid rejects empty `in` arrays and empty scalars", () => {
    expect(
      isFilterValid({ field: "country", op: "in", value: [] }),
    ).toBe(false);
    expect(
      isFilterValid({ field: "country", op: "in", value: ["US"] }),
    ).toBe(true);
    expect(
      isFilterValid({ field: "country", op: "eq", value: "" }),
    ).toBe(false);
    expect(
      isFilterValid({ field: "country", op: "eq", value: "US" }),
    ).toBe(true);
  });

  it("sanitiseRule drops invalid filters and preserves order", () => {
    const f1: CohortFilter = { field: "country", op: "in", value: ["US"] };
    const f2: CohortFilter = { field: "store", op: "eq", value: "" }; // invalid
    const f3: CohortFilter = { field: "productId", op: "eq", value: "p_1" };
    expect(
      sanitiseRule({ match: "all", filters: [f1, f2, f3] }),
    ).toEqual({ match: "all", filters: [f1, f3] });
  });
});
```

- [ ] **Step 4.2: Run the tests — expect failure**

Run: `pnpm --filter @rovenue/dashboard test --run tests/components/cohort-rule-codec.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4.3: Implement `rule-codec.ts`**

Create `apps/dashboard/src/components/cohorts/rule-codec.ts`:

```ts
import type {
  CohortFilter,
  CohortFilterField,
  CohortOperator,
  CohortRule,
} from "@rovenue/shared";

const FIELD_OPS: Record<CohortFilterField, ReadonlyArray<CohortOperator>> = {
  country: ["eq", "in"],
  store: ["eq", "in"],
  productId: ["eq", "in"],
  purchaseType: ["eq", "in"],
  firstSeenAfter: ["gte"],
  firstSeenBefore: ["lte"],
};

export const ALL_FIELDS: ReadonlyArray<CohortFilterField> = [
  "country",
  "store",
  "productId",
  "purchaseType",
  "firstSeenAfter",
  "firstSeenBefore",
];

export function allowedOps(
  field: CohortFilterField,
): ReadonlyArray<CohortOperator> {
  return FIELD_OPS[field];
}

export function defaultValueForOp(op: CohortOperator): CohortFilter["value"] {
  switch (op) {
    case "in":
      return [];
    case "between":
      return { min: 0, max: 0 };
    case "eq":
    case "gte":
    case "lte":
    default:
      return "";
  }
}

export function defaultFilter(field: CohortFilterField): CohortFilter {
  const op = allowedOps(field)[0]!;
  // Prefer `in` for multi-value fields so users land on chip-pickers
  // without an extra click.
  const preferred: CohortOperator =
    field === "country" ||
    field === "store" ||
    field === "productId" ||
    field === "purchaseType"
      ? "in"
      : op;
  return {
    field,
    op: preferred,
    value: defaultValueForOp(preferred),
  };
}

export function isFilterValid(f: CohortFilter): boolean {
  switch (f.op) {
    case "in":
      return Array.isArray(f.value) && f.value.length > 0;
    case "eq":
      return typeof f.value === "string" && f.value.trim().length > 0;
    case "gte":
    case "lte":
      return typeof f.value === "string" && f.value.trim().length > 0;
    case "between":
      return (
        typeof f.value === "object" &&
        f.value !== null &&
        "min" in f.value &&
        "max" in f.value
      );
    default:
      return false;
  }
}

export function sanitiseRule(rule: CohortRule): CohortRule {
  return {
    match: rule.match,
    filters: rule.filters.filter(isFilterValid),
  };
}
```

- [ ] **Step 4.4: Run the tests — expect pass**

Run: `pnpm --filter @rovenue/dashboard test --run tests/components/cohort-rule-codec.test.ts`
Expected: PASS — all five tests.

- [ ] **Step 4.5: Commit**

```bash
git add apps/dashboard/src/components/cohorts/rule-codec.ts apps/dashboard/tests/components/cohort-rule-codec.test.ts
git commit -m "feat(dashboard/cohorts): rule-codec with field/op/validity helpers"
```

---

## Task 5: CohortRuleBuilder — UI (TDD)

Render the rule editor. Tests assert the user-flow: add a country `in` filter, type "US,CA", emit `{ field: "country", op: "in", value: ["US","CA"] }`.

**Files:**
- Create: `apps/dashboard/src/components/cohorts/cohort-rule-builder.tsx`
- Create: `apps/dashboard/tests/components/cohort-rule-builder.test.tsx`

- [ ] **Step 5.1: Write the failing test**

Create `apps/dashboard/tests/components/cohort-rule-builder.test.tsx`:

```tsx
import { describe, expect, it, vi } from "vitest";
import { fireEvent } from "@testing-library/react";
import { I18nProvider } from "@heroui/react";
import type { CohortRule } from "@rovenue/shared";
import { render } from "@testing-library/react";
import { CohortRuleBuilder } from "../../src/components/cohorts/cohort-rule-builder";

function renderBuilder(rule: CohortRule, onChange = vi.fn()) {
  return render(
    <I18nProvider>
      <CohortRuleBuilder rule={rule} onChange={onChange} />
    </I18nProvider>,
  );
}

describe("CohortRuleBuilder", () => {
  it("renders the match toggle and an add-filter button", () => {
    const { getByText } = renderBuilder({ match: "all", filters: [] });
    expect(getByText(/match all/i)).toBeTruthy();
    expect(getByText(/add filter/i)).toBeTruthy();
  });

  it("emits a default country filter when 'Add filter' → country is picked", () => {
    const onChange = vi.fn();
    const { getByText } = renderBuilder({ match: "all", filters: [] }, onChange);
    fireEvent.click(getByText(/add filter/i));
    fireEvent.click(getByText(/^country$/i));
    expect(onChange).toHaveBeenCalledWith({
      match: "all",
      filters: [{ field: "country", op: "in", value: [] }],
    });
  });

  it("typing into the chip input emits updated `in` value", () => {
    const onChange = vi.fn();
    const rule: CohortRule = {
      match: "all",
      filters: [{ field: "country", op: "in", value: [] }],
    };
    const { getByPlaceholderText } = renderBuilder(rule, onChange);
    const input = getByPlaceholderText(/country/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "US" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onChange).toHaveBeenLastCalledWith({
      match: "all",
      filters: [{ field: "country", op: "in", value: ["US"] }],
    });
  });

  it("removing the last filter emits filters: []", () => {
    const onChange = vi.fn();
    const rule: CohortRule = {
      match: "all",
      filters: [{ field: "country", op: "in", value: ["US"] }],
    };
    const { getByLabelText } = renderBuilder(rule, onChange);
    fireEvent.click(getByLabelText(/remove filter/i));
    expect(onChange).toHaveBeenLastCalledWith({
      match: "all",
      filters: [],
    });
  });
});
```

- [ ] **Step 5.2: Run — expect failure**

Run: `pnpm --filter @rovenue/dashboard test --run tests/components/cohort-rule-builder.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 5.3: Implement `cohort-rule-builder.tsx`**

Create `apps/dashboard/src/components/cohorts/cohort-rule-builder.tsx`:

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus, X } from "lucide-react";
import type {
  CohortFilter,
  CohortFilterField,
  CohortOperator,
  CohortRule,
} from "@rovenue/shared";
import { Button } from "../../ui/button";
import {
  ALL_FIELDS,
  allowedOps,
  defaultFilter,
  defaultValueForOp,
} from "./rule-codec";

type Props = {
  rule: CohortRule;
  onChange: (next: CohortRule) => void;
};

const STORE_OPTIONS = ["apple", "google", "stripe"] as const;
const PURCHASE_TYPE_OPTIONS = [
  "subscription",
  "consumable",
  "non_consumable",
] as const;

export function CohortRuleBuilder({ rule, onChange }: Props) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);

  function setMatch(match: "all" | "any") {
    onChange({ ...rule, match });
  }

  function addFilter(field: CohortFilterField) {
    onChange({ ...rule, filters: [...rule.filters, defaultFilter(field)] });
    setAdding(false);
  }

  function updateFilter(idx: number, next: CohortFilter) {
    const filters = rule.filters.slice();
    filters[idx] = next;
    onChange({ ...rule, filters });
  }

  function removeFilter(idx: number) {
    const filters = rule.filters.filter((_, i) => i !== idx);
    onChange({ ...rule, filters });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center gap-2 text-[12px] text-rv-mute-600">
        <span>{t("cohorts.form.rules.matchPrefix")}</span>
        <select
          value={rule.match}
          onChange={(e) => setMatch(e.target.value as "all" | "any")}
          className="h-7 rounded-md border border-rv-divider bg-rv-c2 px-2 text-[12px] text-foreground"
        >
          <option value="all">{t("cohorts.form.rules.match.all")}</option>
          <option value="any">{t("cohorts.form.rules.match.any")}</option>
        </select>
        <span>{t("cohorts.form.rules.matchSuffix")}</span>
      </div>

      {rule.filters.length === 0 && (
        <p className="m-0 text-[12px] text-rv-mute-500">
          {t("cohorts.form.rules.emptyHint")}
        </p>
      )}

      {rule.filters.map((f, idx) => (
        <FilterRow
          key={idx}
          filter={f}
          onChange={(next) => updateFilter(idx, next)}
          onRemove={() => removeFilter(idx)}
        />
      ))}

      <div className="relative">
        <Button
          type="button"
          variant="flat"
          size="sm"
          onClick={() => setAdding((v) => !v)}
        >
          <Plus size={12} />
          {t("cohorts.form.rules.addFilter")}
        </Button>
        {adding && (
          <div className="absolute z-10 mt-1 w-44 rounded-md border border-rv-divider bg-rv-c1 p-1 shadow-lg">
            {ALL_FIELDS.map((field) => (
              <button
                key={field}
                type="button"
                onClick={() => addFilter(field)}
                className="block w-full cursor-pointer rounded px-2 py-1 text-left text-[12px] text-foreground transition hover:bg-rv-c2"
              >
                {t(`cohorts.form.rules.field.${field}`)}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function FilterRow({
  filter,
  onChange,
  onRemove,
}: {
  filter: CohortFilter;
  onChange: (next: CohortFilter) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const ops = allowedOps(filter.field);

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-rv-divider bg-rv-c2 px-2 py-2">
      <select
        value={filter.field}
        onChange={(e) => {
          const field = e.target.value as CohortFilterField;
          const nextOp = allowedOps(field)[0]!;
          onChange({ field, op: nextOp, value: defaultValueForOp(nextOp) });
        }}
        className="h-7 rounded border border-rv-divider bg-rv-c1 px-2 text-[12px] text-foreground"
      >
        {ALL_FIELDS.map((f) => (
          <option key={f} value={f}>
            {t(`cohorts.form.rules.field.${f}`)}
          </option>
        ))}
      </select>

      <select
        value={filter.op}
        onChange={(e) => {
          const op = e.target.value as CohortOperator;
          onChange({ ...filter, op, value: defaultValueForOp(op) });
        }}
        className="h-7 rounded border border-rv-divider bg-rv-c1 px-2 text-[12px] text-foreground"
      >
        {ops.map((op) => (
          <option key={op} value={op}>
            {t(`cohorts.form.rules.op.${op}`)}
          </option>
        ))}
      </select>

      <ValueEditor filter={filter} onChange={onChange} />

      <button
        type="button"
        aria-label={t("cohorts.form.rules.removeFilter")}
        onClick={onRemove}
        className="ml-auto flex h-6 w-6 cursor-pointer items-center justify-center rounded-md text-rv-mute-500 transition hover:bg-rv-c3 hover:text-foreground"
      >
        <X size={12} />
      </button>
    </div>
  );
}

function ValueEditor({
  filter,
  onChange,
}: {
  filter: CohortFilter;
  onChange: (next: CohortFilter) => void;
}) {
  const { t } = useTranslation();

  if (filter.op === "in") {
    const values = Array.isArray(filter.value) ? filter.value : [];
    return (
      <ChipInput
        values={values}
        placeholder={t(`cohorts.form.rules.placeholder.${filter.field}`)}
        options={
          filter.field === "store"
            ? STORE_OPTIONS
            : filter.field === "purchaseType"
              ? PURCHASE_TYPE_OPTIONS
              : undefined
        }
        normalise={
          filter.field === "country" ? (v) => v.trim().toUpperCase() : undefined
        }
        onChange={(next) => onChange({ ...filter, value: next })}
      />
    );
  }

  if (filter.op === "eq") {
    return (
      <input
        type="text"
        value={typeof filter.value === "string" ? filter.value : ""}
        placeholder={t(`cohorts.form.rules.placeholder.${filter.field}`)}
        onChange={(e) =>
          onChange({ ...filter, value: e.target.value })
        }
        className="h-7 min-w-[120px] flex-1 rounded border border-rv-divider bg-rv-c1 px-2 text-[12px] text-foreground"
      />
    );
  }

  if (filter.op === "gte" || filter.op === "lte") {
    const v = typeof filter.value === "string" ? filter.value : "";
    return (
      <input
        type="datetime-local"
        value={isoToLocal(v)}
        onChange={(e) =>
          onChange({ ...filter, value: localToIso(e.target.value) })
        }
        className="h-7 rounded border border-rv-divider bg-rv-c1 px-2 text-[12px] text-foreground"
      />
    );
  }

  return null;
}

function ChipInput({
  values,
  placeholder,
  options,
  normalise,
  onChange,
}: {
  values: string[];
  placeholder: string;
  options?: ReadonlyArray<string>;
  normalise?: (v: string) => string;
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState("");

  function commit(raw: string) {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const v = normalise ? normalise(trimmed) : trimmed;
    if (values.includes(v)) {
      setDraft("");
      return;
    }
    onChange([...values, v]);
    setDraft("");
  }

  return (
    <div className="flex min-w-[180px] flex-1 flex-wrap items-center gap-1 rounded border border-rv-divider bg-rv-c1 px-1.5 py-1">
      {values.map((v) => (
        <span
          key={v}
          className="inline-flex items-center gap-1 rounded bg-rv-c2 px-1.5 py-0.5 font-rv-mono text-[11px] text-foreground"
        >
          {v}
          <button
            type="button"
            onClick={() => onChange(values.filter((x) => x !== v))}
            className="cursor-pointer text-rv-mute-500 hover:text-foreground"
            aria-label={`Remove ${v}`}
          >
            ×
          </button>
        </span>
      ))}
      <input
        type="text"
        value={draft}
        placeholder={placeholder}
        list={options ? `chip-${placeholder}` : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit(draft);
          } else if (e.key === "Backspace" && draft === "" && values.length) {
            onChange(values.slice(0, -1));
          }
        }}
        onBlur={() => commit(draft)}
        className="min-w-[80px] flex-1 bg-transparent text-[12px] text-foreground placeholder:text-rv-mute-500 outline-none"
      />
      {options && (
        <datalist id={`chip-${placeholder}`}>
          {options.map((o) => (
            <option key={o} value={o} />
          ))}
        </datalist>
      )}
    </div>
  );
}

function isoToLocal(iso: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  );
}

function localToIso(local: string): string {
  if (!local) return "";
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}
```

- [ ] **Step 5.4: Add i18n keys**

In `apps/dashboard/src/i18n/locales/en.json`, add inside the `cohorts` object:

```json
    "form": {
      "basics": {
        "heading": "Basics",
        "name": "Name",
        "namePlaceholder": "e.g. High-value users",
        "description": "Description",
        "descriptionPlaceholder": "Optional summary of who's in this cohort"
      },
      "rules": {
        "heading": "Rules",
        "matchPrefix": "Match",
        "matchSuffix": "of the following",
        "match": { "all": "all", "any": "any" },
        "emptyHint": "No filters — cohort matches every subscriber.",
        "addFilter": "Add filter",
        "removeFilter": "Remove filter",
        "field": {
          "country": "Country",
          "store": "Store",
          "productId": "Product ID",
          "purchaseType": "Purchase type",
          "firstSeenAfter": "First seen after",
          "firstSeenBefore": "First seen before"
        },
        "op": {
          "eq": "equals",
          "in": "in",
          "gte": "on or after",
          "lte": "on or before"
        },
        "placeholder": {
          "country": "Country (US, CA, …)",
          "store": "apple / google / stripe",
          "productId": "product_id",
          "purchaseType": "subscription / consumable / …",
          "firstSeenAfter": "",
          "firstSeenBefore": ""
        },
        "preview": "JSON preview"
      },
      "submit": {
        "create": "Create cohort",
        "save": "Save changes",
        "cancel": "Cancel",
        "creating": "Creating…",
        "saving": "Saving…"
      },
      "errors": {
        "nameRequired": "Name is required.",
        "nameInUse": "A cohort with this name already exists."
      }
    },
```

- [ ] **Step 5.5: Run — expect pass**

Run: `pnpm --filter @rovenue/dashboard test --run tests/components/cohort-rule-builder.test.tsx`
Expected: PASS — all four tests.

- [ ] **Step 5.6: Commit**

```bash
git add apps/dashboard/src/components/cohorts/cohort-rule-builder.tsx apps/dashboard/tests/components/cohort-rule-builder.test.tsx apps/dashboard/src/i18n/locales/en.json
git commit -m "feat(dashboard/cohorts): CohortRuleBuilder structured editor"
```

---

## Task 6: CohortForm component (TDD)

Single form used by both `cohorts/new` and `cohorts/$cohortId`. Tests assert the create POST body.

**Files:**
- Create: `apps/dashboard/src/components/cohorts/cohort-form.tsx`
- Create: `apps/dashboard/tests/components/cohort-form.test.tsx`

- [ ] **Step 6.1: Write the failing test**

Create `apps/dashboard/tests/components/cohort-form.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeAll, afterAll, beforeEach } from "vitest";
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { fireEvent, waitFor } from "@testing-library/react";
import { handlers } from "../msw/handlers";
import { renderWithRouter } from "../render";
import { CohortForm } from "../../src/components/cohorts/cohort-form";

const server = setupServer(...handlers);
beforeAll(() => server.listen());
afterAll(() => server.close());
beforeEach(() => server.resetHandlers(...handlers));

describe("CohortForm (create)", () => {
  it("submits POST with name + rules and calls onSuccess with the new id", async () => {
    const onSuccess = vi.fn();
    const { getByLabelText, getByText } = renderWithRouter(
      <CohortForm
        mode="create"
        projectId="proj_1"
        onSuccess={onSuccess}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(getByLabelText(/name/i), {
      target: { value: "EU customers" },
    });

    fireEvent.click(getByText(/create cohort/i));

    await waitFor(() => expect(onSuccess).toHaveBeenCalled());
    expect(onSuccess).toHaveBeenCalledWith("coh_new");
  });

  it("shows an inline name error on 409 nameInUse", async () => {
    server.use(
      http.post(
        "http://localhost:3000/dashboard/projects/:projectId/cohorts",
        () =>
          HttpResponse.json(
            { error: { code: "CONFLICT", message: "Cohort name already in use: EU" } },
            { status: 409 },
          ),
      ),
    );

    const { getByLabelText, getByText, findByText } = renderWithRouter(
      <CohortForm
        mode="create"
        projectId="proj_1"
        onSuccess={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    fireEvent.change(getByLabelText(/name/i), { target: { value: "EU" } });
    fireEvent.click(getByText(/create cohort/i));

    expect(await findByText(/already exists/i)).toBeTruthy();
  });

  it("disables submit while name is empty", () => {
    const { getByText } = renderWithRouter(
      <CohortForm
        mode="create"
        projectId="proj_1"
        onSuccess={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
    const btn = getByText(/create cohort/i).closest("button");
    expect(btn?.disabled).toBe(true);
  });
});
```

- [ ] **Step 6.2: Run — expect failure**

Run: `pnpm --filter @rovenue/dashboard test --run tests/components/cohort-form.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 6.3: Implement `cohort-form.tsx`**

Create `apps/dashboard/src/components/cohorts/cohort-form.tsx`:

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import type { CohortRow, CohortRule } from "@rovenue/shared";
import { Button } from "../../ui/button";
import { ApiError } from "../../lib/api";
import {
  useCreateCohort,
  useUpdateCohort,
} from "../../lib/hooks/useProjectCohorts";
import { CohortRuleBuilder } from "./cohort-rule-builder";
import { sanitiseRule } from "./rule-codec";

type Props =
  | {
      mode: "create";
      projectId: string;
      onSuccess: (id: string) => void;
      onCancel: () => void;
    }
  | {
      mode: "edit";
      projectId: string;
      cohort: CohortRow;
      onSuccess: (id: string) => void;
      onCancel: () => void;
    };

const EMPTY_RULE: CohortRule = { match: "all", filters: [] };

export function CohortForm(props: Props) {
  const { t } = useTranslation();
  const initial = props.mode === "edit" ? props.cohort : null;
  const [name, setName] = useState(initial?.name ?? "");
  const [description, setDescription] = useState(initial?.description ?? "");
  const [rule, setRule] = useState<CohortRule>(initial?.rules ?? EMPTY_RULE);
  const [serverError, setServerError] = useState<string | null>(null);

  const create = useCreateCohort(props.projectId);
  const update = useUpdateCohort(props.projectId);
  const pending = create.isPending || update.isPending;

  const trimmedName = name.trim();
  const canSubmit = trimmedName.length > 0 && !pending;

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);
    const payload = {
      name: trimmedName,
      description: description.trim() === "" ? null : description.trim(),
      rules: sanitiseRule(rule),
    };

    try {
      if (props.mode === "create") {
        const res = await create.mutateAsync(payload);
        props.onSuccess(res.cohort.id);
      } else {
        const res = await update.mutateAsync({
          id: props.cohort.id,
          ...payload,
        });
        props.onSuccess(res.cohort.id);
      }
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setServerError(t("cohorts.form.errors.nameInUse"));
      } else if (err instanceof Error) {
        setServerError(err.message);
      } else {
        setServerError(t("common.unknownError"));
      }
    }
  }

  const submitLabel =
    props.mode === "create"
      ? pending
        ? t("cohorts.form.submit.creating")
        : t("cohorts.form.submit.create")
      : pending
        ? t("cohorts.form.submit.saving")
        : t("cohorts.form.submit.save");

  return (
    <form onSubmit={onSubmit} className="flex flex-col gap-4">
      <section className="rounded-lg border border-rv-divider bg-rv-c1">
        <header className="border-b border-rv-divider px-4 py-3">
          <h2 className="text-[13px] font-medium">
            {t("cohorts.form.basics.heading")}
          </h2>
        </header>
        <div className="flex flex-col gap-3 px-4 py-3">
          <label className="flex flex-col gap-1 text-[12px] text-rv-mute-600">
            {t("cohorts.form.basics.name")}
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("cohorts.form.basics.namePlaceholder")}
              className="h-8 rounded border border-rv-divider bg-rv-c2 px-2 text-[13px] text-foreground"
            />
            {serverError && (
              <span className="text-[11px] text-rv-danger">{serverError}</span>
            )}
          </label>
          <label className="flex flex-col gap-1 text-[12px] text-rv-mute-600">
            {t("cohorts.form.basics.description")}
            <textarea
              value={description ?? ""}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("cohorts.form.basics.descriptionPlaceholder")}
              rows={2}
              className="rounded border border-rv-divider bg-rv-c2 px-2 py-1.5 text-[13px] text-foreground"
            />
          </label>
        </div>
      </section>

      <section className="rounded-lg border border-rv-divider bg-rv-c1">
        <header className="border-b border-rv-divider px-4 py-3">
          <h2 className="text-[13px] font-medium">
            {t("cohorts.form.rules.heading")}
          </h2>
        </header>
        <div className="flex flex-col gap-3 px-4 py-3">
          <CohortRuleBuilder rule={rule} onChange={setRule} />
          <details className="text-[11px] text-rv-mute-500">
            <summary className="cursor-pointer select-none">
              {t("cohorts.form.rules.preview")}
            </summary>
            <pre className="mt-1 overflow-auto rounded bg-rv-c2 p-2 font-rv-mono text-[11px] text-foreground">
              {JSON.stringify(sanitiseRule(rule), null, 2)}
            </pre>
          </details>
        </div>
      </section>

      <div className="flex justify-end gap-2">
        <Button
          type="button"
          variant="flat"
          size="sm"
          onClick={props.onCancel}
        >
          {t("cohorts.form.submit.cancel")}
        </Button>
        <Button
          type="submit"
          variant="solid-primary"
          size="sm"
          disabled={!canSubmit}
        >
          {submitLabel}
        </Button>
      </div>
    </form>
  );
}
```

If `ApiError` is not the actual exported name (verify by `grep -rn "class ApiError" apps/dashboard/src/lib`), substitute the correct error class name + `status` field accessor. Most likely path: `apps/dashboard/src/lib/api.ts`.

- [ ] **Step 6.4: Run — expect pass**

Run: `pnpm --filter @rovenue/dashboard test --run tests/components/cohort-form.test.tsx`
Expected: PASS — all three tests.

- [ ] **Step 6.5: Commit**

```bash
git add apps/dashboard/src/components/cohorts/cohort-form.tsx apps/dashboard/tests/components/cohort-form.test.tsx
git commit -m "feat(dashboard/cohorts): CohortForm with create/edit modes"
```

---

## Task 7: New cohort route

**Files:**
- Create: `apps/dashboard/src/routes/_authed/projects/$projectId/cohorts/new.tsx`

- [ ] **Step 7.1: Write the route**

Create `apps/dashboard/src/routes/_authed/projects/$projectId/cohorts/new.tsx`:

```tsx
import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { CohortForm } from "../../../../../components/cohorts/cohort-form";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/cohorts/new",
)({
  component: NewCohortRouteComponent,
});

function NewCohortRouteComponent() {
  const { t } = useTranslation();
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/cohorts/new",
  });
  const navigate = useNavigate();

  return (
    <>
      <header className="pb-5">
        <h1 className="text-[24px] font-semibold leading-8 tracking-tight">
          {t("cohorts.new.title")}
        </h1>
        <p className="mt-0.5 text-[13px] text-rv-mute-500">
          {t("cohorts.new.subtitle")}
        </p>
      </header>

      <CohortForm
        mode="create"
        projectId={projectId}
        onSuccess={(id) =>
          navigate({
            to: "/_authed/projects/$projectId/cohorts",
            params: { projectId },
            search: { selected: id },
          })
        }
        onCancel={() =>
          navigate({
            to: "/_authed/projects/$projectId/cohorts",
            params: { projectId },
          })
        }
      />
    </>
  );
}
```

The exact navigate path strings depend on the TanStack route tree TypeScript codegen — adjust to whatever the existing `audiences/new.tsx` route uses for the `to:` argument. Use the same form.

- [ ] **Step 7.2: Add i18n keys**

In `apps/dashboard/src/i18n/locales/en.json` under `cohorts`:

```json
    "new": {
      "title": "New cohort",
      "subtitle": "Group subscribers by behaviour or acquisition channel."
    },
```

- [ ] **Step 7.3: Verify the route compiles & registers**

Run: `pnpm --filter @rovenue/dashboard typecheck`
Expected: No new errors. The TanStack Router codegen file `routeTree.gen.ts` should pick the route up on the next `pnpm dev` / build; if your setup runs codegen at build, run `pnpm --filter @rovenue/dashboard build` once to refresh it.

- [ ] **Step 7.4: Commit**

```bash
git add apps/dashboard/src/routes/_authed/projects/$projectId/cohorts/new.tsx apps/dashboard/src/i18n/locales/en.json
git commit -m "feat(dashboard/cohorts): /cohorts/new route"
```

---

## Task 8: Edit + delete route

**Files:**
- Create: `apps/dashboard/src/routes/_authed/projects/$projectId/cohorts/$cohortId.tsx`

- [ ] **Step 8.1: Write the route**

Create `apps/dashboard/src/routes/_authed/projects/$projectId/cohorts/$cohortId.tsx`:

```tsx
import { useEffect } from "react";
import {
  createFileRoute,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Trash2 } from "lucide-react";
import { Button } from "../../../../../ui/button";
import { CohortForm } from "../../../../../components/cohorts/cohort-form";
import {
  useCohortById,
  useDeleteCohort,
} from "../../../../../lib/hooks/useProjectCohorts";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/cohorts/$cohortId",
)({
  component: EditCohortRouteComponent,
});

function EditCohortRouteComponent() {
  const { t } = useTranslation();
  const { projectId, cohortId } = useParams({
    from: "/_authed/projects/$projectId/cohorts/$cohortId",
  });
  const navigate = useNavigate();

  const detail = useCohortById(projectId, cohortId);
  const del = useDeleteCohort(projectId);

  useEffect(() => {
    if (detail.error) {
      navigate({
        to: "/_authed/projects/$projectId/cohorts",
        params: { projectId },
      });
    }
  }, [detail.error, navigate, projectId]);

  if (detail.isLoading || !detail.data) {
    return <div className="py-10 text-[13px] text-rv-mute-500">{t("common.loading")}</div>;
  }

  const cohort = detail.data.cohort;

  async function onDelete() {
    const ok = window.confirm(
      t("cohorts.delete.confirm", { name: cohort.name }),
    );
    if (!ok) return;
    await del.mutateAsync(cohort.id);
    navigate({
      to: "/_authed/projects/$projectId/cohorts",
      params: { projectId },
    });
  }

  return (
    <>
      <header className="flex items-start justify-between pb-5">
        <div>
          <h1 className="text-[24px] font-semibold leading-8 tracking-tight">
            {t("cohorts.edit.title")}
          </h1>
          <p className="mt-0.5 text-[13px] text-rv-mute-500">
            {t("cohorts.edit.subtitle", { name: cohort.name })}
          </p>
        </div>
        <Button
          type="button"
          variant="flat"
          size="sm"
          onClick={onDelete}
          disabled={del.isPending}
        >
          <Trash2 size={12} />
          {t("cohorts.actions.delete")}
        </Button>
      </header>

      <CohortForm
        mode="edit"
        projectId={projectId}
        cohort={cohort}
        onSuccess={(id) =>
          navigate({
            to: "/_authed/projects/$projectId/cohorts",
            params: { projectId },
            search: { selected: id },
          })
        }
        onCancel={() =>
          navigate({
            to: "/_authed/projects/$projectId/cohorts",
            params: { projectId },
          })
        }
      />
    </>
  );
}
```

- [ ] **Step 8.2: Add i18n keys**

In `apps/dashboard/src/i18n/locales/en.json` under `cohorts`:

```json
    "edit": {
      "title": "Edit cohort",
      "subtitle": "Editing {{name}}"
    },
    "actions": {
      "delete": "Delete"
    },
    "delete": {
      "confirm": "Delete cohort '{{name}}'?"
    },
```

If the `cohorts.actions` object already exists, **merge** the `delete` key in rather than overwriting.

- [ ] **Step 8.3: Verify**

Run: `pnpm --filter @rovenue/dashboard typecheck`
Expected: No new errors.

- [ ] **Step 8.4: Commit**

```bash
git add apps/dashboard/src/routes/_authed/projects/$projectId/cohorts/\$cohortId.tsx apps/dashboard/src/i18n/locales/en.json
git commit -m "feat(dashboard/cohorts): /cohorts/\$cohortId edit + delete route"
```

---

## Task 9: CohortDefinitionCard — read-only summary of real rules

Convert the existing `cohort-builder.tsx` from a mock-driven editor to a read-only summary of the selected cohort's rules with an "Edit" link.

**Files:**
- Modify: `apps/dashboard/src/components/cohorts/cohort-builder.tsx`
- Modify: `apps/dashboard/src/components/cohorts/index.ts`

- [ ] **Step 9.1: Rewrite `cohort-builder.tsx`**

Replace the file contents:

```tsx
import { useTranslation } from "react-i18next";
import { Link } from "@tanstack/react-router";
import type { CohortFilter, CohortRow } from "@rovenue/shared";
import { Button } from "../../ui/button";
import { QueryChip } from "./query-chip";

type Props = {
  projectId: string;
  cohort: CohortRow;
  matchCount: number | null;
  refreshedLabel: string;
};

function describeValue(f: CohortFilter): string {
  if (Array.isArray(f.value)) return `[${f.value.join(", ")}]`;
  if (typeof f.value === "object" && f.value !== null && "min" in f.value)
    return `${f.value.min}–${f.value.max}`;
  return String(f.value);
}

export function CohortDefinitionCard({
  projectId,
  cohort,
  matchCount,
  refreshedLabel,
}: Props) {
  const { t } = useTranslation();
  const filters = cohort.rules.filters;
  const join =
    cohort.rules.match === "any"
      ? t("cohorts.builder.or")
      : t("cohorts.builder.and");

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-4 py-3.5">
      <header className="mb-3 flex items-center justify-between">
        <h4 className="m-0 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
          {t("cohorts.builder.heading")}
        </h4>
        <div className="flex gap-1.5">
          <Link
            to="/_authed/projects/$projectId/cohorts/$cohortId"
            params={{ projectId, cohortId: cohort.id }}
          >
            <Button variant="flat" size="sm" className="h-[26px]">
              {t("cohorts.builder.edit")}
            </Button>
          </Link>
        </div>
      </header>

      {filters.length === 0 ? (
        <p className="m-0 text-[12px] text-rv-mute-500">
          {t("cohorts.builder.noFilters")}
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {filters.map((f, idx) => (
            <span key={`${f.field}-${idx}`} className="contents">
              <QueryChip
                attribute={t(`cohorts.form.rules.field.${f.field}`)}
                op={t(`cohorts.form.rules.op.${f.op}`)}
                value={describeValue(f)}
              />
              {idx < filters.length - 1 && (
                <span className="text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
                  {join}
                </span>
              )}
            </span>
          ))}
        </div>
      )}

      <div className="mt-3 text-right font-rv-mono text-[11px] text-rv-mute-500">
        {matchCount == null
          ? t("cohorts.builder.matchesUnknown")
          : t("cohorts.builder.matches", {
              count: matchCount.toLocaleString(),
              ago: refreshedLabel,
            })}
      </div>
    </section>
  );
}
```

- [ ] **Step 9.2: Update the barrel export**

In `apps/dashboard/src/components/cohorts/index.ts`, replace the `CohortBuilder` export with:

```ts
export { CohortDefinitionCard } from "./cohort-builder";
```

- [ ] **Step 9.3: Add i18n keys**

In `apps/dashboard/src/i18n/locales/en.json`, ensure under `cohorts.builder`:

```json
      "edit": "Edit",
      "or": "OR",
      "and": "AND",
      "noFilters": "No filters — cohort matches every subscriber.",
      "matchesUnknown": "Match count unavailable"
```

(Keep the existing `heading`, `matches`, `refreshedAgo` keys.)

- [ ] **Step 9.4: Commit**

```bash
git add apps/dashboard/src/components/cohorts/cohort-builder.tsx apps/dashboard/src/components/cohorts/index.ts apps/dashboard/src/i18n/locales/en.json
git commit -m "refactor(dashboard/cohorts): cohort-builder becomes read-only CohortDefinitionCard"
```

---

## Task 10: Wire the main cohorts route to real data

Rewrite `cohorts.tsx` to consume real hooks, with `?selected=<id>` search-param selection, empty state, and error handling.

**Files:**
- Modify: `apps/dashboard/src/routes/_authed/projects/$projectId/cohorts.tsx`

- [ ] **Step 10.1: Rewrite the route**

Replace the contents of `apps/dashboard/src/routes/_authed/projects/$projectId/cohorts.tsx`:

```tsx
import { useEffect, useMemo, useState } from "react";
import {
  createFileRoute,
  Link,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { z } from "zod";
import { BookOpen, Download, Plus } from "lucide-react";
import { Button } from "../../../../ui/button";
import { StatCard } from "../../../../ui/stat-card";
import { useProject } from "../../../../lib/hooks/useProject";
import {
  useCohortRetention,
  useProjectCohorts,
} from "../../../../lib/hooks/useProjectCohorts";
import {
  CohortDefinitionCard,
  CohortHero,
  CountryBreakdown,
  KPI_VALUES,
  LtvCurves,
  MockBadge,
  RetentionHeatmap,
  SavedCohortsRail,
  SyncDestinations,
  w4Pct,
  type RetentionMetric,
} from "../../../../components/cohorts";

const searchSchema = z.object({
  selected: z.string().optional(),
});

export const Route = createFileRoute(
  "/_authed/projects/$projectId/cohorts",
)({
  component: CohortsRouteComponent,
  validateSearch: searchSchema,
});

function CohortsRouteComponent() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/cohorts",
  });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <CohortsPage projectId={projectId} />;
}

function CohortsPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const search = useSearch({
    from: "/_authed/projects/$projectId/cohorts",
  });

  const list = useProjectCohorts(projectId);
  const cohorts = list.data?.cohorts ?? [];

  const selectedId = useMemo(() => {
    if (search.selected && cohorts.some((c) => c.id === search.selected)) {
      return search.selected;
    }
    return cohorts[0]?.id ?? null;
  }, [search.selected, cohorts]);

  // Reconcile the URL if the selected id is missing or invalid.
  useEffect(() => {
    if (
      search.selected &&
      cohorts.length > 0 &&
      !cohorts.some((c) => c.id === search.selected)
    ) {
      navigate({
        to: "/_authed/projects/$projectId/cohorts",
        params: { projectId },
        search: selectedId ? { selected: selectedId } : {},
        replace: true,
      });
    }
  }, [search.selected, cohorts, selectedId, navigate, projectId]);

  const selected = cohorts.find((c) => c.id === selectedId) ?? null;

  const retention = useCohortRetention({
    projectId,
    id: selectedId ?? "",
    granularity: "week",
    periods: 13,
  });

  const [metric, setMetric] = useState<RetentionMetric>("retention");

  const onSelect = (id: string) =>
    navigate({
      to: "/_authed/projects/$projectId/cohorts",
      params: { projectId },
      search: { selected: id },
      replace: true,
    });

  const goNew = () =>
    navigate({
      to: "/_authed/projects/$projectId/cohorts/new",
      params: { projectId },
    });

  const retentionPoints = retention.data?.points ?? [];
  const retentionSize = retention.data?.size ?? null;
  const retentionW4 = retention.data ? w4Pct(retention.data.points) : null;
  const retentionError = retention.error
    ? t("cohorts.hero.retentionFailed")
    : null;
  const refreshedLabel = retention.dataUpdatedAt
    ? new Date(retention.dataUpdatedAt).toLocaleTimeString()
    : "—";

  return (
    <>
      <header className="flex flex-wrap items-start justify-between gap-3 pb-5">
        <div className="max-w-3xl">
          <h1 className="text-[24px] font-semibold leading-8 tracking-tight">
            {t("cohorts.title")}
          </h1>
          <p className="mt-0.5 text-[13px] text-rv-mute-500">
            {t("cohorts.subtitle")}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="flat" size="sm">
            <BookOpen size={13} />
            {t("cohorts.actions.howCohortsWork")}
          </Button>
          <Button variant="flat" size="sm">
            <Download size={13} />
            {t("cohorts.actions.exportCsv")}
          </Button>
          <Button variant="solid-primary" size="sm" onClick={goNew}>
            <Plus size={13} />
            {t("cohorts.actions.newCohort")}
          </Button>
        </div>
      </header>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard
          label={t("cohorts.kpi.saved")}
          value={cohorts.length}
          description={t("cohorts.kpi.savedBreakdown", {
            groups: KPI_VALUES.groupCount,
            synced: KPI_VALUES.syncedCount,
          })}
        />
        <StatCard
          label={
            <span className="inline-flex items-center gap-1.5">
              {t("cohorts.kpi.avgRetention")}
              <MockBadge />
            </span>
          }
          value="40.1%"
          description={t("cohorts.kpi.avgRetentionDelta", {
            value: KPI_VALUES.avgRetentionDelta,
          })}
          descriptionTone="success"
        />
        <StatCard
          label={
            <span className="inline-flex items-center gap-1.5">
              {t("cohorts.kpi.bestCohort")}
              <MockBadge />
            </span>
          }
          value="—"
          description={t("cohorts.kpi.bestCohortPending")}
        />
        <StatCard
          label={
            <span className="inline-flex items-center gap-1.5">
              {t("cohorts.kpi.blendedLtv")}
              <MockBadge />
            </span>
          }
          value={KPI_VALUES.blendedLtv}
          description={t("cohorts.kpi.blendedLtvDelta", {
            value: KPI_VALUES.blendedLtvDelta,
          })}
          descriptionTone="success"
        />
      </div>

      <div className="grid items-start gap-4 max-[1280px]:grid-cols-1 grid-cols-[260px_minmax(0,1fr)]">
        <SavedCohortsRail
          cohorts={cohorts}
          selectedId={selectedId}
          onSelect={onSelect}
          onNew={goNew}
        />

        <div className="flex flex-col gap-4">
          {list.isLoading && cohorts.length === 0 ? (
            <div className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-10 text-center text-[13px] text-rv-mute-500">
              {t("common.loading")}
            </div>
          ) : list.error ? (
            <div className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-10 text-center">
              <p className="text-[13px] text-rv-danger">
                {t("cohorts.list.loadFailed")}
              </p>
              <div className="mt-3 inline-flex">
                <Button
                  variant="flat"
                  size="sm"
                  onClick={() => list.refetch()}
                >
                  {t("common.retry")}
                </Button>
              </div>
            </div>
          ) : !selected ? (
            <EmptyState onNew={goNew} />
          ) : (
            <>
              <CohortHero
                cohort={selected}
                size={retentionSize}
                w4Pct={retentionW4}
              />
              <CohortDefinitionCard
                projectId={projectId}
                cohort={selected}
                matchCount={retentionSize}
                refreshedLabel={refreshedLabel}
              />
              <RetentionHeatmap
                cohortName={selected.name}
                metric={metric}
                onMetricChange={setMetric}
                points={retentionPoints}
                size={retentionSize}
                loading={retention.isLoading}
                error={retentionError}
                onRetry={() => retention.refetch()}
              />

              <div className="grid gap-4 lg:grid-cols-[1.4fr_1fr]">
                <div className="relative">
                  <div className="absolute right-3 top-3 z-10">
                    <MockBadge />
                  </div>
                  <LtvCurves />
                </div>
                <div className="relative">
                  <div className="absolute right-3 top-3 z-10">
                    <MockBadge />
                  </div>
                  <CountryBreakdown />
                </div>
              </div>

              <div className="relative">
                <div className="absolute right-3 top-3 z-10">
                  <MockBadge />
                </div>
                <SyncDestinations />
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function EmptyState({ onNew }: { onNew: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-12 text-center">
      <h3 className="text-[15px] font-semibold">{t("cohorts.hero.emptyState")}</h3>
      <p className="mt-1 text-[12px] text-rv-mute-500">
        {t("cohorts.list.emptyCta")}
      </p>
      <div className="mt-4 inline-flex">
        <Button variant="solid-primary" size="sm" onClick={onNew}>
          <Plus size={13} />
          {t("cohorts.actions.newCohort")}
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 10.2: Add the remaining i18n keys**

In `apps/dashboard/src/i18n/locales/en.json` under `cohorts`:

```json
    "kpi": {
      "bestCohortPending": "Awaiting aggregate endpoint"
    },
    "hero": {
      "emptyState": "Create your first cohort to see retention",
      "retentionFailed": "Couldn't load retention",
      "defaultGroup": "Cohort"
    },
    "list": {
      "allHeading": "All cohorts",
      "empty": "No cohorts yet",
      "emptyCta": "Group your subscribers by behaviour or acquisition channel.",
      "loadFailed": "Couldn't load cohorts."
    },
    "saved": {
      "filterEmpty": "No cohorts match this filter."
    },
    "retention": {
      "activation": "W0",
      "loading": "Loading retention…"
    },
```

If any of those subtrees already exist (e.g., `cohorts.kpi`), **merge** the new keys instead of overwriting the object.

- [ ] **Step 10.3: Verify typecheck and dev render**

Run: `pnpm --filter @rovenue/dashboard typecheck`
Expected: PASS.

Run: `pnpm --filter @rovenue/dashboard dev` and navigate to `http://localhost:5173/projects/<a real project id>/cohorts`. Confirm:
- The saved-rail loads real cohorts from the API (or shows the empty state when there are none).
- Clicking a row updates `?selected=<id>` in the URL and the hero/heatmap re-renders.
- Clicking "+ New cohort" navigates to `/cohorts/new`.
- The four mock-badged panels show the "MOCK" pill.

- [ ] **Step 10.4: Commit**

```bash
git add apps/dashboard/src/routes/_authed/projects/$projectId/cohorts.tsx apps/dashboard/src/i18n/locales/en.json
git commit -m "feat(dashboard/cohorts): wire main route to real list + retention"
```

---

## Task 11: Route-level end-to-end test

Smoke-test the whole flow at the route level: page renders the real cohort, "+ New cohort" navigates, create returns and shows the new row.

**Files:**
- Create: `apps/dashboard/tests/routes/cohorts.test.tsx`

- [ ] **Step 11.1: Write the test**

Create `apps/dashboard/tests/routes/cohorts.test.tsx`:

```tsx
import { describe, expect, it, beforeAll, afterAll, beforeEach } from "vitest";
import { setupServer } from "msw/node";
import { fireEvent, waitFor } from "@testing-library/react";
import { I18nProvider } from "@heroui/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRoute,
  createRootRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { render } from "@testing-library/react";
import { handlers } from "../msw/handlers";

const server = setupServer(...handlers);
beforeAll(() => server.listen());
afterAll(() => server.close());
beforeEach(() => server.resetHandlers(...handlers));

// We re-import the route component dynamically to avoid pulling in
// the file-route registration (TanStack codegen) for an in-test tree.
async function renderRoute(initialPath: string) {
  const mod = await import(
    "../../src/routes/_authed/projects/$projectId/cohorts"
  );
  const Component = mod.Route.options.component!;
  const rootRoute = createRootRoute({ component: Outlet });
  const route = createRoute({
    getParentRoute: () => rootRoute,
    path: "/_authed/projects/$projectId/cohorts",
    component: Component,
    validateSearch: mod.Route.options.validateSearch,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <I18nProvider>
      <QueryClientProvider client={qc}>
        <RouterProvider router={router as never} />
      </QueryClientProvider>
    </I18nProvider>,
  );
}

describe("cohorts route", () => {
  it("renders the real cohort from the API and selects it by default", async () => {
    const { findByText } = await renderRoute(
      "/_authed/projects/proj_1/cohorts",
    );
    expect(await findByText("High-value users")).toBeTruthy();
    // Hero size derived from retention.size
    expect(await findByText(/4,821/)).toBeTruthy();
    // W4 cell from retention.points[4].pct
    expect(await findByText(/62\.4%/)).toBeTruthy();
  });

  it("clicking + New cohort navigates to the create route", async () => {
    const { findByText, container } = await renderRoute(
      "/_authed/projects/proj_1/cohorts",
    );
    await findByText("High-value users");
    fireEvent.click(await findByText(/new cohort/i));
    await waitFor(() => {
      expect(window.location.pathname).toBe(
        "/_authed/projects/proj_1/cohorts/new",
      );
    });
    expect(container).toBeTruthy();
  });
});
```

If `window.location.pathname` does not change in the memory-history router (it usually doesn't — TanStack tracks navigation internally), assert via the router state instead. Adjust the test to: capture the `router` instance returned by `renderRoute`, then `expect(router.state.location.pathname).toBe(…)`. Refactor `renderRoute` to return both the `render` result and the router.

- [ ] **Step 11.2: Run — expect pass**

Run: `pnpm --filter @rovenue/dashboard test --run tests/routes/cohorts.test.tsx`
Expected: PASS.

- [ ] **Step 11.3: Commit**

```bash
git add apps/dashboard/tests/routes/cohorts.test.tsx
git commit -m "test(dashboard/cohorts): route-level smoke for list + new navigation"
```

---

## Task 12: Final cleanup

Sweep for dead code, dead i18n keys, and dangling references to the old mock UI types.

**Files:**
- Modify: `apps/dashboard/src/components/cohorts/types.ts`
- Modify: `apps/dashboard/src/components/cohorts/mock-data.ts`
- Modify: `apps/dashboard/src/components/cohorts/index.ts`
- Modify: `apps/dashboard/src/i18n/locales/en.json`

- [ ] **Step 12.1: Drop dead UI types**

In `apps/dashboard/src/components/cohorts/types.ts`, remove:
- `SavedCohort` (replaced by `CohortRow` from `@rovenue/shared`)
- `CohortGroupKey`
- `CohortDot`
- The local `CohortRow` UI type (the heatmap row shape — its only consumer was the retention heatmap, which now builds the row inline from `CohortRetentionPoint`).

Keep `CohortMember`, `Condition`, `CountryBreakdown`, `LtvCurve`, `SyncDestination`, `SyncDestinationStatus`, `RetentionMetric`.

- [ ] **Step 12.2: Trim `mock-data.ts` further**

Remove any helpers that only served the deleted types (notably anything that built `SavedCohort` arrays).

- [ ] **Step 12.3: Drop dead i18n keys**

In `apps/dashboard/src/i18n/locales/en.json`, search for the following keys under `cohorts` and **delete** any that no consumer references after the rewrite:

```
cohorts.builder.save              # replaced by `edit`
cohorts.builder.duplicate         # duplicate affordance is Phase 2
cohorts.builder.cohortBy          # legacy "cohort by …" chips
cohorts.builder.bucket
cohorts.builder.anchorValue
cohorts.builder.bucketValue
cohorts.builder.anchor
cohorts.builder.include
cohorts.builder.exclude
cohorts.builder.addCondition
cohorts.saved.groups.Behavior
cohorts.saved.groups.Lifecycle
cohorts.saved.groups.Risk
cohorts.saved.groups.Acquisition
cohorts.hero.sizeDelta
cohorts.hero.w4RetentionValue
cohorts.hero.w4RetentionDelta
cohorts.hero.ltv90Value       (if no longer used; the hero now relies on mock badge + same key)
cohorts.kpi.bestCohortValue
cohorts.kpi.bestCohortUsers
```

For each key listed, run `grep -rn "<key>"` under `apps/dashboard/src` first and only delete keys with zero remaining references. If a key is still referenced, leave it.

- [ ] **Step 12.4: Run the full dashboard test + typecheck**

Run: `pnpm --filter @rovenue/dashboard test --run && pnpm --filter @rovenue/dashboard typecheck`
Expected: PASS for both.

- [ ] **Step 12.5: Commit**

```bash
git add apps/dashboard/src/components/cohorts/ apps/dashboard/src/i18n/locales/en.json
git commit -m "chore(dashboard/cohorts): drop dead UI types and i18n keys"
```

---

## Self-review notes

- **Spec coverage check**: every section of `2026-05-26-cohorts-crud-design.md` maps to at least one task — MSW handlers (T1), saved-rail/hero/heatmap accept real data (T2), rule builder (T4, T5), form (T6), routes (T7, T8), definition card (T9), main route wiring with search-param + empty/error states + mock-badged panels (T10), route smoke test (T11), cleanup (T12).
- **No backend tests** — spec confirms no backend changes.
- **Type continuity**: `CohortRow`, `CohortRule`, `CohortFilter`, `CohortFilterField`, `CohortOperator`, `CohortRetentionPoint`, `CohortRetentionResponse` all come from `@rovenue/shared` — used consistently across `rule-codec.ts`, `cohort-rule-builder.tsx`, `cohort-form.tsx`, `cohort-builder.tsx` (the renamed definition card), `cohort-hero.tsx`, `retention-heatmap.tsx`, and the main route.
- **TanStack `to:` strings** depend on the generated `routeTree.gen.ts` in this codebase. Adopt the same form used by the existing audience routes (committed today) when in doubt.
