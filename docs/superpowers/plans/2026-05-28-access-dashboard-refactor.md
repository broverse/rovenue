# Access Dashboard Refactor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the dashboard UI in line with the access-foundation rename landed in Plan 1 (DB + API): a new `/access` page replaces `/product-groups`, offerings live as a sub-section of each access detail, the entitlement-chip family becomes access-chip + sources from the catalog, and the products form's "entitlements" input becomes a multi-select dropdown sourced from the access catalog.

**Architecture:**
- New route tree: `/projects/$projectId/access` (list) + `/projects/$projectId/access/$accessId` (detail, with offerings sub-section). Old `/product-groups.tsx` route file is deleted (pre-launch — no redirect shim).
- `apps/dashboard/src/components/product-groups/` directory is git-renamed to `components/offerings/`; every `ProductGroup*` symbol becomes `Offering*`. Offering form gains an `accessId` field (the access this offering is scoped to).
- New `apps/dashboard/src/components/access/` directory: `access-list.tsx`, `access-header.tsx`, `access-form-dialog.tsx`, `delete-access-dialog.tsx`, `access-offerings-section.tsx` (embeds offering list scoped to current access).
- `entitlement-chip.tsx` → `access-chip.tsx`; `EntitlementChip`/`EntitlementList` → `AccessChip`/`AccessList`. The list accepts `Array<{ id, identifier, displayName }>` (resolved from the catalog) instead of raw strings.
- New `useProjectAccess.ts` hook family wraps `/dashboard/projects/:projectId/access` CRUD (added in Plan 1 — Task 8). Existing `useProjectProductGroups.ts` becomes `useProjectOfferings.ts` with renamed hooks + new `useOfferingsByAccess(accessId)` filter.
- Products form modal swaps the free-form `entitlementKeys: []` placeholder for a multi-select of access rows (`useProjectAccess`).
- Subscriber detail panel's "entitlements" tab becomes "access"; `AccessTable` resolves `accessId` → `displayName` via the catalog.
- Experiments builder (`new.tsx`) renames its `PRODUCT_GROUP` enum case and `productGroupId` variant field to `OFFERING`/`offeringId`, swaps the `useProjectProductGroups` call for `useProjectOfferings`.
- i18n: every `productGroups.*` / `entitlement*` key in `en.json` is renamed to `access.*` / `offerings.*` / `access*` to match the new surface.

**Tech Stack:** React (Vite + TypeScript), TanStack Router (file-based), TanStack Query, Tailwind, Hono API on the other side, Vitest + Testing Library, MSW for mocks. Same pnpm workspace as the rest of the monorepo.

**Out of scope (separate work):**
- ClickHouse chart-filter dimension key `productGroup` in `ChartFilterOptionsResponse` + `apps/dashboard/src/components/charts/filters-card.tsx`. The CH analytics column is `productGroupId` and renaming it requires a CH migration. Tracked separately.
- Any SDK rename (handled by Plan 2).
- Test files in `apps/api/tests/*.test.ts` that still reference old Prisma-mock structures — pre-existing rot, unrelated to this plan.

---

## File Structure

### Created files
- `apps/dashboard/src/lib/hooks/useProjectAccess.ts` — `useProjectAccess` (list), `useAccessById`, `useCreateAccess`, `useUpdateAccess`, `useDeleteAccess`. Returns query keys under `["access", projectId, ...]`.
- `apps/dashboard/src/components/access/index.ts` — barrel for the new components.
- `apps/dashboard/src/components/access/access-list.tsx` — left-rail list of access rows with selection + search (mirrors `OfferingList` shape).
- `apps/dashboard/src/components/access/access-header.tsx` — selected access row's title + actions menu.
- `apps/dashboard/src/components/access/access-form-dialog.tsx` — create/edit dialog (identifier, displayName, description, metadata).
- `apps/dashboard/src/components/access/delete-access-dialog.tsx` — confirms delete; surfaces 409 from API when access is still referenced.
- `apps/dashboard/src/components/access/access-offerings-section.tsx` — embeds an offerings list filtered to the current access, plus create/link CTAs.
- `apps/dashboard/src/routes/_authed/projects/$projectId/access.tsx` — outer route component that drives the page.
- `apps/dashboard/src/routes/_authed/projects/$projectId/access/$accessId.tsx` — single-access detail (rendered inside the same page; uses search-param `accessId` for selection alternatively — see Task 13 for the chosen approach).
- `apps/dashboard/src/components/products/access-chip.tsx` — replaces `entitlement-chip.tsx`. Exports `AccessChip`, `AccessList`. `AccessList` accepts `Array<{ id, identifier, displayName }>` so it can show the human label while keying off the id.
- `apps/dashboard/src/components/access/__tests__/access-form-dialog.test.tsx` — vitest spec covering identifier validation + 409 surfacing.
- `apps/dashboard/src/components/access/__tests__/access-offerings-section.test.tsx` — vitest spec covering "list shows only offerings scoped to this access" + "create defaults accessId".

### Modified files
- `apps/dashboard/src/components/dashboard/navigation.ts` — rename `groups` entry → `access`, change `to:` to `/projects/$projectId/access`, swap `Layers` icon (keep) or move to `KeyRound`/`Shield` to match the "permissions catalog" framing.
- `apps/dashboard/src/lib/hooks/useProjectProductGroups.ts` — rename file via `git mv` to `useProjectOfferings.ts`; rename `useProjectProductGroups` → `useProjectOfferings`; add `useOfferingsByAccess(projectId, accessId)`; rename every other hook + query key + endpoint path (`product-groups` → `offerings`); add `accessId` to create/update bodies.
- `apps/dashboard/src/components/product-groups/` (whole directory) — `git mv` to `apps/dashboard/src/components/offerings/`. Every file renamed `product-group-*` → `offering-*`. Every `ProductGroup` symbol renamed to `Offering`. `types.ts` reuses the `DashboardOfferingRow` shape from `@rovenue/shared`. `offering-form-dialog.tsx` gains a required `accessId` select (sourced from `useProjectAccess`).
- `apps/dashboard/src/lib/dashboard-mappers.ts` — `rowToUiProductGroup` → `rowToUiOffering`; field renames; `groupLabelFromRow` → `offeringLabelFromRow`; payload mapper for `accessIds` already wired in Plan 1, but extend to surface `Array<{ id, identifier, displayName }>` for `AccessList`.
- `apps/dashboard/src/components/products/product-form-modal.tsx` — replace the placeholder `entitlementKeys: []` lines with a `Combobox` (multi-select) of access rows. Body field renamed `accessIds`. Loads via `useProjectAccess`.
- `apps/dashboard/src/components/products/product-drawer.tsx` — render `AccessList` instead of `EntitlementList`, passing the resolved access rows.
- `apps/dashboard/src/components/products/index.ts` — barrel rename: export `AccessChip` / `AccessList` from `./access-chip` instead of the entitlement ones.
- `apps/dashboard/src/components/subscribers/AccessTable.tsx` — column header `entitlement` → `access`; row key uses `${accessId}-${purchaseId}`; cell shows `displayName` resolved via the access catalog (fall back to raw `accessId` if unresolved).
- `apps/dashboard/src/components/subscribers/subscriber-detail-panel.tsx` — tab key `"entitlements"` → `"access"`; label key `subscribers.panel.tabs.entitlements` → `subscribers.panel.tabs.access`; render `AccessChip` instead of `EntitlementChip`.
- `apps/dashboard/src/routes/_authed/projects/$projectId/route.tsx` — drop the `product-groups` link/section (sidebar nav already changed; this is for any in-route breadcrumb).
- `apps/dashboard/src/routes/_authed/projects/$projectId/experiments/new.tsx` — rename the `PRODUCT_GROUP` enum value → `OFFERING`, `productGroupId` variant field → `offeringId`, `useProjectProductGroups` → `useProjectOfferings`, label keys + error keys, copy strings.
- `apps/dashboard/src/components/experiments/format.ts` — `t === "PRODUCT_GROUP"` → `t === "OFFERING"`.
- `apps/dashboard/src/i18n/locales/en.json` — wholesale key rename pass; new copy for `access.*`; rename `productGroups.*` → `offerings.*`; rename every `entitlement*` user-facing string to "access".

