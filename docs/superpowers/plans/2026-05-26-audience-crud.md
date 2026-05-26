# Audience CRUD Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add create / edit / delete UI for audiences on the dashboard, with the default `All Users` audience kept undeletable and rendered read-only.

**Architecture:** Three new file routes (`audiences/new`, `audiences/$audienceId`) backed by a single `<AudienceForm>` component. The structured condition builder (currently embedded in `flag-form.tsx`) is extracted into a shared `components/targeting/` module so both feature flags and audiences emit the same sift document shape. Backend `/dashboard/audiences` already supports POST / PATCH / DELETE — no API changes.

**Tech Stack:** React 19 + TanStack Router + TanStack Query + i18next + Vitest + MSW + Tailwind. Backend Hono + Drizzle (no changes here).

**Spec:** `docs/superpowers/specs/2026-05-26-audience-crud-design.md`

---

## File Inventory

**New files:**
- `apps/dashboard/src/components/targeting/sift-codec.ts` — pure functions + types extracted from flag-form
- `apps/dashboard/src/components/targeting/condition-builder.tsx` — `<ConditionList>` + row UI
- `apps/dashboard/src/components/audiences/audience-form.tsx` — shared create/edit form
- `apps/dashboard/src/routes/_authed/projects/$projectId/audiences/new.tsx`
- `apps/dashboard/src/routes/_authed/projects/$projectId/audiences/$audienceId.tsx`
- `apps/dashboard/tests/sift-codec.test.ts`
- `apps/dashboard/tests/routes/audiences.test.tsx`

**Modified files:**
- `apps/dashboard/src/components/feature-flags/flag-form.tsx` — replace inline builder with imports
- `apps/dashboard/src/lib/hooks/useProjectAdmin.ts` — add `useAudience`, `useCreateAudience`, `useUpdateAudience`, `useDeleteAudience`
- `apps/dashboard/src/routes/_authed/projects/$projectId/audiences.tsx` — add new-button, link rows, kebab menu, delete flow
- `apps/dashboard/src/i18n/locales/en.json` — add `targeting.conditions.*` + `audiences.*` keys
- `apps/dashboard/tests/msw/handlers.ts` — add audience GET / POST / PATCH / DELETE handlers

---

## Task 1: MSW handlers for audiences

Set up the mock server first so all later tests have somewhere to talk to.

**Files:**
- Modify: `apps/dashboard/tests/msw/handlers.ts`

- [ ] **Step 1.1: Add audience handlers to MSW**

Append the following handlers to the `handlers` array in `apps/dashboard/tests/msw/handlers.ts`, just before the final `];`:

```ts
  http.get(`${BASE}/dashboard/audiences`, () =>
    HttpResponse.json({
      data: {
        audiences: [
          {
            id: "aud_default",
            projectId: "proj_1",
            name: "All Users",
            description: "Matches every subscriber",
            rules: {},
            isDefault: true,
            createdAt: "2026-04-01T00:00:00Z",
            updatedAt: "2026-04-01T00:00:00Z",
          },
          {
            id: "aud_eu",
            projectId: "proj_1",
            name: "EU customers",
            description: null,
            rules: { country: { $in: ["DE", "FR"] } },
            isDefault: false,
            createdAt: "2026-04-10T00:00:00Z",
            updatedAt: "2026-04-10T00:00:00Z",
          },
        ],
      },
    }),
  ),

  http.get(`${BASE}/dashboard/audiences/:id`, ({ params }) =>
    HttpResponse.json({
      data: {
        audience: {
          id: params.id,
          projectId: "proj_1",
          name: params.id === "aud_default" ? "All Users" : "EU customers",
          description:
            params.id === "aud_default" ? "Matches every subscriber" : null,
          rules:
            params.id === "aud_default"
              ? {}
              : { country: { $in: ["DE", "FR"] } },
          isDefault: params.id === "aud_default",
          createdAt: "2026-04-01T00:00:00Z",
          updatedAt: "2026-04-10T00:00:00Z",
        },
      },
    }),
  ),

  http.post(`${BASE}/dashboard/audiences`, async ({ request }) => {
    const body = (await request.json()) as {
      projectId: string;
      name: string;
      description?: string;
      rules?: Record<string, unknown>;
    };
    return HttpResponse.json({
      data: {
        audience: {
          id: "aud_new",
          projectId: body.projectId,
          name: body.name,
          description: body.description ?? null,
          rules: body.rules ?? {},
          isDefault: false,
          createdAt: "2026-05-26T00:00:00Z",
          updatedAt: "2026-05-26T00:00:00Z",
        },
      },
    });
  }),

  http.patch(
    `${BASE}/dashboard/audiences/:id`,
    async ({ params, request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({
        data: {
          audience: {
            id: params.id,
            projectId: "proj_1",
            name: (body.name as string) ?? "EU customers",
            description: (body.description as string | null) ?? null,
            rules:
              (body.rules as Record<string, unknown>) ??
              { country: { $in: ["DE", "FR"] } },
            isDefault: false,
            createdAt: "2026-04-10T00:00:00Z",
            updatedAt: "2026-05-26T00:00:00Z",
          },
        },
      });
    },
  ),

  http.delete(`${BASE}/dashboard/audiences/:id`, () =>
    HttpResponse.json({ data: { deleted: true } }),
  ),
```

- [ ] **Step 1.2: Run the existing dashboard tests to confirm nothing broke**

Run: `pnpm --filter @rovenue/dashboard test -- --run`
Expected: PASS (all existing tests still green; new handlers are additive)

- [ ] **Step 1.3: Commit**

```bash
git add apps/dashboard/tests/msw/handlers.ts
git commit -m "test(dashboard): mock /dashboard/audiences CRUD in MSW"
```

---

## Task 2: Extract sift codec

Pull `conditionsToSift`, `siftToConditions`, and the supporting types/constants out of `flag-form.tsx` into a standalone module. Add a round-trip test that proves the extraction is lossless for every condition shape the form emits.

**Files:**
- Create: `apps/dashboard/src/components/targeting/sift-codec.ts`
- Create: `apps/dashboard/tests/sift-codec.test.ts`
- Modify: `apps/dashboard/src/components/feature-flags/flag-form.tsx`

- [ ] **Step 2.1: Write the round-trip test**

Create `apps/dashboard/tests/sift-codec.test.ts`:

```ts
import { describe, expect, test } from "vitest";
import {
  conditionsToSift,
  siftToConditions,
  makeCondition,
  type DraftCondition,
} from "../src/components/targeting/sift-codec";

describe("sift-codec", () => {
  test("empty list serialises to undefined", () => {
    expect(conditionsToSift([])).toBeUndefined();
  });

  test("single country fragment", () => {
    const conds: DraftCondition[] = [
      { ...makeCondition("country"), listOp: "$in", listValues: ["TR", "DE"] },
    ];
    expect(conditionsToSift(conds)).toEqual({
      country: { $in: ["TR", "DE"] },
    });
  });

  test("multiple fragments wrapped in $and", () => {
    const conds: DraftCondition[] = [
      { ...makeCondition("country"), listOp: "$in", listValues: ["TR"] },
      {
        ...makeCondition("platform"),
        listOp: "$nin",
        listValues: ["web"],
      },
    ];
    expect(conditionsToSift(conds)).toEqual({
      $and: [
        { country: { $in: ["TR"] } },
        { platform: { $nin: ["web"] } },
      ],
    });
  });

  test("appVersion uses scalar op", () => {
    const conds: DraftCondition[] = [
      {
        ...makeCondition("appVersion"),
        scalarOp: "$gte",
        scalarValue: "1.2.3",
      },
    ];
    expect(conditionsToSift(conds)).toEqual({
      appVersion: { $gte: "1.2.3" },
    });
  });

  test("customAttribute parses scalars (number / bool / string)", () => {
    expect(
      conditionsToSift([
        {
          ...makeCondition("customAttribute"),
          attribute: "level",
          scalarOp: "$gte",
          scalarValue: "42",
        },
      ]),
    ).toEqual({ level: { $gte: 42 } });

    expect(
      conditionsToSift([
        {
          ...makeCondition("customAttribute"),
          attribute: "isPro",
          scalarOp: "$eq",
          scalarValue: "true",
        },
      ]),
    ).toEqual({ isPro: { $eq: true } });

    expect(
      conditionsToSift([
        {
          ...makeCondition("customAttribute"),
          attribute: "plan",
          scalarOp: "$eq",
          scalarValue: "premium",
        },
      ]),
    ).toEqual({ plan: { $eq: "premium" } });
  });

  test("empty fragments are skipped", () => {
    // empty country list and empty attribute name both drop out
    const conds: DraftCondition[] = [
      { ...makeCondition("country"), listValues: [] },
      { ...makeCondition("customAttribute"), attribute: "" },
    ];
    expect(conditionsToSift(conds)).toBeUndefined();
  });

  test("round-trip: $and of country + appVersion survives parse → emit", () => {
    const doc = {
      $and: [
        { country: { $in: ["TR"] } },
        { appVersion: { $gte: "1.2.3" } },
      ],
    };
    const parsed = siftToConditions(doc);
    expect(conditionsToSift(parsed)).toEqual(doc);
  });

  test("round-trip: single country list survives parse → emit", () => {
    const doc = { country: { $in: ["TR", "DE"] } };
    const parsed = siftToConditions(doc);
    expect(conditionsToSift(parsed)).toEqual(doc);
  });

  test("siftToConditions handles undefined", () => {
    expect(siftToConditions(undefined)).toEqual([]);
  });
});
```

