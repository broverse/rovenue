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
        if (!next && !pending) onClose();
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
