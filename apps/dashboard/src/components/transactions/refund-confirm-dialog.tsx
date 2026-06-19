import { Dialog } from "@base-ui-components/react/dialog";
import { AlertTriangle, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { useRefundTransaction } from "../../lib/hooks/useRefundTransaction";
import { Button } from "../../ui/button";
import type { Transaction } from "./types";

function storeLabel(store: Transaction["store"]): string {
  if (store === "stripe") return "Stripe";
  if (store === "play") return "Google Play";
  return store.charAt(0).toUpperCase() + store.slice(1);
}

export function RefundConfirmDialog({
  projectId,
  tx,
  open,
  onClose,
}: {
  projectId: string;
  tx: Transaction;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const refund = useRefundTransaction(projectId);

  async function handleConfirm() {
    try {
      await refund.mutateAsync(tx.id);
      onClose();
    } catch {
      // error is surfaced inline via refund.error below
    }
  }

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
            "fixed left-1/2 top-1/2 z-[60] w-[420px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2",
            "rounded-xl border border-rv-divider bg-rv-c1 shadow-[0_30px_80px_rgba(0,0,0,0.45)]",
            "transition-[opacity,transform] duration-200 ease-out",
            "data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
            "data-[ending-style]:-translate-y-[46%] data-[starting-style]:-translate-y-[46%]",
            "focus:outline-none",
          )}
        >
          <header className="flex items-start justify-between border-b border-rv-divider px-5 pb-3 pt-4">
            <div className="flex items-start gap-3">
              <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-rv-danger/30 bg-rv-danger/10 text-rv-danger">
                <AlertTriangle size={16} />
              </div>
              <div>
                <Dialog.Title className="text-[15px] font-semibold leading-5">
                  {t("transactions.inspector.refund.title", "Refund this transaction?")}
                </Dialog.Title>
                <Dialog.Description className="mt-0.5 text-[12px] text-rv-mute-500">
                  {t("transactions.inspector.refund.body", "This sends a refund request to {{store}}. The transaction updates here once the store confirms.", { store: storeLabel(tx.store) })}
                </Dialog.Description>
              </div>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label={t("common.close")}
              className="-mr-1 -mt-1 rounded-md p-1 text-rv-mute-500 transition hover:bg-rv-c2 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-rv-accent-500"
            >
              <X size={14} />
            </button>
          </header>

          <div className="px-5 py-4">
            {refund.error && (
              <div
                role="alert"
                className="rounded-md border border-rv-danger/30 bg-rv-danger/10 px-3 py-2 text-[12px] text-rv-danger"
              >
                {t("transactions.inspector.refund.error", "Refund failed: {{message}}", {
                  message: (refund.error as Error).message,
                })}
              </div>
            )}
          </div>

          <footer className="flex items-center justify-end gap-2 border-t border-rv-divider px-5 py-3">
            <Button
              type="button"
              variant="flat"
              size="sm"
              onClick={onClose}
              disabled={refund.isPending}
            >
              {t("transactions.inspector.refund.cancel", "Cancel")}
            </Button>
            <Button
              type="button"
              variant="solid-primary"
              size="sm"
              onClick={handleConfirm}
              disabled={refund.isPending}
              className="!bg-rv-danger !text-white hover:!bg-rv-danger/90 focus-visible:!ring-rv-danger"
            >
              {refund.isPending
                ? t("transactions.inspector.refund.pending", "Requesting refund…")
                : t("transactions.inspector.refund.confirm", "Refund")}
            </Button>
          </footer>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