### Deleted files
- `apps/dashboard/src/routes/_authed/projects/$projectId/product-groups.tsx` (replaced by the access route tree).
- `apps/dashboard/src/components/products/entitlement-chip.tsx` (replaced by `access-chip.tsx`).

### Files NOT touched in this plan
- `apps/dashboard/src/components/charts/filters-card.tsx` — chart dimension key `productGroup` stays; pulls a CH column with that name. Separate plan.
- `apps/api/src/services/metrics/charts.ts` — same reason.
- `packages/shared/src/dashboard.ts` `ChartFilterOptionsResponse.productGroup` — same.

---

## Task 1: Add `useProjectAccess` hooks

**Files:**
- Create: `apps/dashboard/src/lib/hooks/useProjectAccess.ts`

- [ ] **Step 1: Write the hook module**

Look at `apps/dashboard/src/lib/hooks/useProjectProductGroups.ts` for the conventions (`api()` wrapper, query keys, invalidation). Create `apps/dashboard/src/lib/hooks/useProjectAccess.ts`:

```typescript
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DashboardAccessCreateInput,
  DashboardAccessListResponse,
  DashboardAccessRow,
  DashboardAccessUpdateInput,
} from "@rovenue/shared";
import { api } from "../api";

const root = (projectId: string) =>
  `/dashboard/projects/${projectId}/access` as const;

export function useProjectAccess(projectId: string) {
  return useQuery({
    queryKey: ["access", "list", projectId],
    enabled: Boolean(projectId),
    queryFn: () => api<DashboardAccessListResponse>(root(projectId)),
  });
}

export function useAccessById(projectId: string, id: string | null) {
  return useQuery({
    queryKey: ["access", "detail", projectId, id],
    enabled: Boolean(projectId && id),
    queryFn: () => api<DashboardAccessRow>(`${root(projectId)}/${id}`),
  });
}

export function useCreateAccess(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DashboardAccessCreateInput) =>
      api<DashboardAccessRow>(root(projectId), {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["access"] }),
  });
}

export function useUpdateAccess(projectId: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DashboardAccessUpdateInput) =>
      api<DashboardAccessRow>(`${root(projectId)}/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["access"] }),
  });
}

export function useDeleteAccess(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<void>(`${root(projectId)}/${id}`, { method: "DELETE" }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["access"] }),
  });
}
```

> Note: `DashboardAccess*` types were added to `packages/shared/src/dashboard.ts` in Plan 1 — Task 7. If TypeScript can't find them, re-run `pnpm --filter @rovenue/shared build`.

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit
```

