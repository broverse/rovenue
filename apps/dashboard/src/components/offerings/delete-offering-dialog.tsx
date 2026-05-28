import { useEffect, useState } from "react";
import { Dialog } from "@base-ui-components/react/dialog";
import { useTranslation } from "react-i18next";
import { AlertTriangle, X } from "lucide-react";
import { Button } from "../../ui/button";
import { cn } from "../../lib/cn";
import { useDeleteOffering } from "../../lib/hooks/useProjectOfferings";
import { ApiError } from "../../lib/api";
import type { Offering } from "./types";

type Props = {
  projectId: string;
  offering: Offering | null;
  open: boolean;
  onClose: () => void;
  onDeleted?: () => void;
};

export function DeleteOfferingDialog({
  projectId,
  offering,
  open,
  onClose,
  onDeleted,
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
            "fixed left-1/2 top-1/2 z-50 w-[440px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2",
            "rounded-xl border border-rv-divider bg-rv-c1 shadow-[0_30px_80px_rgba(0,0,0,0.45)]",
            "transition-[opacity,transform] duration-200 ease-out",
            "data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
            "data-[ending-style]:-translate-y-[46%] data-[starting-style]:-translate-y-[46%]",
            "focus:outline-none",
          )}
        >
          {open && offering && (
            <Body
              projectId={projectId}
              offering={offering}
              onClose={onClose}
              onDeleted={onDeleted}
            />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function Body({
  projectId,
  offering,
  onClose,
  onDeleted,
}: {
  projectId: string;
  offering: Offering;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const { t } = useTranslation();
  const del = useDeleteOffering(projectId);
  const [confirm, setConfirm] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Reset typed confirmation whenever the dialog re-opens against a new offering.
  useEffect(() => {
    setConfirm("");
    setSubmitError(null);
  }, [offering.id]);

  const matches = confirm.trim() === offering.key;
  const productCount = offering.products.length;

  const onConfirm = async () => {
    if (!matches) return;
    setSubmitError(null);
    try {
      await del.mutateAsync(offering.id);
      onDeleted?.();
      onClose();
    } catch (err) {
      setSubmitError(
        err instanceof ApiError
          ? err.message
          : t(
              "offerings.delete.errors.generic",
              "Could not delete the offering. Please try again.",
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
              {t("offerings.delete.title", "Delete offering")}
            </Dialog.Title>
            <Dialog.Description className="mt-0.5 text-[12px] text-rv-mute-500">
              {t(
                "offerings.delete.subtitle",
                "Permanently remove this offering. Linked products will not be deleted.",
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
          <div className="text-[13px] font-semibold text-foreground">{offering.name}</div>
          <div className="font-rv-mono text-[11px] text-rv-mute-500">{offering.key}</div>
          <div className="mt-1.5 font-rv-mono text-[11px] text-rv-mute-500">
            {t("offerings.delete.productCount", {
              count: productCount,
              defaultValue_one: "{{count}} linked product",
              defaultValue_other: "{{count}} linked products",
            })}
          </div>
        </div>

        {offering.isDefault && (
          <div className="rounded-md border border-rv-warning/30 bg-rv-warning/10 px-3 py-2 text-[12px] text-rv-warning">
            {t(
              "offerings.delete.defaultWarning",
              "This is the default offering. New subscribers without a matching offering will no longer fall back here.",
            )}
          </div>
        )}

        <div>
          <label
            htmlFor="confirm-identifier"
            className="text-[12px] font-medium text-foreground"
          >
            {t("offerings.delete.confirmLabel", {
              defaultValue: "Type {{identifier}} to confirm",
              identifier: offering.key,
            })}
          </label>
          <input
            id="confirm-identifier"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder={offering.key}
            autoComplete="off"
            spellCheck={false}
            className="mt-1.5 w-full rounded-md border border-rv-divider bg-rv-c2 px-3 py-2 font-rv-mono text-[12px] text-foreground transition placeholder:text-rv-mute-500 focus:border-rv-danger focus:outline-none focus:ring-2 focus:ring-rv-danger/30"
          />
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
          disabled={del.isPending}
        >
          {t("common.cancel", "Cancel")}
        </Button>
        <Button
          type="button"
          variant="solid-primary"
          size="sm"
          onClick={onConfirm}
          disabled={!matches || del.isPending}
          className="!bg-rv-danger !text-white hover:!bg-rv-danger/90 focus-visible:!ring-rv-danger"
        >
          {del.isPending
            ? t("offerings.delete.deleting", "Deleting…")
            : t("offerings.delete.confirm", "Delete offering")}
        </Button>
      </footer>
    </>
  );
}
