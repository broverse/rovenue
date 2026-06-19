import { Dialog } from "@base-ui-components/react/dialog";
import { AlertTriangle, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { type RefundKind, useRefund } from "../../lib/hooks/useRefund";
import { Button } from "../../ui/button";

// i18n keys differ per kind so the two existing translation namespaces keep
// working; everything else (look, behaviour, store-confirms-later wording) is
// shared. Tuples are [key, defaultValue].
const COPY: Record<
  RefundKind,
  Record<"title" | "body" | "error" | "cancel" | "pending" | "confirm", [string, string]>
> = {
  transaction: {
    title: ["transactions.inspector.refund.title", "Refund this transaction?"],
    body: [
      "transactions.inspector.refund.body",
      "This sends a refund request to {{store}}. The transaction updates here once the store confirms.",
    ],
    error: ["transactions.inspector.refund.error", "Refund failed: {{message}}"],
    cancel: ["transactions.inspector.refund.cancel", "Cancel"],
    pending: ["transactions.inspector.refund.pending", "Requesting refund…"],
    confirm: ["transactions.inspector.refund.confirm", "Refund"],
  },
  subscription: {
    title: ["subscriptions.expanded.grants.refundDialog.title", "Refund this subscription?"],
    body: [
      "subscriptions.expanded.grants.refundDialog.body",
      "This sends a refund request to {{store}}. The subscription updates here once the store confirms.",
    ],
    error: ["subscriptions.expanded.grants.refundDialog.error", "Refund failed: {{message}}"],
    cancel: ["subscriptions.expanded.grants.refundDialog.cancel", "Cancel"],
    pending: ["subscriptions.expanded.grants.refundDialog.pending", "Requesting refund…"],
    confirm: ["subscriptions.expanded.grants.refundDialog.confirm", "Refund"],
  },
};

export function RefundConfirmDialog({
  projectId,
  kind,
  id,
  storeLabel,
  open,
  onClose,
}: {
  projectId: string;
  kind: RefundKind;
  /** Transaction id or subscription (purchase) id, depending on `kind`. */
  id: string;
  /** Display name of the store handling the refund, e.g. "Stripe". */
  storeLabel: string;
  open: boolean;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const refund = useRefund(projectId, kind);
  const copy = COPY[kind];

  async function handleConfirm() {
    try {
      await refund.mutateAsync(id);
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
                  {t(copy.title[0], copy.title[1])}
                </Dialog.Title>
                <Dialog.Description className="mt-0.5 text-[12px] text-rv-mute-500">
                  {t(copy.body[0], copy.body[1], { store: storeLabel })}
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
                {t(copy.error[0], copy.error[1], {
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
              {t(copy.cancel[0], copy.cancel[1])}
            </Button>
            <Button
              type="button"
              variant="solid-primary"
              size="sm"
              onClick={handleConfirm}
              disabled={refund.isPending}
              className="!bg-rv-danger !text-white hover:!bg-rv-danger/90 focus-visible:!ring-rv-danger"
            >
              {refund.isPending ? t(copy.pending[0], copy.pending[1]) : t(copy.confirm[0], copy.confirm[1])}
            </Button>
          </footer>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