Expected: no new errors out of the file. Pre-existing TanStack Router type errors in unrelated files are OK to ignore.

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/lib/hooks/useProjectAccess.ts
git commit -m "feat(dashboard): useProjectAccess hooks for access catalog CRUD"
```

---

## Task 2: Rename entitlement-chip → access-chip

**Files:**
- Create: `apps/dashboard/src/components/products/access-chip.tsx`
- Delete: `apps/dashboard/src/components/products/entitlement-chip.tsx`
- Modify: `apps/dashboard/src/components/products/index.ts`

- [ ] **Step 1: Create `access-chip.tsx`**

Create `apps/dashboard/src/components/products/access-chip.tsx`:

```typescript
import { cva, type VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export const accessChipVariants = cva(
  "inline-flex h-5 items-center gap-1 rounded-[4px] border px-1.5 font-rv-mono text-[10px]",
  {
    variants: {
      tone: {
        granted:
          "border-rv-violet/25 bg-rv-violet/15 text-[color-mix(in_srgb,var(--color-rv-violet)_25%,white)]",
        none: "border-rv-divider bg-rv-c4 text-rv-mute-500",
      },
    },
    defaultVariants: { tone: "granted" },
  },
);

export type AccessChipProps = VariantProps<typeof accessChipVariants> & {
  children: ReactNode;
  className?: string;
};

export function AccessChip({ tone, children, className }: AccessChipProps) {
  return (
    <span className={cn(accessChipVariants({ tone }), className)}>
      {children}
    </span>
  );
}

/** One human-readable access entry — `identifier` is the slug,
 *  `displayName` is what the UI shows. */
export interface AccessChipEntry {
  id: string;
  identifier: string;
  displayName: string;
}

interface ListProps {
  access: ReadonlyArray<AccessChipEntry>;
  /** When the list exceeds `max`, the remainder is shown as `+N`. */
  max?: number;
}

export function AccessList({ access, max = 2 }: ListProps) {
  if (access.length === 0) {
    return (
      <div className="flex flex-wrap gap-1">
        <AccessChip tone="none">—</AccessChip>
      </div>
    );
  }
  const head = access.slice(0, max);
  const overflow = access.length - head.length;
  return (
    <div className="flex flex-wrap gap-1">
      {head.map((a) => (
        <AccessChip key={a.id} title={a.identifier}>
          {a.displayName}
        </AccessChip>
      ))}
      {overflow > 0 && <AccessChip tone="none">+{overflow}</AccessChip>}
    </div>
  );
}
```

- [ ] **Step 2: Delete the old file**

```bash
git rm apps/dashboard/src/components/products/entitlement-chip.tsx
```

- [ ] **Step 3: Update the barrel `apps/dashboard/src/components/products/index.ts`**

Open it and replace the line that re-exports the entitlement chip family with:

```typescript
export {
  AccessChip,
  AccessList,
  type AccessChipEntry,
} from "./access-chip";
```

Remove any line that exports `EntitlementChip` / `EntitlementList`.

- [ ] **Step 4: Typecheck — expect breakage in callers**

```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit 2>&1 | grep -E "Entitlement|entitlement"
```

Expected: errors in `product-drawer.tsx`, `subscriber-detail-panel.tsx`, possibly `dashboard-mappers.ts` consumers. These get fixed in Tasks 5 + 6 + 7. For now this is a known transient state.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/products/access-chip.tsx \
        apps/dashboard/src/components/products/index.ts
git commit -m "refactor(dashboard): rename EntitlementChip to AccessChip"
```

---

## Task 3: Rename product-groups components → offerings (directory + symbols)

**Files:**
- Rename (`git mv`): every file under `apps/dashboard/src/components/product-groups/` → `apps/dashboard/src/components/offerings/`, file basenames `product-group-*` → `offering-*`.
- Modify: every renamed file's internal symbols.

- [ ] **Step 1: Move the directory + rename files**

```bash
git mv apps/dashboard/src/components/product-groups apps/dashboard/src/components/offerings
cd apps/dashboard/src/components/offerings

git mv product-group-actions-menu.tsx   offering-actions-menu.tsx
git mv product-group-form-dialog.tsx    offering-form-dialog.tsx
git mv product-group-header.tsx         offering-header.tsx
git mv product-group-icon.tsx           offering-icon.tsx
git mv product-group-list.tsx           offering-list.tsx
git mv delete-product-group-dialog.tsx  delete-offering-dialog.tsx
git mv link-products-dialog.tsx         link-products-dialog.tsx  # already neutral — keep
git mv group-products-section.tsx       offering-products-section.tsx
git mv remove-product-dialog.tsx        remove-product-dialog.tsx  # neutral — keep
cd -
```

> If `git mv` of a same-named file errors, skip it — the file already has the right name.

- [ ] **Step 2: Inside every renamed file, rename `ProductGroup*` symbols → `Offering*`**

Run this find-and-edit pass. For each file in `apps/dashboard/src/components/offerings/`:

- `ProductGroup` (type) → `Offering`
- `ProductGroupRow` / `DashboardProductGroupRow` → `DashboardOfferingRow`
- `ProductGroupList` (component) → `OfferingList`
- `ProductGroupHeader` → `OfferingHeader`
- `ProductGroupFormDialog` → `OfferingFormDialog`
- `ProductGroupActionsMenu` → `OfferingActionsMenu`
- `ProductGroupIcon` → `OfferingIcon`
- `productGroupIconVariants` → `offeringIconVariants`
- `DeleteProductGroupDialog` → `DeleteOfferingDialog`
- `GroupProductsSection` → `OfferingProductsSection`
- `useProjectProductGroups` import → `useProjectOfferings` (the hook itself is renamed in Task 4)
- `useProductGroupById` → `useOfferingById`
- `useCreateProductGroup` → `useCreateOffering`
- `useUpdateProductGroup` → `useUpdateOffering`
- `useDeleteProductGroup` → `useDeleteOffering`
- `productGroupRepo` (any leftover) → `offeringRepo`

Then in `apps/dashboard/src/components/offerings/index.ts`, replace the body with:

```typescript
export { OfferingList } from "./offering-list";
export { OfferingHeader } from "./offering-header";
export { OfferingFormDialog } from "./offering-form-dialog";
export { OfferingActionsMenu } from "./offering-actions-menu";
export { OfferingIcon, offeringIconVariants } from "./offering-icon";
export { DeleteOfferingDialog } from "./delete-offering-dialog";
export { OfferingProductsSection } from "./offering-products-section";
export { LinkProductsDialog } from "./link-products-dialog";
export { RemoveProductDialog } from "./remove-product-dialog";
export type { Offering } from "./types";
```

And in `types.ts`, replace the local `ProductGroup` type alias with:

```typescript
import type { DashboardOfferingRow } from "@rovenue/shared";

export type Offering = DashboardOfferingRow;
```

- [ ] **Step 3: Add `accessId` to `OfferingFormDialog`**

Open `offering-form-dialog.tsx`. Wherever the form state interface is declared (`interface FormState { identifier: string; isDefault: boolean; ... }`), add:

```typescript
accessId: string;
```

In the body of the dialog, add a select element after the identifier field:

```tsx
<Field
  label={t("offerings.form.access.label", "Access")}
  hint={t(
    "offerings.form.access.hint",
    "Which access this offering grants on purchase",
  )}
>
  <select
    className="..."   // copy from the existing select styling pattern
    value={form.accessId}
    onChange={(e) => setForm({ ...form, accessId: e.target.value })}
    required
  >
    <option value="">{t("offerings.form.access.placeholder", "Select access…")}</option>
    {accessRows.map((a) => (
      <option key={a.id} value={a.id}>
        {a.displayName} ({a.identifier})
      </option>
    ))}
  </select>
</Field>
```

Inside the component, fetch the rows:

```typescript
import { useProjectAccess } from "../../lib/hooks/useProjectAccess";
const accessQuery = useProjectAccess(projectId);
const accessRows = accessQuery.data?.rows ?? [];
```

Submit body shape becomes:

```typescript
{ identifier, accessId, isDefault, products, metadata }
```

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit 2>&1 | grep -E "Offering|productGroup|ProductGroup" | head -20
```

Expected: remaining errors are in route files (`product-groups.tsx`), `experiments/new.tsx`, `dashboard-mappers.ts`, and the hook file — those are next tasks.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/offerings/
git commit -m "refactor(dashboard): rename product-groups components dir to offerings"
```

---

## Task 4: Rename `useProjectProductGroups` → `useProjectOfferings`

**Files:**
- Rename (`git mv`): `apps/dashboard/src/lib/hooks/useProjectProductGroups.ts` → `useProjectOfferings.ts`
- Modify: internal symbols + every caller

- [ ] **Step 1: Rename the file**

```bash
git mv apps/dashboard/src/lib/hooks/useProjectProductGroups.ts \
       apps/dashboard/src/lib/hooks/useProjectOfferings.ts
```

- [ ] **Step 2: Rewrite the file body**

Open `apps/dashboard/src/lib/hooks/useProjectOfferings.ts` and replace its content with:

```typescript
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  DashboardOfferingCreateInput,
  DashboardOfferingRow,
  DashboardOfferingUpdateInput,
  DashboardOfferingsListResponse,
} from "@rovenue/shared";
import { api } from "../api";

const root = (projectId: string) =>
  `/dashboard/projects/${projectId}/offerings` as const;

export function useProjectOfferings(projectId: string) {
  return useQuery({
    queryKey: ["offerings", "list", projectId],
    enabled: Boolean(projectId),
    queryFn: () => api<DashboardOfferingsListResponse>(root(projectId)),
  });
}

export function useOfferingsByAccess(projectId: string, accessId: string | null) {
  return useQuery({
    queryKey: ["offerings", "by-access", projectId, accessId],
    enabled: Boolean(projectId && accessId),
    queryFn: () =>
      api<DashboardOfferingsListResponse>(
        `${root(projectId)}?accessId=${encodeURIComponent(accessId!)}`,
      ),
  });
}

export function useOfferingById(projectId: string, id: string | null) {
  return useQuery({
    queryKey: ["offerings", "detail", projectId, id],
    enabled: Boolean(projectId && id),
    queryFn: () =>
      api<{ offering: DashboardOfferingRow }>(`${root(projectId)}/${id}`),
  });
}

export function useCreateOffering(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DashboardOfferingCreateInput) =>
      api<{ offering: DashboardOfferingRow }>(root(projectId), {
        method: "POST",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["offerings"] }),
  });
}

export function useUpdateOffering(projectId: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: DashboardOfferingUpdateInput) =>
      api<{ offering: DashboardOfferingRow }>(`${root(projectId)}/${id}`, {
        method: "PATCH",
        body: JSON.stringify(body),
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["offerings"] }),
  });
}

export function useDeleteOffering(projectId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api<{ deleted: true }>(`${root(projectId)}/${id}`, {
        method: "DELETE",
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["offerings"] }),
  });
}
```

- [ ] **Step 3: Update every importer**

Run a repo-wide rename of the import paths and symbol names:

```bash
grep -rln "useProjectProductGroups\|useProductGroupById\|useCreateProductGroup\|useUpdateProductGroup\|useDeleteProductGroup" apps/dashboard/src --include="*.ts" --include="*.tsx"
```

For each file in the output, swap:
- `useProjectProductGroups` → `useProjectOfferings`
- `useProductGroupById` → `useOfferingById`
- `useCreateProductGroup` → `useCreateOffering`
- `useUpdateProductGroup` → `useUpdateOffering`
- `useDeleteProductGroup` → `useDeleteOffering`
- import path `"../lib/hooks/useProjectProductGroups"` (or any relative prefix) → `"../lib/hooks/useProjectOfferings"`

`apps/dashboard/src/routes/_authed/projects/$projectId/experiments/new.tsx` is the loudest caller — pay attention to the surrounding rename in Task 12 so you don't double-edit.

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit 2>&1 | grep -E "ProductGroup|productGroup" | head -20
```

Remaining errors should be limited to (a) `product-groups.tsx` route (Task 10), (b) `experiments/new.tsx` (Task 12), (c) `dashboard-mappers.ts` (Task 5).

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/lib/hooks/useProjectOfferings.ts \
        apps/dashboard/src/   # picks up the caller edits
git commit -m "refactor(dashboard): rename useProjectProductGroups to useProjectOfferings"
```

---

## Task 5: Update `dashboard-mappers.ts`

**Files:**
- Modify: `apps/dashboard/src/lib/dashboard-mappers.ts`

- [ ] **Step 1: Audit current state**

Open `apps/dashboard/src/lib/dashboard-mappers.ts` and find `rowToUiProductGroup` plus every usage of `EntitlementList`, `entitlementKeys`, `productGroup*`. After Plan 1 - Task 15, the file already references `row.accessIds`; this task finishes the UI-side rename.

- [ ] **Step 2: Rename `rowToUiProductGroup` → `rowToUiOffering`**

Find:

```typescript
export function rowToUiProductGroup(row: DashboardProductGroupRow): ProductGroup {
```

Replace with:

```typescript
import type { DashboardOfferingRow } from "@rovenue/shared";

export function rowToUiOffering(row: DashboardOfferingRow): Offering {
```

…and rename the local `ProductGroup` UI type to `Offering` accordingly (look near the top of the file for the type alias / interface).

If a `groupLabelFromRow` helper exists, rename it to `offeringLabelFromRow`. Update the import side from `i18n` keys (`productGroups.*` → `offerings.*`) for any inline strings (most are i18n keys handled in Task 14, but verify).

- [ ] **Step 3: Adapt the access list mapper**

Wherever `rowToUiProduct` (and other product mappers) currently set `entitlements: row.accessIds` (literally the array of cuid2 ids), rewire the mapper to accept the resolved access rows:

```typescript
import type { AccessChipEntry } from "../components/products/access-chip";

interface RowToUiProductOpts {
  accessById: Map<string, AccessChipEntry>;
}

export function rowToUiProduct(
  row: DashboardProductRow,
  opts: RowToUiProductOpts,
): Product {
  const { price, currency } = priceFromRow(row);
  const isSubscription = row.type === "SUBSCRIPTION";
  const trialMeta = row.metadata?.trial;
  return {
    id: row.id,
    sku: row.identifier,
    name: row.displayName || row.identifier,
    group: offeringLabelFromRow(row),
    access: row.accessIds
      .map((id) => opts.accessById.get(id))
      .filter((a): a is AccessChipEntry => Boolean(a)),
    duration: durationFromRow(row),
    price,
    currency,
    trial: typeof trialMeta === "string" ? trialMeta : null,
    subs: isSubscription ? 0 : null,
    mrr: 0,
    status: statusFromRow(row),
    stores: storesFromRow(row),
    created: row.createdAt,
    updated: row.updatedAt,
  };
}
```

Update the `Product` UI type (likely declared at the top of `dashboard-mappers.ts` or `types.ts`): replace `entitlements: string[]` with `access: AccessChipEntry[]`.

- [ ] **Step 4: Update every caller of `rowToUiProduct`**

```bash
grep -rln "rowToUiProduct\b" apps/dashboard/src --include="*.ts" --include="*.tsx"
```

For each caller (likely `products.tsx` route + `product-drawer.tsx`), provide the `accessById` map:

```typescript
import { useProjectAccess } from "../lib/hooks/useProjectAccess";

const accessQuery = useProjectAccess(projectId);
const accessById = useMemo(() => {
  const m = new Map<string, AccessChipEntry>();
  for (const r of accessQuery.data?.rows ?? []) {
    m.set(r.id, { id: r.id, identifier: r.identifier, displayName: r.displayName });
  }
  return m;
}, [accessQuery.data]);

const uiProducts = useMemo(
  () => productsQuery.data?.products.map((p) => rowToUiProduct(p, { accessById })) ?? [],
  [productsQuery.data, accessById],
);
```

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit 2>&1 | grep -E "rowToUiProductGroup|EntitlementList|entitlementKeys" | head
```

Expected: no hits (all renamed).

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/lib/dashboard-mappers.ts \
        apps/dashboard/src/routes/_authed/projects/\$projectId/products.tsx \
        apps/dashboard/src/components/products/
git commit -m "refactor(dashboard): mappers + product list use access catalog"
```

---

## Task 6: Update `product-form-modal.tsx`

**Files:**
- Modify: `apps/dashboard/src/components/products/product-form-modal.tsx`

- [ ] **Step 1: Replace the entitlementKeys placeholder with a real multi-select**

Open `product-form-modal.tsx`. Find:

```typescript
entitlementKeys: [],
```

and:

```typescript
entitlementKeys: existing.data?.product?.entitlementKeys ?? [],
```

Replace both with `accessIds: ...`. In the create branch:

```typescript
accessIds: [],
```

In the edit branch:

```typescript
accessIds: existing.data?.product?.accessIds ?? [],
```

- [ ] **Step 2: Add the access multi-select control**

Near the top of the component body, fetch access rows:

```typescript
import { useProjectAccess } from "../../lib/hooks/useProjectAccess";

const accessQuery = useProjectAccess(projectId);
const accessRows = accessQuery.data?.rows ?? [];
```

Wherever the form fields render (look for the existing fields like `displayName`, `storeIds`), add a new field:

```tsx
<Field
  label={t("products.form.access.label", "Access granted")}
  hint={t(
    "products.form.access.hint",
    "Pick one or more access rows from the catalog. Subscribers see these as access.identifier in the SDK.",
  )}
>
  <div className="flex flex-col gap-1">
    {accessRows.length === 0 && (
      <p className="text-xs text-rv-mute-500">
        {t(
          "products.form.access.empty",
          "No access defined yet. Create one from the Access page first.",
        )}
      </p>
    )}
    {accessRows.map((a) => {
      const checked = form.accessIds.includes(a.id);
      return (
        <label
          key={a.id}
          className="flex items-center gap-2 text-xs cursor-pointer"
        >
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) =>
              setForm({
                ...form,
                accessIds: e.target.checked
                  ? [...form.accessIds, a.id]
                  : form.accessIds.filter((id) => id !== a.id),
              })
            }
          />
          <span className="font-rv-mono">{a.identifier}</span>
          <span className="text-rv-mute-500">{a.displayName}</span>
        </label>
      );
    })}
  </div>
</Field>
```

> Replace `Field` with whatever the modal currently uses for labelled form fields. If it inlines `<label>` + `<input>`, follow that pattern instead.

- [ ] **Step 3: Update the submit body**

Inside the submit handler (likely a `mutationFn` or onClick), make sure the body shape sent to the API matches `DashboardProductCreateInput` / `DashboardProductUpdateInput`:

```typescript
const body = {
  identifier: form.identifier,
  type: form.type,
  displayName: form.displayName,
  storeIds: form.storeIds,
  accessIds: form.accessIds,
  creditAmount: form.creditAmount,
  isActive: form.isActive,
  metadata: form.metadata,
};
```

- [ ] **Step 4: Typecheck the file**

```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit 2>&1 | grep "product-form-modal" | head
```

Expected: zero. If errors remain, fix in place.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/products/product-form-modal.tsx
git commit -m "feat(dashboard): products form selects access from catalog"
```

---

## Task 7: Update `subscribers/AccessTable.tsx`

**Files:**
- Modify: `apps/dashboard/src/components/subscribers/AccessTable.tsx`

- [ ] **Step 1: Inspect current shape**

Open it. The table currently iterates over a list of `subscriber.access` rows shaped like `{ entitlementKey, isActive, expiresDate, store, purchaseId }`. After Plan 1, the API returns `accessId` instead of `entitlementKey`.

- [ ] **Step 2: Wire the access catalog so we can show display names**

At the top of the file:

```typescript
import { useProjectAccess } from "../../lib/hooks/useProjectAccess";

interface Props {
  projectId: string;
  // existing props
}

export function AccessTable({ projectId, ...rest }: Props) {
  const accessQuery = useProjectAccess(projectId);
  const labelById = useMemo(() => {
    const m = new Map<string, string>();
    for (const r of accessQuery.data?.rows ?? []) m.set(r.id, r.displayName);
    return m;
  }, [accessQuery.data]);
  // …
}
```

Threading `projectId` may require updating the caller (`subscriber-detail-panel.tsx`) — do that here too.

- [ ] **Step 3: Update the column header + row rendering**

Replace `t("subscribers.access.entitlement")` with `t("subscribers.access.access")` (new key — added in Task 14):

```tsx
<th className="py-2 pr-4">{t("subscribers.access.access")}</th>
```

Replace the `entitlementKey` row references:

```tsx
{rows.map((r) => (
  <tr key={`${r.accessId}-${r.purchaseId}`}>
    <td>
      <span className="font-rv-mono">
        {labelById.get(r.accessId) ?? r.accessId}
      </span>
    </td>
    {/* other cells stay */}
  </tr>
))}
```

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit 2>&1 | grep "AccessTable\|entitlementKey" | head
```

Expected: zero.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/subscribers/AccessTable.tsx \
        apps/dashboard/src/components/subscribers/subscriber-detail-panel.tsx
git commit -m "refactor(dashboard): AccessTable resolves accessId to displayName"
```

---

## Task 8: Update `subscribers/subscriber-detail-panel.tsx`

**Files:**
- Modify: `apps/dashboard/src/components/subscribers/subscriber-detail-panel.tsx`

- [ ] **Step 1: Rename the `entitlements` tab → `access`**

Find the `type DetailTab = "activity" | "subs" | "entitlements";` line and change to:

```typescript
type DetailTab = "activity" | "subs" | "access";
```

Update every reference to the string `"entitlements"` in the file — `tab === "entitlements"`, `setTab("entitlements")`, the corresponding `t(...)` call, and the rendering branch `{tab === "entitlements" && (...)}`. All become `"access"`.

Translation keys move from `subscribers.panel.tabs.entitlements` → `subscribers.panel.tabs.access` (added in Task 14).

- [ ] **Step 2: Swap `EntitlementChip` → `AccessChip`**

Find the import line:

```typescript
import { EntitlementChip } from "../products/entitlement-chip";
```

Replace with:

```typescript
import { AccessChip } from "../products/access-chip";
```

In the JSX:

```tsx
<AccessChip>{a.displayName}</AccessChip>
```

(Replacing whatever previously used `<EntitlementChip>{a.entitlementKey}</EntitlementChip>`.)

- [ ] **Step 3: Update the data field name**

`subscriber.entitlements` (the count + array) should become `subscriber.access`. Update where this prop is constructed (likely in the route component / mapper) so the property name matches.

Run:

```bash
grep -rn "subscriber\.entitlements\|subscriber\.access" apps/dashboard/src --include="*.ts" --include="*.tsx"
```

Fix every read site.

- [ ] **Step 4: Typecheck**

```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit 2>&1 | grep "subscriber-detail-panel\|EntitlementChip" | head
```

Expected: zero.

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/subscribers/subscriber-detail-panel.tsx \
        apps/dashboard/src/routes/_authed/projects/\$projectId/subscribers/
git commit -m "refactor(dashboard): subscriber panel access tab + AccessChip"
```

---

## Task 9: Build the access list + form dialog components

**Files:**
- Create: `apps/dashboard/src/components/access/access-list.tsx`
- Create: `apps/dashboard/src/components/access/access-header.tsx`
- Create: `apps/dashboard/src/components/access/access-form-dialog.tsx`
- Create: `apps/dashboard/src/components/access/delete-access-dialog.tsx`
- Create: `apps/dashboard/src/components/access/index.ts`
- Test: `apps/dashboard/src/components/access/__tests__/access-form-dialog.test.tsx`

- [ ] **Step 1: Write the failing form-dialog test**

Create `apps/dashboard/src/components/access/__tests__/access-form-dialog.test.tsx`:

```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi } from "vitest";
import { AccessFormDialog } from "../access-form-dialog";

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("AccessFormDialog", () => {
  it("requires a slug-style identifier", async () => {
    const onSave = vi.fn();
    wrap(
      <AccessFormDialog
        open
        mode="create"
        projectId="p_1"
        onClose={() => undefined}
        onSave={onSave}
      />,
    );
    fireEvent.change(screen.getByLabelText(/identifier/i), {
      target: { value: "Has Spaces!" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    await waitFor(() => {
      expect(
        screen.getByText(/identifier must be slug-like/i),
      ).toBeInTheDocument();
    });
    expect(onSave).not.toHaveBeenCalled();
  });

  it("submits a valid payload", async () => {
    const onSave = vi.fn();
    wrap(
      <AccessFormDialog
        open
        mode="create"
        projectId="p_1"
        onClose={() => undefined}
        onSave={onSave}
      />,
    );
    fireEvent.change(screen.getByLabelText(/identifier/i), {
      target: { value: "premium" },
    });
    fireEvent.change(screen.getByLabelText(/display name/i), {
      target: { value: "Premium" },
    });
    fireEvent.click(screen.getByRole("button", { name: /create/i }));
    await waitFor(() => {
      expect(onSave).toHaveBeenCalledWith({
        identifier: "premium",
        displayName: "Premium",
        description: null,
      });
    });
  });
});
```

Run:

```bash
pnpm --filter @rovenue/dashboard exec vitest run access-form-dialog
```

Expected: FAIL with "Cannot find module '../access-form-dialog'".

- [ ] **Step 2: Implement `access-form-dialog.tsx`**

Create `apps/dashboard/src/components/access/access-form-dialog.tsx`:

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "../../ui/dialog";   // or whatever the project's Dialog is
import { Button } from "../../ui/button";

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/i;

interface CreateInput {
  identifier: string;
  displayName: string;
  description: string | null;
}

interface Props {
  open: boolean;
  mode: "create" | "edit";
  projectId: string;
  initial?: {
    identifier: string;
    displayName: string;
    description: string | null;
  };
  onClose: () => void;
  onSave: (input: CreateInput) => void | Promise<void>;
}

export function AccessFormDialog(props: Props) {
  const { t } = useTranslation();
  const [identifier, setIdentifier] = useState(props.initial?.identifier ?? "");
  const [displayName, setDisplayName] = useState(
    props.initial?.displayName ?? "",
  );
  const [description, setDescription] = useState(
    props.initial?.description ?? "",
  );
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    if (!SLUG_RE.test(identifier)) {
      setError(t("access.form.errors.slug", "identifier must be slug-like"));
      return;
    }
    if (!displayName.trim()) {
      setError(
        t("access.form.errors.displayName", "Display name is required"),
      );
      return;
    }
    void props.onSave({
      identifier: identifier.trim(),
      displayName: displayName.trim(),
      description: description.trim() ? description.trim() : null,
    });
  }

  return (
    <Dialog open={props.open} onClose={props.onClose}>
      <h2 className="text-lg font-semibold mb-3">
        {props.mode === "create"
          ? t("access.form.createTitle", "New access")
          : t("access.form.editTitle", "Edit access")}
      </h2>

      <label className="block text-xs mb-1">
        {t("access.form.identifier.label", "Identifier")}
        <input
          aria-label="identifier"
          className="block w-full mt-1 px-2 py-1 border rounded-sm"
          value={identifier}
          onChange={(e) => setIdentifier(e.target.value)}
        />
      </label>

      <label className="block text-xs mb-1 mt-3">
        {t("access.form.displayName.label", "Display name")}
        <input
          aria-label="display name"
          className="block w-full mt-1 px-2 py-1 border rounded-sm"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </label>

      <label className="block text-xs mb-1 mt-3">
        {t("access.form.description.label", "Description (optional)")}
        <textarea
          className="block w-full mt-1 px-2 py-1 border rounded-sm"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
        />
      </label>

      {error && <p className="text-xs text-red-500 mt-2">{error}</p>}

      <div className="flex justify-end gap-2 mt-4">
        <Button variant="secondary" onClick={props.onClose}>
          {t("common.cancel", "Cancel")}
        </Button>
        <Button onClick={submit}>
          {props.mode === "create"
            ? t("access.form.create", "Create")
            : t("access.form.save", "Save")}
        </Button>
      </div>
    </Dialog>
  );
}
```

Run the test again:

```bash
pnpm --filter @rovenue/dashboard exec vitest run access-form-dialog
```

Expected: PASS.

- [ ] **Step 3: Implement `access-list.tsx`, `access-header.tsx`, `delete-access-dialog.tsx`**

For each, follow the equivalent file in `apps/dashboard/src/components/offerings/` as a template — copy the structure, swap field names. Specifically:

- `access-list.tsx`: a vertical list of access rows with selection state + search filter. Selected row id is hoisted up via `onSelect: (id: string) => void`. Renders `displayName` (primary) + `identifier` (mono, secondary). Empty state CTA: "Create access".
- `access-header.tsx`: shows the selected row's display name + a dropdown actions menu (Edit, Delete). Receives `accessRow: DashboardAccessRow | null`.
- `delete-access-dialog.tsx`: confirmation dialog. On confirm, calls `useDeleteAccess(projectId).mutateAsync(id)`. Catches a 409 from the API and renders an explanatory error: "This access is in use by existing subscriber_access rows. Remove dependent rows first."

- [ ] **Step 4: Barrel export**

Create `apps/dashboard/src/components/access/index.ts`:

```typescript
export { AccessList } from "./access-list";
export { AccessHeader } from "./access-header";
export { AccessFormDialog } from "./access-form-dialog";
export { DeleteAccessDialog } from "./delete-access-dialog";
export { AccessOfferingsSection } from "./access-offerings-section";
```

(`AccessOfferingsSection` is implemented in Task 10.)

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/access/
git commit -m "feat(dashboard): access list + header + form + delete components"
```