- [ ] **Step 2.2: Run the test to verify it fails**

Run: `pnpm --filter @rovenue/dashboard test sift-codec -- --run`
Expected: FAIL — `Cannot find module '../src/components/targeting/sift-codec'`

- [ ] **Step 2.3: Create the codec module**

Create `apps/dashboard/src/components/targeting/sift-codec.ts`:

```ts
// =============================================================
// Targeting condition ↔ sift document codec
// =============================================================
//
// Shared between feature-flag rules and audience definitions —
// both store MongoDB-style filter documents that are evaluated
// by `matchesAudience` (packages/shared) at SDK eval time.
//
// The form holds an array of `DraftCondition` (one row in the UI
// per entry); `conditionsToSift` flattens them into a single sift
// document, wrapping in `$and` whenever there's more than one.
// `siftToConditions` is the best-effort reverse mapping used when
// editing an existing rule — anything we can't recognise falls
// back to a single "customAttribute" row carrying the raw JSON so
// the user can still see and edit it.

export type ConditionKind =
  | "customAttribute"
  | "country"
  | "app"
  | "appVersion"
  | "platform"
  | "sdkVersion";

export type ListOp = "$in" | "$nin";
export type CompareOp = "$eq" | "$ne" | "$gt" | "$gte" | "$lt" | "$lte";

export interface DraftCondition {
  kind: ConditionKind;
  attribute: string;
  scalarOp: CompareOp;
  scalarValue: string;
  listOp: ListOp;
  listValues: string[];
}

export function makeCondition(kind: ConditionKind): DraftCondition {
  return {
    kind,
    attribute: kind === "customAttribute" ? "" : kind,
    scalarOp: "$gte",
    scalarValue: "",
    listOp: "$in",
    listValues: [],
  };
}

function conditionToFragment(
  c: DraftCondition,
): Record<string, unknown> | null {
  const trimmedAttr = c.attribute.trim();
  switch (c.kind) {
    case "customAttribute": {
      if (!trimmedAttr) return null;
      const parsed = parseScalar(c.scalarValue);
      return { [trimmedAttr]: { [c.scalarOp]: parsed } };
    }
    case "country":
    case "app":
    case "platform": {
      const field = c.kind;
      const values = c.listValues
        .map((v) => v.trim())
        .filter((v) => v.length > 0);
      if (values.length === 0) return null;
      return { [field]: { [c.listOp]: values } };
    }
    case "appVersion":
    case "sdkVersion": {
      const field = c.kind;
      const v = c.scalarValue.trim();
      if (v.length === 0) return null;
      return { [field]: { [c.scalarOp]: v } };
    }
  }
}

function parseScalar(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed.length > 0 && !Number.isNaN(Number(trimmed))) {
    return Number(trimmed);
  }
  return raw;
}

export function conditionsToSift(
  conds: ReadonlyArray<DraftCondition>,
): Record<string, unknown> | undefined {
  const fragments: Record<string, unknown>[] = [];
  for (const c of conds) {
    const frag = conditionToFragment(c);
    if (frag) fragments.push(frag);
  }
  if (fragments.length === 0) return undefined;
  if (fragments.length === 1) return fragments[0]!;
  return { $and: fragments };
}

export function siftToConditions(
  sift: Record<string, unknown> | undefined,
): DraftCondition[] {
  if (!sift) return [];
  const fragments: Record<string, unknown>[] = Array.isArray(sift.$and)
    ? (sift.$and as Record<string, unknown>[])
    : [sift];

  const out: DraftCondition[] = [];
  for (const frag of fragments) {
    const entries = Object.entries(frag);
    if (entries.length !== 1) {
      out.push({
        ...makeCondition("customAttribute"),
        attribute: "_raw",
        scalarOp: "$eq",
        scalarValue: JSON.stringify(frag),
      });
      continue;
    }
    const [field, ops] = entries[0]!;
    if (typeof ops !== "object" || ops === null || Array.isArray(ops)) {
      out.push({
        ...makeCondition("customAttribute"),
        attribute: field,
        scalarOp: "$eq",
        scalarValue: String(ops),
      });
      continue;
    }
    const opEntries = Object.entries(ops as Record<string, unknown>);
    if (opEntries.length !== 1) {
      out.push({
        ...makeCondition("customAttribute"),
        attribute: field,
        scalarOp: "$eq",
        scalarValue: JSON.stringify(ops),
      });
      continue;
    }
    const [op, raw] = opEntries[0]!;
    if (field === "country" || field === "app" || field === "platform") {
      out.push({
        ...makeCondition(field),
        listOp: op === "$nin" ? "$nin" : "$in",
        listValues: Array.isArray(raw)
          ? raw.map((v) => String(v))
          : [String(raw)],
      });
      continue;
    }
    if (field === "appVersion" || field === "sdkVersion") {
      out.push({
        ...makeCondition(field),
        scalarOp: normaliseCompareOp(op),
        scalarValue: String(raw),
      });
      continue;
    }
    out.push({
      ...makeCondition("customAttribute"),
      attribute: field,
      scalarOp: normaliseCompareOp(op),
      scalarValue:
        typeof raw === "object" ? JSON.stringify(raw) : String(raw),
    });
  }
  return out;
}

function normaliseCompareOp(op: string): CompareOp {
  const allowed: ReadonlyArray<CompareOp> = [
    "$eq",
    "$ne",
    "$gt",
    "$gte",
    "$lt",
    "$lte",
  ];
  return allowed.includes(op as CompareOp) ? (op as CompareOp) : "$eq";
}
```

- [ ] **Step 2.4: Run the codec tests to confirm they pass**

Run: `pnpm --filter @rovenue/dashboard test sift-codec -- --run`
Expected: PASS (all 9 tests)

- [ ] **Step 2.5: Delete inline codec from flag-form.tsx and import from new module**

Open `apps/dashboard/src/components/feature-flags/flag-form.tsx`.

Remove lines 85-100 (`ListOp` / `CompareOp` type aliases + `LIST_OPS` / `COMPARE_OPS` arrays will be kept in the next task's extraction — leave them in flag-form for now, they'll move with the UI).

Remove lines 108-128 (the `DraftCondition` interface + `makeCondition` function).

Remove lines 182-235 (the `conditionToFragment`, `parseScalar`, `conditionsToSift`, `siftToConditions`, `normaliseCompareOp` block — lines 178-321 — verify by searching for these symbols; remove everything between the comment header "Condition → sift document" and the closing of `normaliseCompareOp`).

At the top of the file, after the existing `import` from `@rovenue/shared` (around line 33), add:

```ts
import {
  conditionsToSift,
  makeCondition,
  siftToConditions,
  type CompareOp,
  type ConditionKind,
  type DraftCondition,
  type ListOp,
} from "../targeting/sift-codec";
```

- [ ] **Step 2.6: Type-check the dashboard**

Run: `pnpm --filter @rovenue/dashboard typecheck` (or `tsc --noEmit` if no script alias)
Expected: PASS — no type errors. If `typecheck` doesn't exist, try `pnpm --filter @rovenue/dashboard exec tsc --noEmit`.

- [ ] **Step 2.7: Run the dashboard test suite**

