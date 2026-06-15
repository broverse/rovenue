# Subscriber Attributes — Dashboard Implementation Plan (3 of 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Surface the new nested subscriber attributes in the dashboard — the detail panel shows a proper table (key, value, source, last-updated) instead of raw JSON, and the API serves the right shape (flat for the list, nested for the detail).

**Architecture:** The `subscribers.attributes` jsonb is now nested `{key: {value, updatedAt, source}}`. The dashboard list endpoint flattens to `{key: value}` (it only needs values, e.g. for the country column); the detail endpoint serves the full nested shape so the panel can render `source`/`updatedAt`. Shared response types are updated accordingly. The panel replaces its `JSON.stringify(<pre>)` block with a table styled like the existing access/purchase tables, with a source chip per row.

**Tech Stack:** Hono API, `@rovenue/shared` types, React + HeroUI (`@heroui/react`), react-i18next, Vitest + React Testing Library.

**Spec:** `docs/superpowers/specs/2026-06-15-subscriber-attributes-design.md`
**Depends on:** Plan 1 (backend) — nested storage + `flattenAttributes`/`normalizeStored`/`AttributeEntry`/`AttributeSource` exported from `@rovenue/shared`. Independent of Plan 2 (SDK).

---

## File Structure

**Modify:**
- `packages/shared/src/dashboard.ts` — `SubscriberDetail.attributes` → nested `SubscriberAttributes`; `SubscriberListItem.attributes` → flat `AttributeMap`.
- `apps/api/src/routes/dashboard/subscribers.ts:269` — list: `flattenAttributes(s.attributes)`.
- `apps/api/src/routes/dashboard/subscribers.ts:329` — detail: `normalizeStored(subscriber.attributes)`.
- `apps/dashboard/src/components/subscribers/SubscriberDetailPanel.tsx` — replace raw-JSON block with an attributes table.
- `apps/dashboard/src/i18n/locales/en.json` — add `subscribers.detail.attributesTable.*` keys.

**Create:**
- `apps/dashboard/src/components/subscribers/AttributesTable.tsx` — the table component.
- `apps/dashboard/tests/components/attributes-table.test.tsx` — component test.

---

## Task 1: Update shared response types

**Files:**
- Modify: `packages/shared/src/dashboard.ts:253` (SubscriberListItem), `:338` (SubscriberDetail)

- [ ] **Step 1: Import the attribute types**

At the top of `packages/shared/src/dashboard.ts`, add an import from the sibling attributes module:

```typescript
import type { AttributeMap, SubscriberAttributes } from "./attributes";
```

- [ ] **Step 2: Change the two field types**

In `SubscriberListItem` (line ~253), change:

```typescript
  attributes: AttributeMap;
```

In `SubscriberDetail` (line ~338), change:

```typescript
  attributes: SubscriberAttributes;
```

- [ ] **Step 3: Build the package**