---

## Task 10: Build `access-offerings-section.tsx`

**Files:**
- Create: `apps/dashboard/src/components/access/access-offerings-section.tsx`
- Test: `apps/dashboard/src/components/access/__tests__/access-offerings-section.test.tsx`

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard/src/components/access/__tests__/access-offerings-section.test.tsx`:

```tsx
import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi } from "vitest";
import { AccessOfferingsSection } from "../access-offerings-section";

vi.mock("../../../lib/hooks/useProjectOfferings", () => ({
  useOfferingsByAccess: (_p: string, accessId: string | null) => ({
    data: accessId
      ? {
          offerings: [
            { id: "ofr_1", identifier: "default", isDefault: true, accessId },
          ],
        }
      : undefined,
    isLoading: false,
  }),
}));

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

describe("AccessOfferingsSection", () => {
  it("lists offerings scoped to the current access", async () => {
    wrap(<AccessOfferingsSection projectId="p_1" accessId="acs_1" />);
    await waitFor(() => {
      expect(screen.getByText("default")).toBeInTheDocument();
    });
  });

  it("shows empty state when no offerings yet", () => {
    wrap(<AccessOfferingsSection projectId="p_1" accessId={null} />);
    expect(
      screen.getByText(/select an access to see its offerings/i),
    ).toBeInTheDocument();
  });
});
```

Run:

```bash
pnpm --filter @rovenue/dashboard exec vitest run access-offerings-section
```

Expected: FAIL — module not found.

- [ ] **Step 2: Implement the section**

Create `apps/dashboard/src/components/access/access-offerings-section.tsx`:

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { Button } from "../../ui/button";
import { useOfferingsByAccess } from "../../lib/hooks/useProjectOfferings";
import {
  OfferingFormDialog,
  OfferingProductsSection,
} from "../offerings";

interface Props {
  projectId: string;
  accessId: string | null;
}

export function AccessOfferingsSection({ projectId, accessId }: Props) {
  const { t } = useTranslation();
  const offerings = useOfferingsByAccess(projectId, accessId);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedOfferingId, setSelectedOfferingId] = useState<string | null>(
    null,
  );

  if (!accessId) {
    return (
      <div className="text-xs text-rv-mute-500 py-4">
        {t(
          "access.offerings.placeholder",
          "Select an access to see its offerings.",
        )}
      </div>
    );
  }

  const rows = offerings.data?.offerings ?? [];

  return (
    <section className="border-t border-rv-divider mt-6 pt-4">
      <header className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold">
          {t("access.offerings.heading", "Offerings")}
        </h3>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setCreateOpen(true)}
        >
          <Plus className="size-3.5 mr-1" />
          {t("access.offerings.create", "New offering")}
        </Button>
      </header>

      {rows.length === 0 && (
        <p className="text-xs text-rv-mute-500">
          {t(
            "access.offerings.empty",
            "No offerings yet — create one to use this access on a paywall.",
          )}
        </p>
      )}

      <ul className="flex flex-col gap-1">
        {rows.map((o) => (
          <li key={o.id}>
            <button
              className="text-left text-xs px-2 py-1 hover:bg-rv-c4 rounded-sm w-full"
              onClick={() => setSelectedOfferingId(o.id)}
            >
              <span className="font-rv-mono">{o.identifier}</span>
              {o.isDefault && (
                <span className="text-rv-violet ml-2">default</span>
              )}
            </button>
          </li>
        ))}
      </ul>

      {selectedOfferingId && (
        <OfferingProductsSection
          projectId={projectId}
          offeringId={selectedOfferingId}
        />
      )}

      <OfferingFormDialog
        open={createOpen}
        mode="create"
        projectId={projectId}
        initial={{ accessId }}    // pre-fills the new accessId field added in Task 3
        onClose={() => setCreateOpen(false)}
        onSave={() => setCreateOpen(false)}
      />
    </section>
  );
}
```

