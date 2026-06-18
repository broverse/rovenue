import { useState, type ReactNode } from "react";
import { Dialog } from "@base-ui-components/react/dialog";
import { useTranslation } from "react-i18next";
import { AlertTriangle } from "lucide-react";
import { Button } from "./button";
import { cn } from "../lib/cn";

export type ConfirmTone = "danger" | "default";

export type ConfirmDialogProps = {
  open: boolean;
  /** Heading. */
  title: ReactNode;
  /** Supporting copy under the title. */
  description?: ReactNode;
  /** Confirm button label. Defaults to a translated "Confirm". */
  confirmLabel?: ReactNode;
  /** Cancel button label. Defaults to a translated "Cancel". */
  cancelLabel?: ReactNode;
  /** `danger` shows the warning icon + red confirm button. */
  tone?: ConfirmTone;
  /**
   * Runs when the user confirms. If it returns a promise the dialog shows a
   * busy state and only closes once it resolves; a rejection keeps it open so
   * the caller can surface the error.
   */
  onConfirm: () => void | Promise<void>;
  /** Called on cancel / backdrop / escape, and after a successful confirm. */
  onClose: () => void;
};

/**
 * Reusable yes/no confirmation dialog built on the same Base UI `Dialog`
 * primitive the feature modals use. Prefer this over `window.confirm` for
 * destructive or irreversible actions so the prompt matches the app chrome.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel,
  tone = "default",
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const isDanger = tone === "danger";

  const handleConfirm = async () => {
    try {
      setBusy(true);
      await onConfirm();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        // Ignore dismissals while a confirm is in flight.
        if (!next && !busy) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[400px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2",
            "rounded-xl border border-rv-divider bg-rv-c1 shadow-[0_30px_80px_rgba(0,0,0,0.45)]",
            "transition-[opacity,transform] duration-200 ease-out",
            "data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
            "data-[ending-style]:-translate-y-[46%] data-[starting-style]:-translate-y-[46%]",
            "focus:outline-none",
          )}
        >
          <div className="flex items-start gap-3 px-5 pb-4 pt-5">
            {isDanger && (
              <div className="flex size-8 shrink-0 items-center justify-center rounded-md border border-rv-danger/30 bg-rv-danger/10 text-rv-danger">
                <AlertTriangle size={16} />
              </div>
            )}
            <div className="min-w-0">
              <Dialog.Title className="text-[15px] font-semibold leading-5">
                {title}
              </Dialog.Title>
              {description && (
                <Dialog.Description className="mt-1 text-[12px] leading-5 text-rv-mute-500">
                  {description}
                </Dialog.Description>
              )}
            </div>
          </div>

          <footer className="flex items-center justify-end gap-2 border-t border-rv-divider px-5 py-3">
            <Button
              type="button"
              variant="flat"
              size="sm"
              onClick={onClose}
              disabled={busy}
            >
              {cancelLabel ?? t("common.cancel", "Cancel")}
            </Button>
            <Button
              type="button"
              variant="solid-primary"
              size="sm"
              onClick={handleConfirm}
              disabled={busy}
              className={cn(
                isDanger &&
                  "!bg-rv-danger !text-white hover:!bg-rv-danger/90 focus-visible:!ring-rv-danger",
              )}
            >
              {confirmLabel ?? t("common.confirm", "Confirm")}
            </Button>
          </footer>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
