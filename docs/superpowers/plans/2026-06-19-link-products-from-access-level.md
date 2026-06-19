# Link Products from the Access Level Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users link/unlink products to an access level directly from the Access Level page, instead of only from the product drawer.

**Architecture:** Dashboard-only. The product↔access relationship is the `products.accessIds[]` array, mutated through the existing `PATCH /dashboard/projects/{projectId}/products/{id}` endpoint (`useUpdateProduct`). We add a searchable multi-select modal (`LinkProductsModal`) plus a per-row unlink control in the existing "Products that grant it" section. No new API endpoint and no schema/migration changes.

**Tech Stack:** React + TypeScript, TanStack Query, `@base-ui-components/react` Dialog, react-i18next, Vitest + Testing Library, Tailwind (rv-* design tokens).

## Global Constraints

- **No API or schema changes.** Reuse `useUpdateProduct` from `apps/dashboard/src/lib/hooks/useProjectProducts.ts`; cache invalidation is handled by that hook's `onSuccess` (`["products","list",projectId]`).
- **Stay on the current branch.** Do not create or switch branches/worktrees. Commit on the checked-out HEAD.
- **i18n pattern:** This page supplies inline English defaults as the second argument to `t()` and has no `access.*` keys in `en.json`. Follow the same pattern — new strings use `t("key", "Default English")`; do **not** edit `en.json`.
- **Error handling pattern:** Follow the existing inline-error pattern used by the offerings unlink flow in `product-drawer.tsx` (a local `error` state rendered with `role="alert"`). This supersedes the spec's "toast" wording — the dashboard has no shared toast system in this flow.
- **Product source:** The Access page already loads up to 200 products via `useProjectProducts({ projectId, limit: 200 })` and exposes `allProducts`. Pass that array into the modal as a prop (no second fetch). Server-side search / pagination beyond 200 is an out-of-scope follow-up.
- TypeScript strict mode. Match surrounding code style and the rv-* token classes.

**Reference types** (`@rovenue/shared`, `packages/shared/src/dashboard.ts`):
- `DashboardProductRow` = `{ id, identifier, type, displayName, storeIds, accessIds: string[], creditAmount, isActive, metadata, createdAt, updatedAt }`
- `DashboardProductUpdateInput` includes optional `accessIds?: string[]`
- `DashboardAccessRow` has at least `{ id, identifier, displayName, description }`
- `useUpdateProduct(projectId)` returns a mutation whose `mutateAsync` takes `{ id: string } & DashboardProductUpdateInput`.

---

### Task 1: `LinkProductsModal` component

**Files:**
- Create: `apps/dashboard/src/components/access/link-products-modal.tsx`
- Test: `apps/dashboard/src/components/access/__tests__/link-products-modal.test.tsx`

**Interfaces:**
- Consumes: `useUpdateProduct(projectId)` from `../../lib/hooks/useProjectProducts`.
- Produces:
  ```ts
  export function LinkProductsModal(props: {
    open: boolean;
    projectId: string;
    access: DashboardAccessRow | null;
    products: ReadonlyArray<DashboardProductRow>;
    onClose: () => void;
  }): JSX.Element
  ```
  Behavior: pre-checks products whose `accessIds` already include `access.id`; on Save, for each product whose checkbox state differs from its persisted state, calls `update.mutateAsync({ id, accessIds })` with `access.id` added (newly checked) or removed (newly unchecked); unchanged products are not patched.

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard/src/components/access/__tests__/link-products-modal.test.tsx`:

```tsx
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DashboardAccessRow, DashboardProductRow } from "@rovenue/shared";
// initialise i18n so useTranslation() returns real strings in jsdom
import "../../../i18n/config";

const mutateAsync = vi.fn().mockResolvedValue({});
vi.mock("../../../lib/hooks/useProjectProducts", () => ({
  useUpdateProduct: () => ({ mutateAsync }),
}));