Re-run the test:

```bash
pnpm --filter @rovenue/dashboard exec vitest run access-offerings-section
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/components/access/access-offerings-section.tsx \
        apps/dashboard/src/components/access/__tests__/access-offerings-section.test.tsx
git commit -m "feat(dashboard): AccessOfferingsSection embeds offerings by access"
```

---

## Task 11: Build the `/access` route

**Files:**
- Create: `apps/dashboard/src/routes/_authed/projects/$projectId/access.tsx`

- [ ] **Step 1: Write the route**

Mirror the structure of `apps/dashboard/src/routes/_authed/projects/$projectId/product-groups.tsx` (about to be deleted in Task 12). Selection is driven by a search param `accessId` so the URL is shareable.

Create `apps/dashboard/src/routes/_authed/projects/$projectId/access.tsx`:

```tsx
import { useMemo, useState } from "react";
import {
  createFileRoute,
  useNavigate,
  useParams,
  useSearch,
} from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Plus } from "lucide-react";
import { Button } from "../../../../ui/button";
import { useProject } from "../../../../lib/hooks/useProject";
import {
  useProjectAccess,
  useCreateAccess,
  useUpdateAccess,
  useDeleteAccess,
} from "../../../../lib/hooks/useProjectAccess";
import {
  AccessFormDialog,
  AccessHeader,
  AccessList,
  AccessOfferingsSection,
  DeleteAccessDialog,
} from "../../../../components/access";

interface Search {
  accessId?: string;
}

export const Route = createFileRoute(
  "/_authed/projects/$projectId/access",
)({
  validateSearch: (s: Record<string, unknown>): Search => ({
    accessId: typeof s.accessId === "string" ? s.accessId : undefined,
  }),
  component: AccessRoute,
});

function AccessRoute() {
  const { projectId } = useParams({ from: "/_authed/projects/$projectId/access" });
  const { data: project } = useProject(projectId);
  if (!project) return null;
  return <AccessPage projectId={projectId} />;
}

function AccessPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate({ from: "/_authed/projects/$projectId/access" });
  const { accessId: selectedId } = useSearch({
    from: "/_authed/projects/$projectId/access",
  });

  const accessQuery = useProjectAccess(projectId);
  const rows = accessQuery.data?.rows ?? [];
  const selected = useMemo(
    () => rows.find((r) => r.id === selectedId) ?? null,
    [rows, selectedId],
  );

  const [createOpen, setCreateOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);

  const create = useCreateAccess(projectId);
  const update = useUpdateAccess(projectId, selected?.id ?? "");
  const remove = useDeleteAccess(projectId);

  function select(id: string | null) {
    void navigate({ search: () => (id ? { accessId: id } : {}) });
  }

  return (
    <div className="grid grid-cols-[260px_1fr] gap-4 h-full">
      <aside className="border-r border-rv-divider pr-3">
        <header className="flex items-center justify-between mb-3">
          <h2 className="text-sm font-semibold">{t("access.title", "Access")}</h2>
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-3.5 mr-1" />
            {t("access.create", "New")}
          </Button>
        </header>
        <AccessList
          rows={rows}
          selectedId={selected?.id ?? null}
          onSelect={select}
        />
      </aside>

      <section>
        <AccessHeader
          accessRow={selected}
          onEdit={() => setEditOpen(true)}
          onDelete={() => setDeleteOpen(true)}
        />

        <AccessOfferingsSection
          projectId={projectId}
          accessId={selected?.id ?? null}
        />
      </section>

      <AccessFormDialog
        open={createOpen}
        mode="create"
        projectId={projectId}
        onClose={() => setCreateOpen(false)}
        onSave={async (body) => {
          const row = await create.mutateAsync(body);
          select(row.id);
          setCreateOpen(false);
        }}
      />

      {selected && (
        <AccessFormDialog
          open={editOpen}
          mode="edit"
          projectId={projectId}
          initial={{
            identifier: selected.identifier,
            displayName: selected.displayName,
            description: selected.description,
          }}
          onClose={() => setEditOpen(false)}
          onSave={async (body) => {
            await update.mutateAsync(body);
            setEditOpen(false);
          }}
        />
      )}

      {selected && (
        <DeleteAccessDialog
          open={deleteOpen}
          accessRow={selected}
          onClose={() => setDeleteOpen(false)}
          onConfirm={async () => {
            await remove.mutateAsync(selected.id);
            select(null);
            setDeleteOpen(false);
          }}
        />
      )}
    </div>
  );
}
```

