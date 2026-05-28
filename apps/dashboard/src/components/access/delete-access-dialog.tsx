import { useEffect, useState } from "react";
import { Dialog } from "@base-ui-components/react/dialog";
import { useTranslation } from "react-i18next";
import { AlertTriangle, X } from "lucide-react";
import type { DashboardAccessRow } from "@rovenue/shared";
import { Button } from "../../ui/button";
import { cn } from "../../lib/cn";
import { useDeleteAccess } from "../../lib/hooks/useProjectAccess";
import { ApiError } from "../../lib/api";

type Props = {
  projectId: string;
  accessRow: DashboardAccessRow | null;
  open: boolean;
  onClose: () => void;
  onDeleted?: () => void;
};

/**
 * Confirmation dialog for deleting an access row. Requires typing
 * the identifier as a guard. A 409 from the API (the row is still
 * referenced by `subscriber_access`) renders a specific explanatory
 * error instead of the generic message.
 */
export function DeleteAccessDialog({
  projectId,
  accessRow,
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
          {open && accessRow && (
            <Body
              projectId={projectId}
              accessRow={accessRow}
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
  accessRow,
  onClose,
  onDeleted,
}: {
  projectId: string;
  accessRow: DashboardAccessRow;
  onClose: () => void;
  onDeleted?: () => void;
}) {
  const { t } = useTranslation();
  const del = useDeleteAccess(projectId);
  const [confirm, setConfirm] = useState("");
  const [submitError, setSubmitError] = useState<string | null>(null);

  // Reset typed confirmation whenever the dialog re-opens against a new row.
  useEffect(() => {
    setConfirm("");
    setSubmitError(null);
  }, [accessRow.id]);

  const matches = confirm.trim() === accessRow.identifier;

  const onConfirm = async () => {
    if (!matches) return;
    setSubmitError(null);
    try {
      await del.mutateAsync(accessRow.id);
      onDeleted?.();
      onClose();
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setSubmitError(
          t(
            "access.delete.errors.inUse",
            "This access is in use by existing subscriber_access rows. Remove dependent rows first.",
          ),
        );
        return;
      }
      setSubmitError(
        err instanceof ApiError
          ? err.message
          : t(
              "access.delete.errors.generic",
              "Could not delete the access. Please try again.",
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
              {t("access.delete.title", "Delete access")}
            </Dialog.Title>
            <Dialog.Description className="mt-0.5 text-[12px] text-rv-mute-500">
              {t(
                "access.delete.subtitle",
                "Permanently remove this access. Subscribers currently granted this access will lose it.",
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
          <div className="text-[13px] font-semibold text-foreground">
            {accessRow.displayName}
          </div>
          <div className="font-rv-mono text-[11px] text-rv-mute-500">
            {accessRow.identifier}
          </div>
          <div className="mt-1.5 font-rv-mono text-[11px] text-rv-mute-500">
            {t("access.delete.productCount", {
              count: accessRow.productCount,
              defaultValue_one: "{{count}} linked product",
              defaultValue_other: "{{count}} linked products",
            })}
          </div>
        </div>

        <div>
          <label
            htmlFor="confirm-access-identifier"
            className="text-[12px] font-medium text-foreground"
          >
            {t("access.delete.confirmLabel", {
              defaultValue: "Type {{identifier}} to confirm",
              identifier: accessRow.identifier,
            })}
          </label>
          <input
            id="confirm-access-identifier"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            placeholder={accessRow.identifier}
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
            ? t("access.delete.deleting", "Deleting…")
            : t("access.delete.confirm", "Delete access")}
        </Button>
      </footer>
    </>
  );
}