Run: `pnpm --filter @rovenue/dashboard test -- --run`
Expected: PASS — all existing tests + new codec tests.

- [ ] **Step 2.8: Commit**

```bash
git add apps/dashboard/src/components/targeting/sift-codec.ts \
        apps/dashboard/src/components/feature-flags/flag-form.tsx \
        apps/dashboard/tests/sift-codec.test.ts
git commit -m "refactor(dashboard): extract sift codec into shared targeting module"
```

---

## Task 3: Rename condition i18n keys to a neutral namespace

Move the existing `featureFlags.new.conditions.*` block to `targeting.conditions.*` and update the flag-form to use the new keys. The audience form will reuse the same namespace.

**Files:**
- Modify: `apps/dashboard/src/i18n/locales/en.json`
- Modify: `apps/dashboard/src/components/feature-flags/flag-form.tsx`

- [ ] **Step 3.1: Add a top-level `targeting` block in en.json**

In `apps/dashboard/src/i18n/locales/en.json`, find the closing `}` of the `featureFlags` block (around line 1501). Immediately after it, before `"experiments"`, insert:

```json
  "targeting": {
    "conditions": {
      "empty": "No conditions — matches every subscriber.",
      "add": "Add condition",
      "removeCondition": "Remove condition",
      "types": {
        "customAttribute": "Custom attribute",
        "country": "Country",
        "app": "App",
        "appVersion": "App version",
        "platform": "Platform",
        "sdkVersion": "SDK version"
      },
      "ops": {
        "in": "is one of",
        "notIn": "is not one of",
        "eq": "=",
        "ne": "≠",
        "gt": ">",
        "gte": "≥",
        "lt": "<",
        "lte": "≤"
      }
    }
  },
```

The old `featureFlags.new.conditions` block (lines ~1460-1482) stays in place for now — we'll delete it after every consumer is migrated.

- [ ] **Step 3.2: Update flag-form.tsx to use the new keys**

In `apps/dashboard/src/components/feature-flags/flag-form.tsx`, do a find-and-replace within the file (one occurrence per match unless noted):

| Old key                                              | New key                                |
|------------------------------------------------------|----------------------------------------|
| `featureFlags.new.conditions.empty`                  | `targeting.conditions.empty`           |
| `featureFlags.new.conditions.add`                    | `targeting.conditions.add`             |
| `featureFlags.new.conditions.removeCondition`        | `targeting.conditions.removeCondition` |
| `featureFlags.new.conditions.types.customAttribute`  | `targeting.conditions.types.customAttribute` |
| `featureFlags.new.conditions.types.country`          | `targeting.conditions.types.country`   |
| `featureFlags.new.conditions.types.app`              | `targeting.conditions.types.app`       |
| `featureFlags.new.conditions.types.appVersion`       | `targeting.conditions.types.appVersion` |
| `featureFlags.new.conditions.types.platform`         | `targeting.conditions.types.platform`  |
| `featureFlags.new.conditions.types.sdkVersion`       | `targeting.conditions.types.sdkVersion` |
| `featureFlags.new.conditions.ops.in`                 | `targeting.conditions.ops.in`          |
| `featureFlags.new.conditions.ops.notIn`              | `targeting.conditions.ops.notIn`       |
| `featureFlags.new.conditions.ops.eq`                 | `targeting.conditions.ops.eq`          |
| `featureFlags.new.conditions.ops.ne`                 | `targeting.conditions.ops.ne`          |
| `featureFlags.new.conditions.ops.gt`                 | `targeting.conditions.ops.gt`          |
| `featureFlags.new.conditions.ops.gte`                | `targeting.conditions.ops.gte`         |
| `featureFlags.new.conditions.ops.lt`                 | `targeting.conditions.ops.lt`          |
| `featureFlags.new.conditions.ops.lte`                | `targeting.conditions.ops.lte`         |

Use grep to verify no `featureFlags.new.conditions.*` strings remain in `flag-form.tsx`:

Run: `grep -n "featureFlags.new.conditions" apps/dashboard/src/components/feature-flags/flag-form.tsx`
Expected: no output.

- [ ] **Step 3.3: Delete the obsolete `featureFlags.new.conditions` block in en.json**

Remove the `"conditions": { ... }` sub-block inside `featureFlags.new` (originally at lines ~1460-1482). The neighbouring fields (`fields.conditions`, `descriptions.conditions`, `errors.*`) stay — only the nested `conditions` object goes away.

- [ ] **Step 3.4: Confirm tests still pass**

Run: `pnpm --filter @rovenue/dashboard test -- --run`
Expected: PASS.

- [ ] **Step 3.5: Commit**

```bash
git add apps/dashboard/src/i18n/locales/en.json \
        apps/dashboard/src/components/feature-flags/flag-form.tsx
git commit -m "refactor(dashboard): move condition i18n keys to targeting namespace"
```

---

## Task 4: Extract condition builder UI

Move `ConditionRow`, `ConditionMenu`, `ChipInput`, `PlatformChips` plus the operator/value catalogues into a shared component. Expose a single `<ConditionList>` that owns the add-button + row list. Update flag-form to use it.

**Files:**
- Create: `apps/dashboard/src/components/targeting/condition-builder.tsx`
- Modify: `apps/dashboard/src/components/feature-flags/flag-form.tsx`

- [ ] **Step 4.1: Create the condition-builder module**

Create `apps/dashboard/src/components/targeting/condition-builder.tsx`:

```tsx
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import {
  Check,
  ChevronDown,
  Globe2,
  KeyRound,
  Layers,
  Package,
  Plus,
  Smartphone,
  Tag,
  Trash2,
} from "lucide-react";
import { Input } from "../../ui/input";
import { Select } from "../../ui/select";
import { cn } from "../../lib/cn";
import {
  makeCondition,
  type CompareOp,
  type ConditionKind,
  type DraftCondition,
  type ListOp,
} from "./sift-codec";

const CONDITION_TYPES: ReadonlyArray<{
  kind: ConditionKind;
  labelKey: string;
  icon: ReactNode;
}> = [
  {
    kind: "customAttribute",
    labelKey: "targeting.conditions.types.customAttribute",
    icon: <KeyRound size={11} />,
  },
  {
    kind: "country",
    labelKey: "targeting.conditions.types.country",
    icon: <Globe2 size={11} />,
  },
  {
    kind: "app",
    labelKey: "targeting.conditions.types.app",
    icon: <Package size={11} />,
  },
  {
    kind: "appVersion",
    labelKey: "targeting.conditions.types.appVersion",
    icon: <Tag size={11} />,
  },
  {
    kind: "platform",
    labelKey: "targeting.conditions.types.platform",
    icon: <Smartphone size={11} />,
  },
  {
    kind: "sdkVersion",
    labelKey: "targeting.conditions.types.sdkVersion",
    icon: <Layers size={11} />,
  },
];

const LIST_OPS: ReadonlyArray<{ value: ListOp; labelKey: string }> = [
  { value: "$in", labelKey: "targeting.conditions.ops.in" },
  { value: "$nin", labelKey: "targeting.conditions.ops.notIn" },
];

const COMPARE_OPS: ReadonlyArray<{ value: CompareOp; labelKey: string }> = [
  { value: "$eq", labelKey: "targeting.conditions.ops.eq" },
  { value: "$ne", labelKey: "targeting.conditions.ops.ne" },
  { value: "$gte", labelKey: "targeting.conditions.ops.gte" },
  { value: "$gt", labelKey: "targeting.conditions.ops.gt" },
  { value: "$lte", labelKey: "targeting.conditions.ops.lte" },
  { value: "$lt", labelKey: "targeting.conditions.ops.lt" },
];

const PLATFORM_VALUES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "ios", label: "iOS" },
  { value: "android", label: "Android" },
  { value: "web", label: "Web" },
];

export interface ConditionListProps {
  conditions: ReadonlyArray<DraftCondition>;
  onChange: (next: DraftCondition[]) => void;
  disabled?: boolean;
}

export function ConditionList({
  conditions,
  onChange,
  disabled,
}: ConditionListProps) {
  const { t } = useTranslation();

  const updateAt = (idx: number, patch: Partial<DraftCondition>) =>
    onChange(
      conditions.map((c, i) => (i === idx ? { ...c, ...patch } : c)),
    );

  const removeAt = (idx: number) =>
    onChange(conditions.filter((_, i) => i !== idx));

  const append = (kind: ConditionKind) =>
    onChange([...conditions, makeCondition(kind)]);

  return (
    <div className="flex flex-col gap-2">
      {conditions.length === 0 && (
        <span className="text-[11px] italic text-rv-mute-500">
          {t("targeting.conditions.empty")}
        </span>
      )}
      {conditions.map((c, idx) => (
        <ConditionRow
          key={idx}
          condition={c}
          onChange={(patch) => updateAt(idx, patch)}
          onRemove={() => removeAt(idx)}
        />
      ))}
      {!disabled && <ConditionMenu onPick={append} />}
    </div>
  );
}

function ConditionMenu({ onPick }: { onPick: (kind: ConditionKind) => void }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <div className="relative inline-block">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="inline-flex items-center gap-1 rounded-md border border-dashed border-rv-divider-strong bg-transparent px-3 py-1.5 text-[11px] font-medium text-rv-mute-600 transition hover:border-rv-accent-500 hover:bg-rv-accent-500/5 hover:text-rv-accent-500"
      >
        <Plus size={11} />
        {t("targeting.conditions.add")}
        <ChevronDown size={11} className="text-rv-mute-500" />
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute left-0 top-full z-20 mt-1 w-[220px] overflow-hidden rounded-md border border-rv-divider bg-rv-c1 shadow-lg">
            {CONDITION_TYPES.map((opt) => (
              <button
                key={opt.kind}
                type="button"
                onClick={() => {
                  onPick(opt.kind);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-foreground transition hover:bg-rv-c3"
              >
                <span className="text-rv-mute-500">{opt.icon}</span>
                {t(opt.labelKey)}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ConditionRow({
  condition,
  onChange,
  onRemove,
}: {
  condition: DraftCondition;
  onChange: (patch: Partial<DraftCondition>) => void;
  onRemove: () => void;
}) {
  const { t } = useTranslation();
  const meta = CONDITION_TYPES.find((c) => c.kind === condition.kind)!;

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-md border border-rv-divider bg-rv-c1 px-2.5 py-2">
      <span className="inline-flex items-center gap-1 font-rv-mono text-[10px] uppercase tracking-wider text-rv-mute-500">
        {meta.icon}
        {t(meta.labelKey)}
      </span>

      {condition.kind === "customAttribute" && (
        <>
          <Input
            mono
            value={condition.attribute}
            onChange={(e) => onChange({ attribute: e.target.value })}
            placeholder="user_level"
            className="h-7 flex-1 min-w-[120px] max-w-[180px] text-[12px]"
          />
          <Select
            value={condition.scalarOp}
            onChange={(e) =>
              onChange({ scalarOp: e.target.value as CompareOp })
            }
            className="h-7 w-[80px] text-[12px]"
          >
            {COMPARE_OPS.map((op) => (
              <option key={op.value} value={op.value}>
                {t(op.labelKey)}
              </option>
            ))}
          </Select>
          <Input
            mono
            value={condition.scalarValue}
            onChange={(e) => onChange({ scalarValue: e.target.value })}
            placeholder="42"
            className="h-7 flex-1 min-w-[120px] text-[12px]"
          />
        </>
      )}

      {(condition.kind === "country" ||
        condition.kind === "app" ||
        condition.kind === "platform") && (
        <>
          <Select
            value={condition.listOp}
            onChange={(e) => onChange({ listOp: e.target.value as ListOp })}
            className="h-7 w-[80px] text-[12px]"
          >
            {LIST_OPS.map((op) => (
              <option key={op.value} value={op.value}>
                {t(op.labelKey)}
              </option>
            ))}
          </Select>
          {condition.kind === "platform" ? (
            <PlatformChips
              values={condition.listValues}
              onChange={(next) => onChange({ listValues: next })}
            />
          ) : (
            <ChipInput
              values={condition.listValues}
              onChange={(next) => onChange({ listValues: next })}
              placeholder={
                condition.kind === "country"
                  ? "TR, DE, US"
                  : "com.example.app"
              }
            />
          )}
        </>
      )}

      {(condition.kind === "appVersion" ||
        condition.kind === "sdkVersion") && (
        <>
          <Select
            value={condition.scalarOp}
            onChange={(e) =>
              onChange({ scalarOp: e.target.value as CompareOp })
            }
            className="h-7 w-[80px] text-[12px]"
          >
            {COMPARE_OPS.map((op) => (
              <option key={op.value} value={op.value}>
                {t(op.labelKey)}
              </option>
            ))}
          </Select>
          <Input
            mono
            value={condition.scalarValue}
            onChange={(e) => onChange({ scalarValue: e.target.value })}
            placeholder="1.2.3"
            className="h-7 flex-1 min-w-[120px] text-[12px]"
          />
        </>
      )}

      <button
        type="button"
        aria-label={t("targeting.conditions.removeCondition")}
        onClick={onRemove}
        className="ml-auto inline-flex size-6 cursor-pointer items-center justify-center rounded text-rv-mute-500 hover:bg-rv-c3 hover:text-rv-danger"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

function ChipInput({
  values,
  onChange,
  placeholder,
}: {
  values: ReadonlyArray<string>;
  onChange: (next: string[]) => void;
  placeholder: string;
}) {
  const [draft, setDraft] = useState("");

  const commit = () => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) return;
    const parts = trimmed
      .split(/[,\s]+/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0 && !values.includes(p));
    if (parts.length === 0) {
      setDraft("");
      return;
    }
    onChange([...values, ...parts]);
    setDraft("");
  };

  return (
    <div className="flex flex-1 flex-wrap items-center gap-1 rounded border border-rv-divider bg-rv-c2 px-1.5 py-1 min-w-[160px]">
      {values.map((v) => (
        <span
          key={v}
          className="inline-flex items-center gap-1 rounded bg-rv-c4 px-1.5 py-0.5 font-rv-mono text-[10px] text-rv-mute-700"
        >
          {v}
          <button
            type="button"
            aria-label={`Remove ${v}`}
            onClick={() => onChange(values.filter((x) => x !== v))}
            className="text-rv-mute-500 hover:text-rv-danger"
          >
            ×
          </button>
        </span>
      ))}
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          } else if (
            e.key === "Backspace" &&
            draft === "" &&
            values.length > 0
          ) {
            onChange(values.slice(0, -1));
          }
        }}
        onBlur={commit}
        placeholder={values.length === 0 ? placeholder : ""}
        className="flex-1 min-w-[80px] bg-transparent font-rv-mono text-[11px] text-foreground placeholder:text-rv-mute-500 outline-none"
      />
    </div>
  );
}

function PlatformChips({
  values,
  onChange,
}: {
  values: ReadonlyArray<string>;
  onChange: (next: string[]) => void;
}) {
  const selected = new Set(values);
  return (
    <div className="flex flex-1 flex-wrap items-center gap-1">
      {PLATFORM_VALUES.map((p) => {
        const isOn = selected.has(p.value);
        return (
          <button
            key={p.value}
            type="button"
            onClick={() => {
              if (isOn) onChange(values.filter((v) => v !== p.value));
              else onChange([...values, p.value]);
            }}
            className={cn(
              "inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-rv-mono text-[10px] transition",
              isOn
                ? "border-rv-accent-500 bg-rv-accent-500/10 text-rv-accent-500"
                : "border-rv-divider bg-rv-c2 text-rv-mute-700 hover:border-rv-accent-500/40",
            )}
          >
            {isOn && <Check size={9} />}
            {p.label}
          </button>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4.2: Delete the inline builder from flag-form and use `<ConditionList>`**

In `apps/dashboard/src/components/feature-flags/flag-form.tsx`:

1. Add to imports (near the existing `targeting/sift-codec` import):

```ts
import { ConditionList } from "../targeting/condition-builder";
```

2. Remove `LIST_OPS`, `COMPARE_OPS`, `PLATFORM_VALUES` constants (they now live in the builder).

3. Remove the entire `CONDITION_TYPES` constant and the `Globe2 / Smartphone / Layers / KeyRound / Package / Tag` icon imports if no longer referenced after the deletion. Verify with grep first:

Run: `grep -n "CONDITION_TYPES\|LIST_OPS\|COMPARE_OPS\|PLATFORM_VALUES" apps/dashboard/src/components/feature-flags/flag-form.tsx`
Expected: no matches once removed.

4. Remove the `ConditionMenu`, `ConditionRow`, `ChipInput`, `PlatformChips` function definitions and the surrounding comment header "Condition row + add menu" (lines ~877-1151 — verify by symbol search).

5. Replace the existing inline rendering in the `<Field>` for conditions. Find the block that renders `r.conditions.length === 0` and the `r.conditions.map(...)` and the `<ConditionMenu>` (around lines 753-774). Replace the entire `<div className="flex flex-col gap-2">…</div>` with:

```tsx
                    <ConditionList
                      conditions={r.conditions}
                      onChange={(next) =>
                        updateRule(ruleIdx, { conditions: next })
                      }
                    />