Run: `pnpm --filter @rovenue/shared build`
Expected: builds clean. (Downstream type errors in api/dashboard are expected and fixed in Tasks 2-3 — this step only confirms `dashboard.ts` itself compiles.)

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/dashboard.ts
git commit -m "feat(shared): nested attributes type on SubscriberDetail, flat on list"
```

---

## Task 2: Serve the right shape from the dashboard API

**Files:**
- Modify: `apps/api/src/routes/dashboard/subscribers.ts` (lines ~269 and ~329)

- [ ] **Step 1: Write the failing test**

Add to the dashboard subscribers route integration test (the existing suite hitting a real Postgres). Seed a subscriber with nested attributes and assert:
- list endpoint returns `attributes` as a FLAT `{country: "US"}` map (no nested `value`/`source`).
- detail endpoint returns `attributes` as NESTED `{country: {value: "US", source: "...", updatedAt: "..."}}`.

```typescript
it("list returns flat attributes; detail returns nested", async () => {
  // seed subscriber with attributes = { country: {value:"US",updatedAt:"...",source:"sdk"} }
  const list = await listSubscribersViaApi(); // mirror existing helper
  const row = list.subscribers.find((s) => s.id === seededId)!;
  expect(row.attributes).toEqual({ country: "US" });

  const detail = await getSubscriberDetailViaApi(seededId);
  expect(detail.attributes.country).toMatchObject({ value: "US", source: "sdk" });
  expect(typeof detail.attributes.country.updatedAt).toBe("string");
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @rovenue/api test -- dashboard/subscribers`
Expected: FAIL — both endpoints currently return the raw nested cast for list and detail.

- [ ] **Step 3: Add the import**

At the top of `apps/api/src/routes/dashboard/subscribers.ts`:

```typescript
import { flattenAttributes, normalizeStored } from "@rovenue/shared";
```

- [ ] **Step 4: Flatten the list response (line ~269)**

Change:

```typescript
    attributes: flattenAttributes(s.attributes),
```

- [ ] **Step 5: Normalize the detail response (line ~329)**

Change:

```typescript
    attributes: normalizeStored(subscriber.attributes),
```

(`normalizeStored` returns the typed nested `SubscriberAttributes`, tolerating any legacy flat rows.)

- [ ] **Step 6: Run it to verify it passes**

Run: `pnpm --filter @rovenue/api test -- dashboard/subscribers`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/routes/dashboard/subscribers.ts
git commit -m "feat(api): flat attributes for subscriber list, nested for detail"
```

---

## Task 3: AttributesTable component + panel integration

**Files:**
- Create: `apps/dashboard/src/components/subscribers/AttributesTable.tsx`
- Modify: `apps/dashboard/src/components/subscribers/SubscriberDetailPanel.tsx` (lines ~98-104)
- Modify: `apps/dashboard/src/i18n/locales/en.json`

- [ ] **Step 1: Add i18n keys**

In `apps/dashboard/src/i18n/locales/en.json`, under `subscribers.detail`, add a sibling object (keep `attributes` as the existing section label string):

```json
"attributesTable": {
  "empty": "No attributes",
  "key": "Attribute",
  "value": "Value",
  "source": "Source",
  "updatedAt": "Updated"
}
```

(Place it next to the existing `subscribers.detail.attributes` key. Do not remove existing keys.)

- [ ] **Step 2: Write the failing component test**

Create `apps/dashboard/tests/components/attributes-table.test.tsx` (mirror `tests/components/refund-shield-chips.test.tsx` for i18n init):

```typescript
import { describe, expect, test, beforeAll } from "vitest";
import { render, screen } from "@testing-library/react";
import i18next from "i18next";
import { initReactI18next } from "react-i18next";
import en from "../../src/i18n/locales/en.json";
import { AttributesTable } from "../../src/components/subscribers/AttributesTable";

beforeAll(async () => {
  if (!i18next.isInitialized) {
    await i18next.use(initReactI18next).init({
      resources: { en: { common: en } },
      lng: "en",
      fallbackLng: "en",
      defaultNS: "common",
      interpolation: { escapeValue: false },
    });
  }
});

describe("AttributesTable", () => {
  test("renders one row per attribute with value + source", () => {
    render(
      <AttributesTable
        attributes={{
          $email: { value: "a@b.com", updatedAt: "2026-06-15T10:00:00.000Z", source: "sdk" },
          favoriteTeam: { value: "GS", updatedAt: "2026-06-15T10:00:00.000Z", source: "dashboard" },
        }}
      />,
    );
    expect(screen.getByText("$email")).toBeInTheDocument();
    expect(screen.getByText("a@b.com")).toBeInTheDocument();
    expect(screen.getByText("GS")).toBeInTheDocument();
    expect(screen.getByText("sdk")).toBeInTheDocument();
    expect(screen.getByText("dashboard")).toBeInTheDocument();
  });

  test("renders empty state when no attributes", () => {
    render(<AttributesTable attributes={{}} />);
    expect(screen.getByText("No attributes")).toBeInTheDocument();
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @rovenue/dashboard test -- attributes-table`
Expected: FAIL — `AttributesTable` doesn't exist.

- [ ] **Step 4: Implement AttributesTable**

Create `apps/dashboard/src/components/subscribers/AttributesTable.tsx`. Use HeroUI's `Table` family if the sibling tables (AccessTable/PurchasesTable) use it; otherwise a plain styled table. Implementation using HeroUI Chip for the source + a simple table (match the sibling tables' component choice — inspect `AccessTable.tsx` and mirror it):

```tsx
import { Chip } from "@heroui/react";
import { useTranslation } from "react-i18next";
import type { AttributeEntry, AttributeSource, SubscriberAttributes } from "@rovenue/shared";

const SOURCE_COLOR: Record<AttributeSource, "primary" | "secondary" | "success" | "default"> = {
  sdk: "primary",
  server: "secondary",
  dashboard: "success",
  legacy: "default",
};

function formatUpdatedAt(iso: string): string {
  // Legacy epoch sentinel renders as "—"
  if (iso === "1970-01-01T00:00:00.000Z") return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString();
}

export function AttributesTable({ attributes }: { attributes: SubscriberAttributes }) {
  const { t } = useTranslation();
  const entries = Object.entries(attributes) as Array<[string, AttributeEntry]>;
  entries.sort(([a], [b]) => a.localeCompare(b));

  if (entries.length === 0) {
    return <p className="text-sm text-default-500">{t("subscribers.detail.attributesTable.empty")}</p>;
  }

  return (
    <table className="w-full text-left text-sm">
      <thead className="text-default-500">
        <tr>
          <th className="py-1 pr-4 font-medium">{t("subscribers.detail.attributesTable.key")}</th>
          <th className="py-1 pr-4 font-medium">{t("subscribers.detail.attributesTable.value")}</th>
          <th className="py-1 pr-4 font-medium">{t("subscribers.detail.attributesTable.source")}</th>
          <th className="py-1 font-medium">{t("subscribers.detail.attributesTable.updatedAt")}</th>
        </tr>
      </thead>
      <tbody>
        {entries.map(([key, entry]) => (
          <tr key={key} className="border-t border-default-100">
            <td className="py-1.5 pr-4 font-mono text-xs">{key}</td>
            <td className="py-1.5 pr-4 break-all">{entry.value}</td>
            <td className="py-1.5 pr-4">
              <Chip size="sm" variant="flat" color={SOURCE_COLOR[entry.source] ?? "default"}>
                {entry.source}
              </Chip>
            </td>
            <td className="py-1.5 text-default-500">{formatUpdatedAt(entry.updatedAt)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
```

> If `AccessTable.tsx`/`PurchasesTable.tsx` use HeroUI's `<Table>/<TableHeader>/<TableColumn>/<TableBody>/<TableRow>/<TableCell>`, use that component set instead for visual consistency. The plain `<table>` above is the fallback; match the siblings.

- [ ] **Step 5: Swap the panel's raw-JSON block**

In `SubscriberDetailPanel.tsx`, replace the `<details>…JSON.stringify…</details>` block (lines ~98-104) with:

```tsx
<div className="mt-4 text-sm">
  <h3 className="mb-2 text-default-500">{t("subscribers.detail.attributes")}</h3>
  <AttributesTable attributes={data.attributes} />
</div>
```

Add the import at the top:

```tsx
import { AttributesTable } from "./AttributesTable";
```

(`data.attributes` is now typed `SubscriberAttributes` from Task 1, so it matches the component prop.)

- [ ] **Step 6: Run it to verify it passes**

Run: `pnpm --filter @rovenue/dashboard test -- attributes-table`
Expected: PASS (2 tests).

- [ ] **Step 7: Commit**

```bash
git add apps/dashboard/src/components/subscribers/AttributesTable.tsx \
        apps/dashboard/src/components/subscribers/SubscriberDetailPanel.tsx \
        apps/dashboard/src/i18n/locales/en.json \
        apps/dashboard/tests/components/attributes-table.test.tsx
git commit -m "feat(dashboard): attributes table with source + updatedAt"
```

---

## Task 4: Full build + test sweep

**Files:** none (verification)

- [ ] **Step 1: Type-check everything**

Run: `pnpm build`
Expected: all 7 packages build clean. The most likely breakages are other dashboard/api sites that read `SubscriberDetail.attributes` / `SubscriberListItem.attributes` assuming the old `Record<string, unknown>` shape — fix each by reading `entry.value` (detail) or treating it as a flat map (list).

- [ ] **Step 2: Grep for other consumers of the changed types**

Run: `grep -rn "\.attributes" apps/dashboard/src | grep -v "AttributesTable\|\.test\."`
Expected: every hit either renders via `AttributesTable`, reads a flat list value, or is unrelated. Fix any site that destructures the old flat `Record<string, unknown>` from a detail response.

- [ ] **Step 3: Run dashboard + api test suites**

Run: `pnpm --filter @rovenue/dashboard test && pnpm --filter @rovenue/api test -- dashboard/subscribers`
Expected: green.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A
git commit -m "chore(dashboard): align remaining attribute readers with new shapes"
```

---

## Notes

- **Editing attributes from the dashboard is out of scope** (display only). The `source: "dashboard"` value exists in the catalog for when that lands; this plan never writes it.
- **Legacy rows** (migrated with `source: "legacy"`, epoch `updatedAt`) render with a neutral chip and "—" for the timestamp, which is the intended treatment.
```
