import { useEffect, useMemo, useState } from "react";
import { Dialog } from "@base-ui-components/react/dialog";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { DashboardProductRow } from "@rovenue/shared";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { SearchInput } from "../../ui/search-input";
import { cn } from "../../lib/cn";
import { useUpdateProductGroup } from "../../lib/hooks/useProjectProductGroups";
import { ApiError } from "../../lib/api";
import type { ProductGroup } from "./types";

type Props = {
  projectId: string;
  group: ProductGroup | null;
  /** All project products, already loaded by the parent route. */
  allProducts: ReadonlyArray<DashboardProductRow>;
  open: boolean;
  onClose: () => void;
};

export function LinkProductsDialog({
  projectId,
  group,
  allProducts,
  open,
  onClose,
}: Props) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex max-h-[calc(100vh-64px)] w-[520px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col",
            "overflow-hidden rounded-xl border border-rv-divider bg-rv-c1 shadow-[0_30px_80px_rgba(0,0,0,0.45)]",
            "transition-[opacity,transform] duration-200 ease-out",
            "data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
            "data-[ending-style]:-translate-y-[46%] data-[starting-style]:-translate-y-[46%]",
            "focus:outline-none",
          )}
        >
          {open && group && (
            <Body
              projectId={projectId}
              group={group}
              allProducts={allProducts}
              onClose={onClose}
            />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Body({
  projectId,
  group,
  allProducts,
  onClose,
}: {
  projectId: string;
  group: ProductGroup;
  allProducts: ReadonlyArray<DashboardProductRow>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const update = useUpdateProductGroup(projectId);
  const [search, setSearch] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Reset selection whenever the picker opens against a different group.
  useEffect(() => {
    setSelectedIds(new Set());
    setSearch("");
    setSubmitError(null);
  }, [group.id]);

  const memberIds = useMemo(() => {
    const s = new Set<string>();
    for (const p of group.products) s.add(p.id);
    return s;
  }, [group.products]);

  const candidates = useMemo(() => {
    const q = search.trim().toLowerCase();
    return allProducts.filter((row) => {
      if (memberIds.has(row.id)) return false;
      if (!row.isActive) return false;
      if (!q) return true;
      return (
        row.identifier.toLowerCase().includes(q) ||
        row.displayName.toLowerCase().includes(q)
      );
    });
  }, [allProducts, memberIds, search]);

  const toggle = (id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const onSubmit = async () => {
    if (selectedIds.size === 0) return;
    setSubmitError(null);
    const existing = group.products.map((p, index) => ({
      productId: p.id,
      order: index,
      isPromoted: false,
    }));
    const toAdd = Array.from(selectedIds).map((productId, index) => ({
      productId,
      order: existing.length + index,
      isPromoted: false,
    }));
    try {
      await update.mutateAsync({
        id: group.id,
        products: [...existing, ...toAdd],
      });
      onClose();
    } catch (err) {
      setSubmitError(
        err instanceof ApiError
          ? err.message
          : t(
              "productGroups.linkProducts.errors.generic",
              "Could not link the selected products. Please try again.",
            ),
      );
    }
  };

  return (
    <>
      <header className="flex items-start justify-between border-b border-rv-divider px-5 pb-3 pt-4">
        <div>
          <Dialog.Title className="text-[15px] font-semibold leading-5">
            {t("productGroups.linkProducts.title", "Link products")}
          </Dialog.Title>
          <Dialog.Description className="mt-0.5 text-[12px] text-rv-mute-500">
            {t("productGroups.linkProducts.subtitle", {
              defaultValue: "Add products to {{name}}.",
              name: group.name,
            })}
          </Dialog.Description>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close", "Close")}
          className="-mr-1 -mt-1 rounded-md p-1 text-rv-mute-500 transition hover:bg-rv-c2 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-rv-accent-500"
        >
          <X size={14} />
        </button>
      </header>

      <div className="border-b border-rv-divider px-5 py-2.5">
        <SearchInput
          value={search}
          onValueChange={setSearch}
          placeholder={t(
            "productGroups.linkProducts.search",
            "Search products…",
          )}
          size="sm"
        />
      </div>

      <div className="min-h-[200px] flex-1 overflow-y-auto">
        {candidates.length === 0 ? (
          <div className="flex h-full min-h-[200px] flex-col items-center justify-center px-6 py-10 text-center">
            <div className="text-[13px] font-semibold">
              {memberIds.size === allProducts.length
                ? t(
                    "productGroups.linkProducts.empty.allLinked",
                    "All products are already in this group",
                  )
                : t(
                    "productGroups.linkProducts.empty.none",
                    "No products match",
                  )}
            </div>
            <p className="mt-1 max-w-[320px] text-[12px] text-rv-mute-500">
              {t(
                "productGroups.linkProducts.empty.hint",
                "Inactive products are hidden. Create a product in the catalog first.",
              )}
            </p>
          </div>
        ) : (
          <ul>
            {candidates.map((row) => {
              const checked = selectedIds.has(row.id);
              return (
                <li key={row.id}>
                  <label
                    className={cn(
                      "flex cursor-pointer items-center gap-3 border-b border-rv-divider px-5 py-2.5 transition hover:bg-rv-c2",
                      checked && "bg-rv-accent-500/5",
                    )}
                  >
                    <Checkbox
                      checked={checked}
                      onChange={() => toggle(row.id)}
                      ariaLabel={row.displayName || row.identifier}
                    />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium text-foreground">
                        {row.displayName || row.identifier}
                      </div>
                      <div className="truncate font-rv-mono text-[11px] text-rv-mute-500">
                        {row.identifier}
                      </div>
                    </div>
                    <ProductTypeChip type={row.type} />
                  </label>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {submitError && (
        <div className="border-t border-rv-divider px-5 py-2 text-[12px] text-rv-danger">
          {submitError}
        </div>
      )}

      <footer className="flex items-center justify-between gap-2 border-t border-rv-divider px-5 py-3">
        <div className="font-rv-mono text-[11px] text-rv-mute-500">
          {t("productGroups.linkProducts.counter", {
            defaultValue: "{{count}} selected",
            count: selectedIds.size,
          })}
        </div>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="flat"
            size="sm"
            onClick={onClose}
            disabled={update.isPending}
          >
            {t("common.cancel", "Cancel")}
          </Button>
          <Button
            type="button"
            variant="solid-primary"
            size="sm"
            onClick={onSubmit}
            disabled={selectedIds.size === 0 || update.isPending}
          >
            {update.isPending
              ? t("productGroups.linkProducts.submitting", "Linking…")
              : t("productGroups.linkProducts.submit", "Link selected")}
          </Button>
        </div>
      </footer>
    </>
  );
}

function ProductTypeChip({ type }: { type: DashboardProductRow["type"] }) {
  const { t } = useTranslation();
  const label =
    type === "SUBSCRIPTION"
      ? t("productGroups.linkProducts.type.subscription", "Subscription")
      : type === "CONSUMABLE"
        ? t("productGroups.linkProducts.type.consumable", "Consumable")
        : t("productGroups.linkProducts.type.nonConsumable", "Lifetime");
  return (
    <span className="shrink-0 rounded-full border border-rv-divider bg-rv-c2 px-2 py-0.5 font-rv-mono text-[10px] uppercase tracking-wider text-rv-mute-500">
      {label}
    </span>
  );
}