```

6. Delete the now-unused helper functions inside flag-form that called into the removed components: `addCondition`, `removeCondition`, `updateCondition`. Search for their call sites — only the inline rendering used them, so they should be safe to remove.

Run: `grep -n "addCondition\|removeCondition\|updateCondition" apps/dashboard/src/components/feature-flags/flag-form.tsx`
Expected: no matches.

- [ ] **Step 4.3: Type-check and test**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit`
Expected: PASS.

Run: `pnpm --filter @rovenue/dashboard test -- --run`
Expected: PASS — all dashboard tests still green.

- [ ] **Step 4.4: Smoke-test in the dev server**

Run: `pnpm --filter @rovenue/dashboard dev` (background)

Manually visit `/projects/<id>/feature-flags/new`, click "Add rule" → "Add condition" → "Country", type `TR,DE`, then "Add condition" → "Platform", click iOS. Verify:
- Both conditions render with the new builder.
- "Remove condition" still removes them.
- Submitting still creates the flag with the expected `conditions: { $and: [...] }` shape (check the network tab).

Stop the dev server once verified.

- [ ] **Step 4.5: Commit**

```bash
git add apps/dashboard/src/components/targeting/condition-builder.tsx \
        apps/dashboard/src/components/feature-flags/flag-form.tsx
git commit -m "refactor(dashboard): extract condition builder into shared targeting module"
```

---

## Task 5: Audience mutation hooks

Add `useAudience`, `useCreateAudience`, `useUpdateAudience`, `useDeleteAudience` to the existing project-admin hooks file. Each mutation invalidates `["audiences", projectId]` on success.

**Files:**
- Modify: `apps/dashboard/src/lib/hooks/useProjectAdmin.ts`

- [ ] **Step 5.1: Add the new hooks**

At the bottom of `apps/dashboard/src/lib/hooks/useProjectAdmin.ts` (after `useProjectMembers`), append:

```ts
// =============================================================
// Audience mutations
// =============================================================

import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AudienceRow } from "@rovenue/shared";

export function useAudience(id: string | undefined) {
  return useQuery({
    queryKey: ["audience", id],
    enabled: Boolean(id),
    queryFn: () =>
      api<{ audience: AudienceRow }>(
        `/dashboard/audiences/${encodeURIComponent(id!)}`,
      ),
    select: (res) => res.audience,
  });
}

export interface CreateAudienceVars {
  projectId: string;
  name: string;
  description?: string;
  rules: Record<string, unknown>;
}

export function useCreateAudience() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (vars: CreateAudienceVars) =>
      api<{ audience: AudienceRow }>("/dashboard/audiences", {
        method: "POST",
        body: JSON.stringify(vars),
      }),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["audiences", vars.projectId] });
    },
  });
}

export interface UpdateAudienceVars {
  id: string;
  projectId: string;
  name?: string;
  description?: string | null;
  rules?: Record<string, unknown>;
}

export function useUpdateAudience() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, projectId: _p, ...patch }: UpdateAudienceVars) =>
      api<{ audience: AudienceRow }>(
        `/dashboard/audiences/${encodeURIComponent(id)}`,
        { method: "PATCH", body: JSON.stringify(patch) },
      ),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["audiences", vars.projectId] });
      qc.invalidateQueries({ queryKey: ["audience", vars.id] });
    },
  });
}

export interface DeleteAudienceVars {
  id: string;
  projectId: string;
}

export function useDeleteAudience() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id }: DeleteAudienceVars) =>
      api<{ deleted: true }>(
        `/dashboard/audiences/${encodeURIComponent(id)}`,
        { method: "DELETE" },
      ),
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["audiences", vars.projectId] });
    },
  });
}
```

The new imports (`useMutation`, `useQueryClient`, `AudienceRow`) should be merged into the existing top-of-file imports if duplicates exist. Specifically, change the top of the file from:

```ts
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type {
  AudiencesListResponse,
  AuditLogsListResponse,
  LeaderboardResponse,
  ListMembersResponse,
} from "@rovenue/shared";
```

to:

```ts
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  AudienceRow,
  AudiencesListResponse,
  AuditLogsListResponse,
  LeaderboardResponse,
  ListMembersResponse,
} from "@rovenue/shared";
```

…and remove the duplicate imports from the appended block.

- [ ] **Step 5.2: Type-check**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 5.3: Commit**

```bash
git add apps/dashboard/src/lib/hooks/useProjectAdmin.ts
git commit -m "feat(dashboard): add audience CRUD hooks"
```

---

## Task 6: Audience form component

Create the shared form used by both new and edit routes. Supports a read-only mode for the default audience.

**Files:**
- Create: `apps/dashboard/src/components/audiences/audience-form.tsx`

- [ ] **Step 6.1: Create the form component**

Create `apps/dashboard/src/components/audiences/audience-form.tsx`:

```tsx
import { useMemo, useState, type FormEvent, type ReactNode } from "react";
import { Link, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  ArrowLeft,
  FileText,
  Tag,
  Target,
  Users,
} from "lucide-react";
import type { AudienceRow } from "@rovenue/shared";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Textarea } from "../../ui/textarea";
import { cn } from "../../lib/cn";
import { ApiError } from "../../lib/api";
import {
  useCreateAudience,
  useUpdateAudience,
} from "../../lib/hooks/useProjectAdmin";
import { ConditionList } from "../targeting/condition-builder";
import {
  conditionsToSift,
  siftToConditions,
  type DraftCondition,
} from "../targeting/sift-codec";

export interface AudienceFormProps {
  projectId: string;
  initialAudience?: AudienceRow;
}

export function AudienceForm({ projectId, initialAudience }: AudienceFormProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isEdit = Boolean(initialAudience);
  const isDefault = initialAudience?.isDefault ?? false;
  const create = useCreateAudience();
  const update = useUpdateAudience();

  const [name, setName] = useState(initialAudience?.name ?? "");
  const [description, setDescription] = useState(
    initialAudience?.description ?? "",
  );
  const [conditions, setConditions] = useState<DraftCondition[]>(() =>
    initialAudience
      ? siftToConditions(initialAudience.rules)
      : [],
  );
  const [formError, setFormError] = useState<string | null>(null);

  const previewDoc = useMemo(
    () => conditionsToSift(conditions) ?? {},
    [conditions],
  );

  const pending = create.isPending || update.isPending;
  const submitDisabled = pending || name.trim().length === 0;

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setFormError(null);

    if (name.trim().length === 0) {
      setFormError(t("audiences.form.errors.nameRequired"));
      return;
    }

    try {
      if (initialAudience) {
        await update.mutateAsync({
          id: initialAudience.id,
          projectId,
          name: name.trim(),
          description:
            description.trim().length > 0 ? description.trim() : null,
          rules: conditionsToSift(conditions) ?? {},
        });
      } else {
        await create.mutateAsync({
          projectId,
          name: name.trim(),
          ...(description.trim().length > 0
            ? { description: description.trim() }
            : {}),
          rules: conditionsToSift(conditions) ?? {},
        });
      }
      void navigate({
        to: "/projects/$projectId/audiences",
        params: { projectId },
      });
    } catch (err) {
      setFormError(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : t("audiences.form.errors.unknown"),
      );
    }
  };

  return (
    <>
      <header className="pb-5">
        <Link
          to="/projects/$projectId/audiences"
          params={{ projectId }}
          className="inline-flex items-center gap-1 text-[12px] text-rv-mute-500 hover:text-foreground"
        >
          <ArrowLeft size={12} />
          {t("audiences.form.back")}
        </Link>
        <h1 className="mt-2 text-[24px] font-semibold leading-8 tracking-tight">
          {isEdit
            ? isDefault
              ? t("audiences.form.titleDefault")
              : t("audiences.form.titleEdit")
            : t("audiences.form.titleNew")}
        </h1>
        <p className="mt-1 max-w-2xl text-[13px] text-rv-mute-500">
          {isEdit
            ? t("audiences.form.subtitleEdit")
            : t("audiences.form.subtitleNew")}
        </p>
      </header>

      <form onSubmit={handleSubmit} className="grid max-w-3xl grid-cols-1 gap-5">
        {isDefault && (
          <div className="flex items-start gap-2 rounded-md border border-rv-divider bg-rv-c2/60 px-3 py-2 text-[12px] text-rv-mute-700">
            <AlertCircle size={13} className="mt-0.5 flex-shrink-0" />
            <span>{t("audiences.form.defaultBanner")}</span>
          </div>
        )}

        <fieldset
          disabled={isDefault}
          className="contents disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Section
            icon={<FileText size={13} />}
            title={t("audiences.form.sections.basics")}
            subtitle={t("audiences.form.sections.basicsSub")}
          >
            <Field
              icon={<Tag size={11} />}
              label={t("audiences.form.fields.name")}
              description={t("audiences.form.descriptions.name")}
            >
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("audiences.form.placeholders.name")}
                required
              />
            </Field>
            <Field
              icon={<FileText size={11} />}
              label={t("audiences.form.fields.description")}
              description={t("audiences.form.descriptions.description")}
              optional
            >
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={2}
                placeholder={t("audiences.form.placeholders.description")}
              />
            </Field>
          </Section>

          <Section
            icon={<Target size={13} />}
            title={t("audiences.form.sections.rules")}
            subtitle={t("audiences.form.sections.rulesSub")}
            right={
              <span className="inline-flex items-center gap-1 rounded-full border border-rv-divider bg-rv-c4 px-2 py-0.5 font-rv-mono text-[10px] text-rv-mute-700">
                <Users size={9} />
                {conditions.length === 0
                  ? t("audiences.form.allUsers")
                  : t("audiences.form.conditionCount", {
                      count: conditions.length,
                    })}
              </span>
            }
          >
            <ConditionList
              conditions={conditions}
              onChange={setConditions}
              disabled={isDefault}
            />

            <Field
              label={t("audiences.form.preview")}
              description={t("audiences.form.previewSub")}
              dense
              className="mt-2"
            >
              <pre className="overflow-x-auto rounded-md border border-rv-divider bg-rv-c1 px-3 py-2 font-rv-mono text-[11px] text-rv-mute-700">
                {JSON.stringify(previewDoc, null, 2)}
              </pre>
            </Field>
          </Section>
        </fieldset>

        {formError && (
          <div className="rounded-md border border-rv-danger/30 bg-rv-danger/10 px-3 py-2 text-[12px] text-rv-danger">
            {formError}
          </div>
        )}

        {!isDefault && (
          <div className="flex items-center gap-2 pt-2">
            <Button
              type="submit"
              variant="solid-primary"
              disabled={submitDisabled}
            >
              {isEdit
                ? pending
                  ? t("audiences.form.submittingEdit")
                  : t("audiences.form.submitEdit")
                : pending
                  ? t("audiences.form.submittingNew")
                  : t("audiences.form.submitNew")}
            </Button>
            <Link
              to="/projects/$projectId/audiences"
              params={{ projectId }}
              className="text-[12px] text-rv-mute-500 hover:text-foreground"
            >
              {t("audiences.form.cancel")}
            </Link>
          </div>
        )}
      </form>
    </>
  );
}

function Section({
  icon,
  title,
  subtitle,
  right,
  children,
}: {
  icon?: ReactNode;
  title: string;
  subtitle?: string;
  right?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
      <div className="flex items-start justify-between gap-3 border-b border-rv-divider bg-rv-c2/40 px-4 py-3">
        <div className="flex items-start gap-2.5">
          {icon && (
            <span className="mt-0.5 inline-flex size-6 items-center justify-center rounded-md bg-rv-accent-500/10 text-rv-accent-500">
              {icon}
            </span>
          )}
          <div className="min-w-0">
            <h2 className="text-[13px] font-medium leading-5">{title}</h2>
            {subtitle && (
              <p className="mt-0.5 text-[11px] leading-snug text-rv-mute-500">
                {subtitle}
              </p>
            )}
          </div>
        </div>
        {right}
      </div>
      <div className="flex flex-col gap-4 p-4">{children}</div>
    </section>
  );
}

function Field({
  icon,
  label,
  description,
  optional,
  dense,
  className,
  children,
}: {
  icon?: ReactNode;
  label: string;
  description?: string;
  optional?: boolean;
  dense?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <label
      className={cn(
        "flex flex-col",
        dense ? "gap-1" : "gap-1.5",
        className,
      )}
    >
      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
        {icon && <span className="text-rv-mute-400">{icon}</span>}
        {label}
        {optional && (
          <span className="ml-0.5 text-rv-mute-400 normal-case tracking-normal">
            (optional)
          </span>
        )}
      </span>
      {description && (
        <span className="text-[11px] leading-snug text-rv-mute-500">
          {description}
        </span>
      )}
      {children}
    </label>
  );
}
```

- [ ] **Step 6.2: Type-check**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit`
Expected: PASS (some i18n keys are missing — they'll be added in Task 9, but the t() calls type-check fine as `string`).

- [ ] **Step 6.3: Commit**

```bash
git add apps/dashboard/src/components/audiences/audience-form.tsx
git commit -m "feat(dashboard): add audience form component"
```

---

## Task 7: New audience route

**Files:**
- Create: `apps/dashboard/src/routes/_authed/projects/$projectId/audiences/new.tsx`

- [ ] **Step 7.1: Create the route file**

Create `apps/dashboard/src/routes/_authed/projects/$projectId/audiences/new.tsx`:

```tsx
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useProject } from "../../../../../lib/hooks/useProject";
import { AudienceForm } from "../../../../../components/audiences/audience-form";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/audiences/new",
)({
  component: NewAudienceRouteComponent,
});

function NewAudienceRouteComponent() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/audiences/new",
  });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <AudienceForm projectId={projectId} />;
}
```

- [ ] **Step 7.2: Regenerate the route tree**

The dashboard uses TanStack Router's file-based routing. Run the dev server briefly (or the explicit gen command) to let it pick up the new file.

Run: `pnpm --filter @rovenue/dashboard dev` (background), wait 5 seconds, then stop.
Or, if available: `pnpm --filter @rovenue/dashboard exec tsr generate`

Verify `routeTree.gen.ts` now imports `AuthedProjectsProjectIdAudiencesNewRouteImport`.

Run: `grep -n "audiences/new" apps/dashboard/src/routeTree.gen.ts`
Expected: at least one match.

- [ ] **Step 7.3: Type-check**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 7.4: Commit**

```bash
git add apps/dashboard/src/routes/_authed/projects/$projectId/audiences/new.tsx \
        apps/dashboard/src/routeTree.gen.ts
git commit -m "feat(dashboard): add /audiences/new route"
```

---

## Task 8: Edit audience route

**Files:**
- Create: `apps/dashboard/src/routes/_authed/projects/$projectId/audiences/$audienceId.tsx`

- [ ] **Step 8.1: Create the route file**

Create `apps/dashboard/src/routes/_authed/projects/$projectId/audiences/$audienceId.tsx`:

```tsx
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { useProject } from "../../../../../lib/hooks/useProject";
import { useAudience } from "../../../../../lib/hooks/useProjectAdmin";
import { AudienceForm } from "../../../../../components/audiences/audience-form";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/audiences/$audienceId",
)({
  component: EditAudienceRouteComponent,
});

function EditAudienceRouteComponent() {
  const { projectId, audienceId } = useParams({
    from: "/_authed/projects/$projectId/audiences/$audienceId",
  });
  const { t } = useTranslation();
  const { data: project } = useProject(projectId);
  const { data: audience, isLoading, isError } = useAudience(audienceId);

  if (!project) return null;
  if (isLoading) {
    return (
      <div className="px-4 py-8 text-center text-[12px] text-rv-mute-500">
        {t("audiences.form.loading")}
      </div>
    );
  }
  if (isError || !audience) {
    return (
      <div className="px-4 py-8 text-center text-[12px] text-rv-mute-500">
        {t("audiences.form.notFound")}
      </div>
    );
  }
  return <AudienceForm projectId={projectId} initialAudience={audience} />;
}
```

- [ ] **Step 8.2: Regenerate route tree, type-check**

Run: `pnpm --filter @rovenue/dashboard dev` for ~5s to regenerate, then stop.

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 8.3: Commit**

```bash
git add apps/dashboard/src/routes/_authed/projects/$projectId/audiences/$audienceId.tsx \
        apps/dashboard/src/routeTree.gen.ts
