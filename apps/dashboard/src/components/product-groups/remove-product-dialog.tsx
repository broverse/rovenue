import { useEffect, useState } from "react";
import { Dialog } from "@base-ui-components/react/dialog";
import { useTranslation } from "react-i18next";
import { AlertTriangle, X } from "lucide-react";
import { Button } from "../../ui/button";
import { cn } from "../../lib/cn";
import { useUpdateProductGroup } from "../../lib/hooks/useProjectProductGroups";
import { ApiError } from "../../lib/api";
import type { GroupProduct, ProductGroup } from "./types";

type Props = {
  projectId: string;
  group: ProductGroup;
  product: GroupProduct | null;
  open: boolean;
  onClose: () => void;
};

/**
 * Confirm modal for unlinking a single product from a group. The product
 * itself stays in the catalog — only the membership row is removed.
 */
export function RemoveProductDialog({
  projectId,
  group,
  product,
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
            "fixed left-1/2 top-1/2 z-50 w-[420px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2",
            "rounded-xl border border-rv-divider bg-rv-c1 shadow-[0_30px_80px_rgba(0,0,0,0.45)]",
            "transition-[opacity,transform] duration-200 ease-out",
            "data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
            "data-[ending-style]:-translate-y-[46%] data-[starting-style]:-translate-y-[46%]",
            "focus:outline-none",
          )}
        >
          {open && product && (
            <Body
              projectId={projectId}
              group={group}
              product={product}
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
  product,
  onClose,
}: {
  projectId: string;
  group: ProductGroup;
  product: GroupProduct;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const update = useUpdateProductGroup(projectId);
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Drop the stale error whenever the dialog re-opens against a different
  // product (e.g. user removed one, then the dialog reopens for another).
  useEffect(() => {
    setSubmitError(null);
  }, [product.id]);

  const onConfirm = async () => {
    setSubmitError(null);
    const next = group.products
      .filter((p) => p.id !== product.id)
      .map((p, index) => ({
        productId: p.id,
        order: index,
        isPromoted: false,
      }));
    try {
      await update.mutateAsync({ id: group.id, products: next });
      onClose();
    } catch (err) {
      setSubmitError(
        err instanceof ApiError
          ? err.message
          : t(
              "productGroups.removeProduct.errors.generic",
              "Could not remove the product. Please try again.",
            ),
      );
    }
  };

  return (
    <>
      <header className="flex items-start justify-between border-b border-rv-divider px-5 pb-3 pt-4">
        <div className="flex items-start gap-3">
          <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-rv-danger/30 bg-rv-danger/10 text-rv-danger">
            <AlertTriangle size={16} />
          </div>
          <div>
            <Dialog.Title className="text-[15px] font-semibold leading-5">
              {t("productGroups.removeProduct.title", "Remove product from group?")}
            </Dialog.Title>
            <Dialog.Description className="mt-0.5 text-[12px] text-rv-mute-500">
              {t(
                "productGroups.removeProduct.subtitle",
                "The product stays in your catalog. Existing subscribers keep their access; new buyers won't enter this group.",
              )}
            </Dialog.Description>
          </div>
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

      <div className="flex flex-col gap-3 px-5 py-4">
        <div className="rounded-md border border-rv-divider bg-rv-c2 px-3 py-2.5">
          <div className="text-[13px] font-semibold text-foreground">{product.name}</div>
          <div className="font-rv-mono text-[11px] text-rv-mute-500">{product.sku}</div>
        </div>

        <div className="font-rv-mono text-[11px] text-rv-mute-500">
          {t("productGroups.removeProduct.from", {
            defaultValue: "From {{name}}",
            name: group.name,
          })}
        </div>

        {submitError && (
          <div className="rounded-md border border-rv-danger/30 bg-rv-danger/10 px-3 py-2 text-[12px] text-rv-danger">
            {submitError}
          </div>
        )}
      </div>

      <footer className="flex items-center justify-end gap-2 border-t border-rv-divider px-5 py-3">
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
          onClick={onConfirm}
          disabled={update.isPending}
          className="!bg-rv-danger !text-white hover:!bg-rv-danger/90 focus-visible:!ring-rv-danger"
        >
          {update.isPending
            ? t("productGroups.removeProduct.removing", "Removing…")
            : t("productGroups.removeProduct.confirm", "Remove product")}
        </Button>
      </footer>
    </>
  );
}