- [ ] **Step 2: Regenerate the router file tree**

TanStack Router maintains an auto-generated `routeTree.gen.ts`. Touching it manually is fine if the codebase has a dev-time regenerator, but the canonical command is:

```bash
pnpm --filter @rovenue/dashboard dev
```

Let it boot once, exit. The `routeTree.gen.ts` should now include the new route. If the project uses `pnpm exec tsr generate` (TanStack Router CLI) instead, run that. Confirm `routeTree.gen.ts` references `/_authed/projects/$projectId/access`.

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/routes/_authed/projects/\$projectId/access.tsx \
        apps/dashboard/src/routeTree.gen.ts
git commit -m "feat(dashboard): /access route with offerings sub-section"
```

---

## Task 12: Delete `/product-groups` route + update `experiments/new.tsx`

**Files:**
- Delete: `apps/dashboard/src/routes/_authed/projects/$projectId/product-groups.tsx`
- Modify: `apps/dashboard/src/routes/_authed/projects/$projectId/experiments/new.tsx`
- Modify: `apps/dashboard/src/components/experiments/format.ts`
- Modify: `apps/dashboard/src/routeTree.gen.ts` (regen)

- [ ] **Step 1: Delete the old route**

```bash
git rm apps/dashboard/src/routes/_authed/projects/\$projectId/product-groups.tsx
```

- [ ] **Step 2: Rename in `experiments/new.tsx`**

Open `apps/dashboard/src/routes/_authed/projects/$projectId/experiments/new.tsx` and do:

- Replace every `"PRODUCT_GROUP"` string literal with `"OFFERING"`.
- Replace `productGroupId` with `offeringId` (field on the form draft state + variant body + `productGroupsLoading: boolean`).
- Replace `useProjectProductGroups` import → `useProjectOfferings`. Replace `productGroupsQuery.data?.groups` with `offeringsQuery.data?.offerings`. Rename the local `productGroups` array variable to `offerings`.
- Replace label key strings: `experiments.new.types.productGroup` → `experiments.new.types.offering`, `experiments.new.productGroup.noneTitle` → `experiments.new.offering.noneTitle`, `experiments.new.productGroup.createCta` → `experiments.new.offering.createCta`, `experiments.new.errors.productGroupMissing` → `experiments.new.errors.offeringMissing`. (These i18n keys are added in Task 14.)
- Update the `<NoneCta>` link/CTA `to="/projects/$projectId/product-groups"` → `to="/projects/$projectId/access"`.

After the renames, the type/error block at the top of the file should look like:

```typescript
const EXPERIMENT_TYPE_OPTIONS = [
  { value: "FLAG", labelKey: "experiments.new.types.flag" },
  { value: "OFFERING", labelKey: "experiments.new.types.offering" },
  { value: "PAYWALL", labelKey: "experiments.new.types.paywall" },
  { value: "ELEMENT", labelKey: "experiments.new.types.element" },
] as const;
```

…and the variant body for an OFFERING-type experiment now reads `v.offeringId` instead of `v.productGroupId`.

- [ ] **Step 3: Update `experiments/format.ts`**

```typescript
if (t === "OFFERING") return "monetization";
```

(Replaces the `"PRODUCT_GROUP"` literal.)

- [ ] **Step 4: Regenerate routeTree**

```bash
pnpm --filter @rovenue/dashboard dev
```

…then exit once `routeTree.gen.ts` is rewritten. Confirm `product-groups` is gone from it.

- [ ] **Step 5: Typecheck**

```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit 2>&1 | grep -E "PRODUCT_GROUP|productGroup" | head
```

Expected: zero (modulo the out-of-scope chart filter `productGroup` dimension key, which is allowed to remain).

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/routes/_authed/projects/\$projectId/experiments/new.tsx \
        apps/dashboard/src/components/experiments/format.ts \
        apps/dashboard/src/routeTree.gen.ts
git commit -m "refactor(dashboard): drop product-groups route, rename experiments to OFFERING"
```