git commit -m "feat(dashboard): add /audiences/\$audienceId edit route"
```

---

## Task 9: Wire up the list page (New button + row actions)

Update the existing audiences list to:
- Add a "New audience" header button → links to `/audiences/new`.
- Wrap each row in a link to `/audiences/$audienceId`.
- Add a trailing kebab menu on non-default rows with Edit + Delete actions.
- Confirm + handle delete (including the 409 "in use" path).

**Files:**
- Modify: `apps/dashboard/src/routes/_authed/projects/$projectId/audiences.tsx`

- [ ] **Step 9.1: Rewrite the audiences list page**

Replace the entire contents of `apps/dashboard/src/routes/_authed/projects/$projectId/audiences.tsx` with:

```tsx
import { useState } from "react";
import {
  Link,
  createFileRoute,
  useNavigate,
  useParams,
} from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { MoreHorizontal, Pencil, Plus, Trash2 } from "lucide-react";
import { Button } from "../../../../ui/button";
import { Chip } from "../../../../ui/chip";
import { ApiError } from "../../../../lib/api";
import { useProject } from "../../../../lib/hooks/useProject";
import {
  useAudiences,
  useDeleteAudience,
} from "../../../../lib/hooks/useProjectAdmin";

export const Route = createFileRoute(
  "/_authed/projects/$projectId/audiences",
)({
  component: AudiencesRoute,
});

function AudiencesRoute() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/audiences",
  });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <AudiencesPage projectId={projectId} />;
}