import { LinkProductsModal } from "../link-products-modal";

const access = {
  id: "acc_1",
  identifier: "premium",
  displayName: "Premium",
  description: null,
} as unknown as DashboardAccessRow;

function product(over: Partial<DashboardProductRow>): DashboardProductRow {
  return {
    id: "prod",
    identifier: "prod",
    type: "SUBSCRIPTION",
    displayName: "Product",
    storeIds: {},
    accessIds: [],
    creditAmount: null,
    isActive: true,
    metadata: {},
    createdAt: "",
    updatedAt: "",
    ...over,
  } as DashboardProductRow;
}

const A = product({ id: "a", identifier: "alpha", displayName: "Alpha", accessIds: ["acc_1"] });
const B = product({ id: "b", identifier: "beta", displayName: "Beta", accessIds: [] });

function wrap(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>);
}

beforeEach(() => mutateAsync.mockClear());

describe("LinkProductsModal", () => {
  it("pre-checks products already granting the access", () => {
    wrap(
      <LinkProductsModal open projectId="p_1" access={access} products={[A, B]} onClose={() => undefined} />,
    );
    const boxes = screen.getAllByRole("checkbox");
    // filtered order matches products order: [A, B]
    expect(boxes[0]).toHaveAttribute("aria-checked", "true"); // Alpha is linked
    expect(boxes[1]).toHaveAttribute("aria-checked", "false"); // Beta is not
  });

  it("patches only changed products on save (link + unlink)", async () => {
    wrap(
      <LinkProductsModal open projectId="p_1" access={access} products={[A, B]} onClose={() => undefined} />,
    );
    const boxes = screen.getAllByRole("checkbox");
    fireEvent.click(boxes[0]); // uncheck Alpha -> unlink
    fireEvent.click(boxes[1]); // check Beta -> link
    fireEvent.click(screen.getByRole("button", { name: /save/i }));

    await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(2));
    expect(mutateAsync).toHaveBeenCalledWith({ id: "a", accessIds: [] });
    expect(mutateAsync).toHaveBeenCalledWith({ id: "b", accessIds: ["acc_1"] });
  });

  it("removing an access leaves the product's other access ids intact", async () => {
    const C = product({
      id: "c",
      identifier: "gamma",
      displayName: "Gamma",
      accessIds: ["acc_1", "acc_2"],
    });
    wrap(
      <LinkProductsModal open projectId="p_1" access={access} products={[C]} onClose={() => undefined} />,
    );
    fireEvent.click(screen.getAllByRole("checkbox")[0]); // uncheck Gamma -> unlink acc_1 only
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() =>
      expect(mutateAsync).toHaveBeenCalledWith({ id: "c", accessIds: ["acc_2"] }),
    );
  });

  it("does not patch unchanged products", async () => {
    wrap(
      <LinkProductsModal open projectId="p_1" access={access} products={[A, B]} onClose={() => undefined} />,
    );
    // Save without touching anything
    fireEvent.click(screen.getByRole("button", { name: /save/i }));
    await waitFor(() => expect(mutateAsync).not.toHaveBeenCalled());
  });

  it("filters the list by search", () => {
    wrap(
      <LinkProductsModal open projectId="p_1" access={access} products={[A, B]} onClose={() => undefined} />,
    );
    fireEvent.change(screen.getByLabelText(/search products/i), { target: { value: "beta" } });
    expect(screen.getByText("Beta")).toBeInTheDocument();
    expect(screen.queryByText("Alpha")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/access/__tests__/link-products-modal.test.tsx`
Expected: FAIL — cannot resolve `../link-products-modal` (module does not exist yet).

- [ ] **Step 3: Write the component**

Create `apps/dashboard/src/components/access/link-products-modal.tsx`:

```tsx
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@base-ui-components/react/dialog";
import { Box, Check, Search, X } from "lucide-react";
import type { DashboardAccessRow, DashboardProductRow } from "@rovenue/shared";
import { Button } from "../../ui/button";
import { cn } from "../../lib/cn";
import { useUpdateProduct } from "../../lib/hooks/useProjectProducts";

type Props = {
  open: boolean;
  projectId: string;
  access: DashboardAccessRow | null;
  products: ReadonlyArray<DashboardProductRow>;
  onClose: () => void;
};

/**
 * Searchable multi-select for choosing which products grant a given access
 * level. Pre-checks the products already linked, and on save patches only the
 * rows whose checkbox changed — adding or removing `access.id` from each
 * product's `accessIds`. The product↔access relationship lives entirely on
 * `products.accessIds[]`, so this is the same mutation the product drawer uses.
 */
export function LinkProductsModal({ open, projectId, access, products, onClose }: Props) {
  const { t } = useTranslation();
  const update = useUpdateProduct(projectId);

  const [query, setQuery] = useState("");
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Re-seed local state each time the modal opens for an access row.
  useEffect(() => {
    if (!open || !access) return;
    setQuery("");
    setError(null);
    setChecked(
      new Set(products.filter((p) => p.accessIds.includes(access.id)).map((p) => p.id)),
    );
  }, [open, access, products]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return products;
    return products.filter(
      (p) =>
        p.displayName.toLowerCase().includes(q) || p.identifier.toLowerCase().includes(q),
    );
  }, [products, query]);

  const toggle = (id: string) =>
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const confirm = async () => {
    if (!access) return;
    setPending(true);
    setError(null);
    try {
      const changed = products.filter(
        (p) => p.accessIds.includes(access.id) !== checked.has(p.id),
      );
      await Promise.all(
        changed.map((p) => {
          const accessIds = checked.has(p.id)
            ? [...p.accessIds, access.id]
            : p.accessIds.filter((id) => id !== access.id);
          return update.mutateAsync({ id: p.id, accessIds });
        }),
      );
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/40 backdrop-blur-[2px] transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          className={cn(
            "fixed left-1/2 top-1/2 z-[60] flex max-h-[calc(100vh-64px)] w-[460px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col",
            "rounded-xl border border-rv-divider bg-rv-c1 shadow-[0_30px_80px_rgba(0,0,0,0.45)]",
            "transition-[opacity,transform] duration-200 ease-out",
            "data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
            "focus:outline-none",
          )}
        >
          <header className="flex items-start justify-between border-b border-rv-divider px-5 pb-3 pt-4">
            <div>
              <Dialog.Title className="text-[15px] font-semibold leading-5">
                {t("access.linkProducts.title", "Link products")}
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-[12px] text-rv-mute-500">
                {access
                  ? t("access.linkProducts.subtitle", {
                      defaultValue: "Pick the products that grant {{name}}.",
                      name: access.displayName,
                    })
                  : null}
              </Dialog.Description>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("common.close", "Close")}
              className="-mr-1 -mt-1 rounded-md p-1 text-rv-mute-500 transition hover:bg-rv-c2 hover:text-foreground"
            >
              <X size={14} />
            </button>
          </header>

          <div className="border-b border-rv-divider px-5 py-3">
            <div className="flex items-center gap-2 rounded-md border border-rv-divider bg-rv-c2 px-2.5 py-1.5">
              <Search size={13} className="text-rv-mute-500" />
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t("access.linkProducts.search", "Search products…")}
                aria-label={t("access.linkProducts.search", "Search products…")}
                className="w-full bg-transparent text-[13px] text-foreground outline-none placeholder:text-rv-mute-500"
              />
            </div>
          </div>

          <div className="flex-1 overflow-y-auto px-3 py-2 [scrollbar-color:var(--color-rv-c4)_transparent] [scrollbar-width:thin]">
            {filtered.length === 0 ? (
              <p className="px-2 py-6 text-center text-[12.5px] text-rv-mute-500">
                {t("access.linkProducts.noProducts", "No products match.")}
              </p>
            ) : (
              <ul className="m-0 list-none p-0">
                {filtered.map((p) => {
                  const isChecked = checked.has(p.id);
                  return (
                    <li key={p.id}>
                      <button
                        type="button"
                        role="checkbox"
                        aria-checked={isChecked}
                        onClick={() => toggle(p.id)}
                        className="flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition hover:bg-rv-c2"
                      >
                        <span
                          className={cn(
                            "grid size-4 shrink-0 place-items-center rounded border",
                            isChecked
                              ? "border-rv-accent-500 bg-rv-accent-500 text-white"
                              : "border-rv-divider-strong",
                          )}
                        >
                          {isChecked && <Check size={11} />}
                        </span>
                        <span className="grid size-7 shrink-0 place-items-center rounded border border-rv-divider bg-rv-c3 text-rv-mute-600">
                          <Box size={13} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-[13px] font-medium text-foreground">
                            {p.displayName}
                          </span>
                          <span className="block truncate font-rv-mono text-[11px] text-rv-mute-500">
                            {p.identifier}
                          </span>
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>

          {error && (
            <p className="px-5 pb-1 text-[11px] text-rv-danger" role="alert">
              {error}
            </p>
          )}

          <footer className="flex items-center justify-end gap-2 border-t border-rv-divider px-5 py-3">
            <Button type="button" variant="flat" size="sm" onClick={onClose} disabled={pending}>
              {t("common.cancel", "Cancel")}
            </Button>
            <Button
              type="button"
              variant="solid-primary"
              size="sm"
              onClick={() => void confirm()}
              disabled={pending}
            >
              {pending
                ? t("access.linkProducts.saving", "Saving…")
                : t("access.linkProducts.save", "Save")}
            </Button>
          </footer>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/access/__tests__/link-products-modal.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/access/link-products-modal.tsx apps/dashboard/src/components/access/__tests__/link-products-modal.test.tsx
git commit -m "feat(dashboard/access): add LinkProductsModal for managing granting products"
```

---

### Task 2: Link + unlink affordances in `AccessDetail`

**Files:**
- Modify: `apps/dashboard/src/components/access/access-detail.tsx` (props on `AccessDetail`, `GrantingProducts`, `ProductRow`)
- Test: `apps/dashboard/src/components/access/__tests__/access-detail.test.tsx` (create)

**Interfaces:**
- Consumes: nothing new.
- Produces: `AccessDetail` gains two required props:
  ```ts
  onLinkProducts: () => void;
  onUnlinkProduct: (product: DashboardProductRow) => void;
  ```
  `GrantingProducts` renders a "Link products" button (header + empty state) wired to `onLinkProducts`, and each `ProductRow` gets an unlink (×) button wired to `onUnlinkProduct(product)`.

- [ ] **Step 1: Write the failing test**

Create `apps/dashboard/src/components/access/__tests__/access-detail.test.tsx`:

```tsx
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import type { DashboardAccessRow, DashboardProductRow } from "@rovenue/shared";
import "../../../i18n/config";
import { AccessDetail } from "../access-detail";

const access = {
  id: "acc_1",
  identifier: "premium",
  displayName: "Premium",
  description: null,
} as unknown as DashboardAccessRow;

const prod = {
  id: "a",
  identifier: "alpha",
  type: "SUBSCRIPTION",
  displayName: "Alpha",
  storeIds: {},
  accessIds: ["acc_1"],
  creditAmount: null,
  isActive: true,
  metadata: {},
  createdAt: "",
  updatedAt: "",
} as DashboardProductRow;

function renderDetail(over: Partial<React.ComponentProps<typeof AccessDetail>> = {}) {
  const props = {
    accessRow: access,
    grantingProducts: [prod],
    hasAnyAccess: true,
    onEdit: vi.fn(),
    onDelete: vi.fn(),
    onCreate: vi.fn(),
    onLinkProducts: vi.fn(),
    onUnlinkProduct: vi.fn(),
    ...over,
  };
  render(<AccessDetail {...props} />);
  return props;
}

describe("AccessDetail granting products", () => {
  it("fires onLinkProducts when the link button is clicked", () => {
    const props = renderDetail();
    fireEvent.click(screen.getByRole("button", { name: /link products/i }));
    expect(props.onLinkProducts).toHaveBeenCalledTimes(1);
  });

  it("fires onUnlinkProduct with the product when its unlink button is clicked", () => {
    const props = renderDetail();
    fireEvent.click(screen.getByRole("button", { name: /unlink alpha/i }));
    expect(props.onUnlinkProduct).toHaveBeenCalledWith(prod);
  });

  it("shows the link button even when no products grant the access", () => {
    const props = renderDetail({ grantingProducts: [] });
    fireEvent.click(screen.getByRole("button", { name: /link products/i }));
    expect(props.onLinkProducts).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/access/__tests__/access-detail.test.tsx`
Expected: FAIL — `AccessDetail` has no `onLinkProducts`/`onUnlinkProduct`, and there is no "Link products" / "unlink" button.

- [ ] **Step 3: Update `access-detail.tsx`**

3a. Add `Plus` and `X` to the lucide import (line 3–13). The import already includes `Plus`; add `X`:

```tsx
import {
  ArrowRight,
  Box,
  Check,
  Copy,
  KeyRound,
  Package,
  Plus,
  ShieldCheck,
  Sparkles,
  X,
} from "lucide-react";
```

3b. Extend the `Props` type (lines 21–29) with the two callbacks:

```tsx
type Props = {
  accessRow: DashboardAccessRow | null;
  grantingProducts: ReadonlyArray<DashboardProductRow>;
  /** Whether the project has any access rows at all (drives empty copy). */
  hasAnyAccess: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onCreate: () => void;
  onLinkProducts: () => void;
  onUnlinkProduct: (product: DashboardProductRow) => void;
};
```

3c. Destructure and thread them through `AccessDetail` (lines 45–70). Replace the function signature and the `<GrantingProducts .../>` call:

```tsx
export function AccessDetail({
  accessRow,
  grantingProducts,
  hasAnyAccess,
  onEdit,
  onDelete,
  onCreate,
  onLinkProducts,
  onUnlinkProduct,
}: Props) {
  if (!accessRow) {
    return <ConceptEmptyState hasAnyAccess={hasAnyAccess} onCreate={onCreate} />;
  }

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <AccessHeader
        accessRow={accessRow}
        grantingCount={grantingProducts.length}
        onEdit={onEdit}
        onDelete={onDelete}
      />

      <HowItWorks accessRow={accessRow} />

      <GrantingProducts
        products={grantingProducts}
        onLinkProducts={onLinkProducts}
        onUnlinkProduct={onUnlinkProduct}
      />
    </div>
  );
}
```

3d. Replace the entire `GrantingProducts` function (lines 154–199) with a version that takes the callbacks, shows a "Link products" button in the header and the empty state, and renders unlinkable rows:

```tsx
function GrantingProducts({
  products,
  onLinkProducts,
  onUnlinkProduct,
}: {
  products: ReadonlyArray<DashboardProductRow>;
  onLinkProducts: () => void;
  onUnlinkProduct: (product: DashboardProductRow) => void;
}) {
  const { t } = useTranslation();

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 p-4">
      <div className="flex items-center gap-2">
        <Package size={14} className="text-rv-mute-600" />
        <h3 className="text-[13px] font-semibold">
          {t("access.grantingProducts.heading", "Products that grant it")}
        </h3>
        {products.length > 0 && (
          <span className="font-rv-mono text-[11px] text-rv-mute-500">
            {products.length}
          </span>
        )}
        <div className="ml-auto">
          <Button variant="flat" size="sm" className="h-7" onClick={onLinkProducts}>
            <Plus size={12} />
            {t("access.grantingProducts.link", "Link products")}
          </Button>
        </div>
      </div>

      {products.length === 0 ? (
        <div className="mt-3 rounded-md border border-dashed border-rv-divider bg-rv-c2/30 px-3 py-5 text-center">
          <p className="text-[12.5px] text-rv-mute-600">
            {t(
              "access.grantingProducts.empty",
              "No product grants this access yet.",
            )}
          </p>
          <p className="mt-1 text-[11.5px] text-rv-mute-500">
            {t(
              "access.grantingProducts.emptyHint",
              "Link a product so its purchases unlock this access.",
            )}
          </p>
        </div>
      ) : (
        <ul className="mt-3 flex flex-col gap-1.5">
          {products.map((p) => (
            <ProductRow key={p.id} product={p} onUnlink={() => onUnlinkProduct(p)} />
          ))}
        </ul>
      )}
    </section>
  );
}
```

3e. Replace the `ProductRow` function (lines 201–233) so it accepts `onUnlink` and renders an unlink button. Note the `aria-label` includes the product name so the test can target it:

```tsx
function ProductRow({
  product,
  onUnlink,
}: {
  product: DashboardProductRow;
  onUnlink: () => void;
}) {
  const { t } = useTranslation();
  const stores = STORE_KEYS.filter((s) => Boolean(product.storeIds?.[s]));
  const typeLabel = TYPE_LABEL[product.type] ?? product.type;

  return (
    <li className="flex items-center gap-3 rounded-md border border-rv-divider bg-rv-c2/40 px-3 py-2.5 transition hover:border-rv-divider-strong hover:bg-rv-c2/70">
      <div className="grid size-7 shrink-0 place-items-center rounded border border-rv-divider bg-rv-c3 text-rv-mute-600">
        <Box size={13} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13px] font-medium text-foreground">
            {product.displayName}
          </span>
          <span
            className={cn(
              "shrink-0 rounded-[4px] px-1.5 py-0.5 font-rv-mono text-[9.5px] uppercase tracking-wide",
              product.type === "SUBSCRIPTION"
                ? "bg-rv-accent-500/12 text-rv-accent-500"
                : "bg-rv-c4 text-rv-mute-600",
            )}
          >
            {typeLabel}
          </span>
        </div>
        <div className="truncate font-rv-mono text-[11px] text-rv-mute-500">
          {product.identifier}
        </div>
      </div>
      {stores.length > 0 && <StoreBadges stores={stores} size="sm" />}
      <button
        type="button"
        onClick={onUnlink}
        aria-label={t("access.grantingProducts.unlink", {
          defaultValue: "Unlink {{name}}",
          name: product.displayName,
        })}
        title={t("access.grantingProducts.unlink", {
          defaultValue: "Unlink {{name}}",
          name: product.displayName,
        })}
        className="rounded-md p-1 text-rv-mute-500 transition hover:bg-rv-c2 hover:text-rv-danger"
      >
        <X size={13} />
      </button>
    </li>
  );
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @rovenue/dashboard exec vitest run src/components/access/__tests__/access-detail.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/dashboard/src/components/access/access-detail.tsx apps/dashboard/src/components/access/__tests__/access-detail.test.tsx
git commit -m "feat(dashboard/access): add link + per-row unlink controls to granting products"
```

---

### Task 3: Wire the modal and mutations into the Access page

**Files:**
- Modify: `apps/dashboard/src/components/access/index.ts` (export `LinkProductsModal`)
- Modify: `apps/dashboard/src/routes/_authed/projects/$projectId/access.tsx`

**Interfaces:**
- Consumes: `LinkProductsModal` (Task 1); `AccessDetail` new props (Task 2); `useUpdateProduct` (existing).
- Produces: end-user-visible feature — opening the modal from the page and per-row unlink both persist via `PATCH /products/{id}` and refresh the list.

- [ ] **Step 1: Export the modal from the access barrel**

Edit `apps/dashboard/src/components/access/index.ts` — add the line:

```ts
export { LinkProductsModal } from "./link-products-modal";
```

- [ ] **Step 2: Wire into `access.tsx`**

2a. Add `useUpdateProduct` to the products-hook import (line 12):

```tsx
import {
  useProjectProducts,
  useUpdateProduct,
} from "../../../../lib/hooks/useProjectProducts";
```

2b. Add `LinkProductsModal` to the access-components import (lines 13–18):

```tsx
import {
  AccessDetail,
  AccessFormDialog,
  AccessList,
  DeleteAccessDialog,
  LinkProductsModal,
} from "../../../../components/access";
```

2c. Add modal state + the product update mutation inside `AccessPage`, next to the existing `useState`/mutation declarations (after line 71):

```tsx
  const [linkOpen, setLinkOpen] = useState(false);
  const updateProduct = useUpdateProduct(projectId);

  async function unlinkProduct(product: DashboardProductRow) {
    if (!selected) return;
    await updateProduct.mutateAsync({
      id: product.id,
      accessIds: product.accessIds.filter((id) => id !== selected.id),
    });
  }
```

Add the `DashboardProductRow` type import at the top of the file:

```tsx
import type { DashboardProductRow } from "@rovenue/shared";
```

2d. Pass the new props to `<AccessDetail>` (lines 119–126):

```tsx
        <AccessDetail
          accessRow={selected}
          grantingProducts={grantingProducts}
          hasAnyAccess={rows.length > 0}
          onEdit={() => setEditOpen(true)}
          onDelete={() => setDeleteOpen(true)}
          onCreate={() => setCreateOpen(true)}
          onLinkProducts={() => setLinkOpen(true)}
          onUnlinkProduct={(product) => void unlinkProduct(product)}
        />
```

2e. Render the modal alongside the other dialogs (after the `<DeleteAccessDialog .../>` block, before the closing `</>` at line 166):

```tsx
      <LinkProductsModal
        open={linkOpen}
        projectId={projectId}
        access={selected}
        products={allProducts}
        onClose={() => setLinkOpen(false)}
      />
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @rovenue/dashboard exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Run the full dashboard test suite**

Run: `pnpm --filter @rovenue/dashboard test`
Expected: PASS, including the two new test files.

- [ ] **Step 5: Manual verification**

Run: `pnpm --filter @rovenue/dashboard dev`, open a project's **Access** page, select an access level, then:
- Click **Link products** → modal lists products, already-linked ones pre-checked.
- Toggle a few, **Save** → the "Products that grant it" list updates to match; reopening the modal reflects the saved state.
- Click a product row's **×** → it disappears from the granting list.
- Confirm the product drawer's existing access linking still reflects the same state (open one of the toggled products).

Expected: all behaviors work; no console errors.

- [ ] **Step 6: Commit**

```bash
git add apps/dashboard/src/components/access/index.ts apps/dashboard/src/routes/_authed/projects/$projectId/access.tsx
git commit -m "feat(dashboard/access): link products from the access level page"
```

---

## Notes for the implementer

- The modal owns no fetching — it renders the `products` array the page already loaded (`allProducts`, `limit: 200`). If a project exceeds 200 products, only the first 200 appear; replacing the client-side list with a server-side `?search=` query is the documented out-of-scope follow-up.
- Cache invalidation is automatic: `useUpdateProduct.onSuccess` invalidates `["products","list",projectId]`, which is the exact query the Access page reads, so `grantingProducts` re-derives after both the modal save and per-row unlink.
- Keep the `aria-checked` and `role="checkbox"` attributes on the modal rows and the name-bearing `aria-label` on the unlink button — the tests target them.