---

## Task 13: Update navigation

**Files:**
- Modify: `apps/dashboard/src/components/dashboard/navigation.ts`

- [ ] **Step 1: Replace the `groups` nav entry**

Open `navigation.ts`. Find:

```typescript
{
  id: "groups",
  labelKey: "sidebar.items.groups",
  icon: Layers,
  to: "/projects/$projectId/product-groups",
},
```

Replace with:

```typescript
{
  id: "access",
  labelKey: "sidebar.items.access",
  icon: KeyRound,
  to: "/projects/$projectId/access",
},
```

…and add `KeyRound` to the lucide-react import at the top of the file:

```typescript
import {
  // ...existing imports
  KeyRound,
  // ...
} from "lucide-react";
```

> If `KeyRound` isn't available in the project's lucide version, fall back to `Shield`.

- [ ] **Step 2: Typecheck**

```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit 2>&1 | grep navigation | head
```

Expected: zero.

- [ ] **Step 3: Commit**

```bash
git add apps/dashboard/src/components/dashboard/navigation.ts
git commit -m "feat(dashboard): sidebar 'Access' entry replaces 'Groups'"
```

---

## Task 14: i18n string rename pass

**Files:**
- Modify: `apps/dashboard/src/i18n/locales/en.json`

- [ ] **Step 1: Add new `access.*` key block**

Open `en.json` and add a new top-level `"access"` block (next to `"audiences"`, `"cohorts"`, etc.):

```jsonc
"access": {
  "title": "Access",
  "subtitle": "The catalog of access rights subscribers can earn. Products grant access; offerings show which products grant a given access.",
  "create": "New",
  "form": {
    "createTitle": "New access",
    "editTitle": "Edit access",
    "identifier": {
      "label": "Identifier",
      "hint": "Slug shown to the SDK. Lowercase letters, digits, dashes or underscores."
    },
    "displayName": {
      "label": "Display name"
    },
    "description": {
      "label": "Description (optional)"
    },
    "create": "Create access",
    "save": "Save changes",
    "errors": {
      "slug": "Identifier must be slug-like (lowercase letters/digits/_/-)",
      "displayName": "Display name is required",
      "inUse": "This access is in use by existing subscriber_access rows. Remove dependent rows first."
    }
  },
  "offerings": {
    "heading": "Offerings",
    "empty": "No offerings yet — create one to use this access on a paywall.",
    "placeholder": "Select an access to see its offerings.",
    "create": "New offering"
  },
  "list": {
    "empty": "No access defined yet",
    "searchPlaceholder": "Search access…"
  }
}
```

- [ ] **Step 2: Add `sidebar.items.access`**