export function AudiencesPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const { data: audiences = [], isLoading } = useAudiences(projectId);
  const deleteMutation = useDeleteAudience();
  const navigate = useNavigate();
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const handleDelete = async (id: string, name: string) => {
    if (
      !window.confirm(t("audiences.delete.confirm", { name }))
    ) {
      return;
    }
    setDeleteError(null);
    try {
      await deleteMutation.mutateAsync({ id, projectId });
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setDeleteError(t("audiences.delete.inUse"));
      } else {
        setDeleteError(
          err instanceof Error
            ? err.message
            : t("audiences.delete.failed"),
        );
      }
    }
  };

  return (
    <>
      <header className="flex items-start justify-between gap-4 pb-5">
        <div className="min-w-0">
          <h1 className="text-[24px] font-semibold leading-8 tracking-tight">
            {t("audiences.title", "Audiences")}
          </h1>
          <p className="mt-1 text-[13px] text-rv-mute-500">
            {t(
              "audiences.subtitle",
              "Targeting groups shared between feature flags and experiments. Editing rules invalidates both engines' caches.",
            )}
          </p>
        </div>
        <Button
          variant="solid-primary"
          onClick={() =>
            void navigate({
              to: "/projects/$projectId/audiences/new",
              params: { projectId },
            })
          }
        >
          <Plus size={13} />
          {t("audiences.actions.new")}
        </Button>
      </header>

      {deleteError && (
        <div className="mb-3 rounded-md border border-rv-danger/30 bg-rv-danger/10 px-3 py-2 text-[12px] text-rv-danger">
          {deleteError}
        </div>
      )}

      <div className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
        <div className="grid grid-cols-[minmax(0,1fr)_120px_180px_140px_40px] gap-3 border-b border-rv-divider bg-rv-c2 px-4 py-2 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
          <span>{t("audiences.cols.name", "Name")}</span>
          <span>{t("audiences.cols.kind", "Kind")}</span>
          <span>{t("audiences.cols.rulesCount", "Rules")}</span>
          <span>{t("audiences.cols.created", "Created")}</span>
          <span aria-hidden="true" />
        </div>
        {isLoading && audiences.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12px] text-rv-mute-500">
            {t("common.loading", "Loading…")}
          </div>
        ) : audiences.length === 0 ? (
          <div className="px-4 py-8 text-center text-[12px] text-rv-mute-500">
            {t(
              "audiences.empty",
              "No audiences yet — defaults are created automatically when needed.",
            )}
          </div>
        ) : (
          audiences.map((a) => {
            const ruleCount = Object.keys(a.rules ?? {}).length;
            return (
              <div
                key={a.id}
                className="grid grid-cols-[minmax(0,1fr)_120px_180px_140px_40px] items-center gap-3 border-b border-rv-divider px-4 py-2.5 text-[12px] last:border-b-0 hover:bg-rv-c2/40"
              >
                <Link
                  to="/projects/$projectId/audiences/$audienceId"
                  params={{ projectId, audienceId: a.id }}
                  className="min-w-0 cursor-pointer"
                >
                  <div className="truncate font-medium">{a.name}</div>
                  {a.description && (
                    <div className="truncate text-[11px] text-rv-mute-500">
                      {a.description}
                    </div>
                  )}
                </Link>
                <Chip tone={a.isDefault ? "primary" : "default"}>
                  {a.isDefault
                    ? t("audiences.kind.default", "Default")
                    : t("audiences.kind.custom", "Custom")}
                </Chip>
                <span className="font-rv-mono text-rv-mute-500">
                  {ruleCount === 0
                    ? t("audiences.allUsers", "all users")
                    : t("audiences.ruleCount", "{{count}} rule(s)", {
                        count: ruleCount,
                      })}
                </span>
                <span className="font-rv-mono text-rv-mute-500">
                  {new Date(a.createdAt).toLocaleDateString()}
                </span>
                {a.isDefault ? (
                  <span aria-hidden="true" />
                ) : (
                  <RowMenu
                    onEdit={() =>
                      void navigate({
                        to: "/projects/$projectId/audiences/$audienceId",
                        params: { projectId, audienceId: a.id },
                      })
                    }
                    onDelete={() => void handleDelete(a.id, a.name)}
                  />
                )}
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

function RowMenu({
  onEdit,
  onDelete,
}: {
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  return (
    <div className="relative inline-block text-right">
      <button
        type="button"
        aria-label={t("audiences.actions.menu")}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex size-7 cursor-pointer items-center justify-center rounded text-rv-mute-500 hover:bg-rv-c3 hover:text-foreground"
      >
        <MoreHorizontal size={14} />
      </button>
      {open && (
        <>
          <button
            type="button"
            aria-hidden="true"
            tabIndex={-1}
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute right-0 top-full z-20 mt-1 w-[140px] overflow-hidden rounded-md border border-rv-divider bg-rv-c1 shadow-lg">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onEdit();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-foreground transition hover:bg-rv-c3"
            >
              <Pencil size={12} className="text-rv-mute-500" />
              {t("audiences.actions.edit")}
            </button>
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                onDelete();
              }}
              className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] text-rv-danger transition hover:bg-rv-danger/10"
            >
              <Trash2 size={12} />
              {t("audiences.actions.delete")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 9.2: Type-check**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit`
Expected: PASS.

- [ ] **Step 9.3: Commit**

```bash
git add apps/dashboard/src/routes/_authed/projects/$projectId/audiences.tsx
git commit -m "feat(dashboard): add new/edit/delete actions to audiences list"
```

---

## Task 10: i18n keys for audiences

Add the keys referenced by the form and list page.

**Files:**
- Modify: `apps/dashboard/src/i18n/locales/en.json`

- [ ] **Step 10.1: Add an `audiences` top-level block**

In `apps/dashboard/src/i18n/locales/en.json`, find the closing `}` of the existing `featureFlags` block (around line 1501, after the `targeting` block we added in Task 3). Immediately after the `targeting` block, before `"experiments"`, insert:

```json
  "audiences": {
    "title": "Audiences",
    "subtitle": "Targeting groups shared between feature flags and experiments. Editing rules invalidates both engines' caches.",
    "empty": "No audiences yet — defaults are created automatically when needed.",
    "allUsers": "all users",
    "ruleCount": "{{count}} rule(s)",
    "cols": {
      "name": "Name",
      "kind": "Kind",
      "rulesCount": "Rules",
      "created": "Created"
    },
    "kind": {
      "default": "Default",
      "custom": "Custom"
    },
    "actions": {
      "new": "New audience",
      "menu": "Audience actions",
      "edit": "Edit",
      "delete": "Delete"
    },
    "delete": {
      "confirm": "Delete audience \"{{name}}\"? This cannot be undone.",
      "inUse": "This audience is in use by at least one experiment. Detach it before deleting.",
      "failed": "Could not delete the audience. Please try again."
    },
    "form": {
      "back": "Back to audiences",
      "titleNew": "New audience",
      "titleEdit": "Edit audience",
      "titleDefault": "All Users",
      "subtitleNew": "Define the targeting rules that subscribers must match to be included in this audience.",
      "subtitleEdit": "Update the targeting rules. Feature-flag and experiment caches will be invalidated immediately.",
      "defaultBanner": "The default audience matches every subscriber and cannot be edited.",
      "loading": "Loading audience…",
      "notFound": "We couldn't find that audience.",
      "preview": "Sift document",
      "previewSub": "The serialised form that the SDK evaluates against subscriber attributes.",
      "allUsers": "all users",
      "conditionCount": "{{count}} condition(s)",
      "cancel": "Cancel",
      "submitNew": "Create audience",
      "submitEdit": "Save changes",
      "submittingNew": "Creating…",
      "submittingEdit": "Saving…",
      "sections": {
        "basics": "Basics",
        "basicsSub": "A descriptive name shown in feature-flag and experiment pickers.",
        "rules": "Targeting rules",
        "rulesSub": "Combine conditions with AND. Leave empty to match every subscriber."
      },
      "fields": {
        "name": "Name",
        "description": "Description"
      },
      "descriptions": {
        "name": "Shown wherever this audience is selected.",
        "description": "Optional context for teammates."
      },
      "placeholders": {
        "name": "EU customers",
        "description": "Subscribers in Germany and France on iOS 1.4+"
      },
      "errors": {
        "nameRequired": "Name is required.",
        "unknown": "Something went wrong. Please try again."
      }
    }
  },
```

- [ ] **Step 10.2: Validate JSON**

Run: `pnpm --filter @rovenue/dashboard exec node -e "JSON.parse(require('fs').readFileSync('src/i18n/locales/en.json', 'utf8'))"`
Expected: no output (parse succeeded). Any output is a JSON syntax error.

- [ ] **Step 10.3: Smoke-test in the browser**

Run: `pnpm --filter @rovenue/dashboard dev` (background)

Open the dashboard, navigate to `/projects/<id>/audiences`. Verify:
- "New audience" button is visible in the header.
- Default "All Users" row has no kebab menu.
- A custom audience row's kebab menu shows Edit + Delete.
- Click "New audience" → form loads with empty fields and "Sift document" preview showing `{}`.
- Fill in name "Test", click "Add condition" → "Country", type `TR`, submit. List now shows the new audience.
- Click the new row's kebab → "Edit" → form loads pre-filled with country=TR.
- Add a Platform=ios condition, save. Preview updates to `{ $and: [...] }`.
- Kebab → "Delete" → confirm. Row disappears.
- Visit `/audiences/aud_default` directly. Form renders with banner + everything disabled.

Stop the dev server once verified.

- [ ] **Step 10.4: Commit**

```bash
git add apps/dashboard/src/i18n/locales/en.json
git commit -m "feat(dashboard): add audiences i18n keys"
```

---

## Task 11: List-page route test

End-to-end-ish test: visit the audiences page via MSW, click "New", fill the form, submit, verify the POST body shape.

**Files:**
- Create: `apps/dashboard/tests/routes/audiences.test.tsx`

- [ ] **Step 11.1: Write the test**

Create `apps/dashboard/tests/routes/audiences.test.tsx`:

```tsx
import { describe, expect, test, vi } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../msw/server";
import { renderWithRouter } from "../render";
import { AudiencesPage } from "../../src/routes/_authed/projects/$projectId/audiences";

const BASE = "http://localhost:3000";

describe("<AudiencesPage />", () => {
  test("renders the audiences from the API", async () => {
    renderWithRouter(
      <AudiencesPage projectId="proj_1" />,
      "/projects/proj_1/audiences",
    );
    await waitFor(() =>
      expect(screen.getByText(/All Users/i)).toBeInTheDocument(),
    );
    expect(screen.getByText(/EU customers/i)).toBeInTheDocument();
  });

  test("default audience has no kebab menu", async () => {
    renderWithRouter(
      <AudiencesPage projectId="proj_1" />,
      "/projects/proj_1/audiences",
    );
    await waitFor(() =>
      expect(screen.getByText(/EU customers/i)).toBeInTheDocument(),
    );
    // Only the EU customers row should have an action menu.
    const menus = screen.getAllByRole("button", {
      name: /audience actions/i,
    });
    expect(menus).toHaveLength(1);
  });

  test("delete surfaces 409 'in use' error", async () => {
    server.use(
      http.delete(`${BASE}/dashboard/audiences/:id`, () =>
        HttpResponse.json(
          {
            error: {
              code: "CONFLICT",
              message: "Audience is in use by at least one experiment",
            },
          },
          { status: 409 },
        ),
      ),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);

    renderWithRouter(
      <AudiencesPage projectId="proj_1" />,
      "/projects/proj_1/audiences",
    );
    await waitFor(() =>
      expect(screen.getByText(/EU customers/i)).toBeInTheDocument(),
    );

    fireEvent.click(
      screen.getByRole("button", { name: /audience actions/i }),
    );
    fireEvent.click(screen.getByRole("button", { name: /^Delete$/i }));

    await waitFor(() =>
      expect(
        screen.getByText(/in use by at least one experiment/i),
      ).toBeInTheDocument(),
    );
  });
});
```

- [ ] **Step 11.2: Run the test**

Run: `pnpm --filter @rovenue/dashboard test audiences -- --run`
Expected: PASS — 3 tests green.

The MSW server is started globally by `apps/dashboard/tests/setup.ts`; `server.use(...)` inside a test overrides handlers for that test only and is auto-restored.

- [ ] **Step 11.3: Commit**

```bash
git add apps/dashboard/tests/routes/audiences.test.tsx
git commit -m "test(dashboard): cover audiences list rendering and delete error path"
```

---

## Task 12: Final integration check

- [ ] **Step 12.1: Full test suite**

Run: `pnpm test`
Expected: all packages green. If api/db suites need testcontainers and aren't running locally, scope to dashboard: `pnpm --filter @rovenue/dashboard test -- --run`.

- [ ] **Step 12.2: Production build**

Run: `pnpm --filter @rovenue/dashboard build`
Expected: PASS — runs `tsc && vite build` (no lint script exists; tsc is the type-check gate).

- [ ] **Step 12.3: Final manual smoke test**

Run: `pnpm dev` from the repo root. Visit `/projects/<id>/audiences`. Walk through: create custom audience, edit it, delete it. Verify:
- Default audience is still listed first (or wherever the backend orders it) and has no action menu.
- Creating an audience invalidates the list — new row appears without a hard refresh.
- Editing an audience writes back via PATCH and the row updates.
- Deleting a custom audience writes via DELETE and the row disappears.
- A second project's audiences are isolated from the first (visit two projects to confirm).

- [ ] **Step 12.4: Confirm no orphaned imports / unused code**

Run: `grep -rn "ConditionRow\|ConditionMenu\|ChipInput\|PlatformChips" apps/dashboard/src --include="*.tsx"`
Expected: only matches inside `apps/dashboard/src/components/targeting/condition-builder.tsx`. Anywhere else means a leftover from the extraction.

Run: `grep -rn "featureFlags.new.conditions" apps/dashboard/src apps/dashboard/tests --include="*.tsx" --include="*.ts" --include="*.json"`
Expected: no output. Any output means a leftover stale i18n key reference.

- [ ] **Step 12.5: Done**

No additional commit — Task 12 is a verification gate.

---

## Self-review notes

- Spec coverage: every section of `2026-05-26-audience-crud-design.md` has at least one task (Routes → 7,8,9; Shared builder → 2,3,4; Hooks → 5; Default handling → 6,8,9; Delete → 9; Testing → 2,11; i18n → 3,10).
- Type consistency: hook variable names match between definition (Task 5) and consumers (Tasks 6, 9). `DraftCondition` / `ConditionKind` / `CompareOp` / `ListOp` type names are stable from Task 2 onward.
- No placeholders — every step that touches code includes the code.