In the `sidebar.items` block, add:

```jsonc
"access": "Access",
```

(Leave the existing `"groups": "Product groups"` line in place — it's still legal JSON; no code references it after the navigation change.)

- [ ] **Step 3: Rename `productGroups` → `offerings`**

Find the top-level `"productGroups": {` block and rename it to `"offerings": {`. Inside, search-and-replace `productGroups.` references that other strings in the file might cross-link to. Update copy where it says "product group" to "offering". The slot-by-slot diff:

- `productGroups.title` ("Product groups") → `offerings.title` ("Offerings")
- `productGroups.subtitle` rewrite → "Bundles of products you show on a paywall, scoped to one access."
- `productGroups.search.placeholder` "Search groups…" → "Search offerings…"
- `productGroups.search.empty` "No groups match" → "No offerings match"
- `productGroups.empty.title` "No product groups yet" → "No offerings yet"
- `productGroups.empty.body` rewrite → "Create an offering to surface SKUs on a paywall scoped to an access right."
- Every `productGroups.form.*` → `offerings.form.*`; copy keeps similar shape but reads "offering" instead of "product group".
- `productGroups.products.heading` "Products in this group" → `offerings.products.heading` "Products in this offering".
- `linkEntitlement` "Link entitlement…" → `linkAccess` "Link access…"

- [ ] **Step 4: Rename `entitlement*` user-facing strings**

In `subscribers.access.entitlement` (the column header), rename to `subscribers.access.access` and change the copy to "Access". Same for the panel-tab key `subscribers.panel.tabs.entitlements` → `subscribers.panel.tabs.access` with copy "Access".

In product-related strings: `products.detail.entitlements` → `products.detail.access`; copy "Entitlements" → "Access". `products.form.entitlementLabel` → `products.form.accessLabel`; `products.form.entitlementPlaceholder` → `products.form.accessPlaceholder`. `products.form.consumableNoGrants` copy update: "This product grants no access (consumable)."

Search the file for any remaining `entitlement` substring (case-insensitive) and re-judge each one:

```bash
grep -n "entitlement" apps/dashboard/src/i18n/locales/en.json | head -40
```

Update each one to use "access" terminology unless it's a stale key that nothing references.

- [ ] **Step 5: Typecheck (string keys don't move TS, but verify nothing broke)**

```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit 2>&1 | tail -10
```

Manually skim the dashboard for raw key strings still being read:

```bash
grep -rn "subscribers.access.entitlement\|subscribers.panel.tabs.entitlements\|productGroups\." apps/dashboard/src --include="*.ts" --include="*.tsx"
```

Expected: zero hits (every caller was updated in earlier tasks).

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/i18n/locales/en.json
git commit -m "i18n(dashboard): access + offerings copy replaces entitlement + product groups"
```

---

## Task 15: Final sweep + smoke test

**Files:** none directly — verification only.

- [ ] **Step 1: Grep for any leftovers**

```bash
grep -rn "EntitlementChip\|EntitlementList\|entitlementKey\|entitlementKeys\|useProjectProductGroups\|productGroupRepo\|productGroup\b\|PRODUCT_GROUP" \
  apps/dashboard/src \
  --include="*.ts" --include="*.tsx" \
  | grep -v "node_modules" \
  | grep -v "/dist/"
```

Acceptable remaining hits:
- `apps/dashboard/src/components/charts/filters-card.tsx` — `productGroup` chart dimension (out of scope).
- `routeTree.gen.ts` may still mention `product-groups` if step 12 didn't fully regenerate — re-run the dev server once if so.

Anything else: fix in place.

- [ ] **Step 2: Full typecheck**

```bash
pnpm --filter @rovenue/dashboard exec tsc --noEmit
```

Compare against the baseline of pre-existing TanStack Router errors (those are not from this plan). The only NEW errors should be zero.

- [ ] **Step 3: Run the dashboard tests**

```bash
pnpm --filter @rovenue/dashboard test
```

Expected: green (modulo any tests that were already broken before the plan).

- [ ] **Step 4: Smoke test in a browser**

```bash
docker compose up -d
pnpm db:migrate && pnpm db:seed
pnpm --filter @rovenue/api dev &
pnpm --filter @rovenue/dashboard dev
```

In the dashboard, log in, then walk through:

1. Sidebar shows "Access" entry (not "Groups"). Click it.
2. `/projects/<id>/access` loads. Click "New". Create `pro` / "Pro Access". URL updates to `?accessId=<id>`.
3. Right pane shows the new access's header + an empty Offerings section.
4. Click "New offering". The dialog's `accessId` select pre-selects the current access. Create `default` offering, link a product. Save.
5. Navigate to "Products". Click "New product". The form shows checkboxes for `pro` (and any other access rows). Tick it. Save.
6. Navigate to "Subscribers" → open a row. The detail panel's tab now reads "Access" (not "Entitlements"). The Access tab renders chips with the display name.
7. Navigate to "Experiments" → "New". The type selector shows "Offering" (not "Product Group"). Pick it; the variant value selector lists offerings.

Take a screenshot of each step if you want to attach to the PR.

- [ ] **Step 5: Commit any final fixes**

```bash
git status
git add -p
git commit -m "refactor(dashboard): final sweep of access foundation rename"
```

---

## Self-Review Notes

**Spec coverage check** — every item from the parent plan's Plan 3 reference:
- ✅ New `/access` page (replaces `/product-groups`) — Task 11
- ✅ Offerings as sub-section of Access detail — Task 10 (`AccessOfferingsSection`) + Task 11 (route renders it)
- ✅ `entitlement-chip` component rename → `AccessChip`/`AccessList` — Task 2
- ✅ Products toolbar dropdown sourced from access catalog — Task 6 (`product-form-modal.tsx`)
- ✅ Navigation reshuffle (Groups → Access) — Task 13
- ✅ Hook rename (`useProjectProductGroups` → `useProjectOfferings`) — Task 4
- ✅ Components dir rename (`product-groups/` → `offerings/`) — Task 3
- ✅ Experiments builder rename (PRODUCT_GROUP → OFFERING, productGroupId → offeringId) — Task 12
- ✅ Subscribers detail panel + access table — Tasks 7, 8
- ✅ Mappers — Task 5
- ✅ i18n strings — Task 14
- ✅ Final sweep + smoke — Task 15
- ⏭ Chart filter dimension `productGroup` — explicitly out of scope (CH analytics column rename is a separate concern)

**Type consistency:**
- `AccessChipEntry` defined Task 2, used Tasks 5/7. Fields: `{ id, identifier, displayName }`. Consistent.
- `DashboardAccessRow` from `@rovenue/shared` (defined in Plan 1 — Task 7) — used by Tasks 1/9/11. Fields: `{ id, identifier, displayName, description, productCount, metadata, createdAt, updatedAt }`.
- `useOfferingsByAccess(projectId, accessId)` defined Task 4, used Task 10. Signature consistent.
- `OfferingFormDialog` `initial.accessId` defaulting — added in Task 3, consumed in Task 10. Consistent.
- Search param shape `{ accessId?: string }` declared Task 11. Single consumer, no drift.

**Placeholder scan:** no TBD / "Add appropriate" / "Similar to Task N" hand-waves. Where a step says "follow the equivalent file in `offerings/`" (Task 9 Step 3), the template files exist and are listed by name; the engineer has a concrete reference, not a hand-wave.

---

## Next Plans

After this plan lands and merges to main:
- **Plan 2 — SDK Rename** (`2026-05-28-access-sdk-rename.md`, not yet written): Rust core + Swift/Kotlin/RN façades. Public API changes (`useEntitlement` → `useAccess`, `EntitlementInactiveError` → `AccessInactiveError`). Critical to ship before any pod-trunk publish that bumps a minor version.
- **Optional — Chart Dimension Rename** (no plan yet): rename the CH analytics column `productGroupId` → `offeringId` if/when we want the rename to be total, including analytics filters.
