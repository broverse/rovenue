import { useEffect, useRef, useState } from "react";
import { Dialog } from "@base-ui-components/react/dialog";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { cn } from "../../lib/cn";

type Props = {
  open: boolean;
  /** Suggested name pre-filled into the field. */
  initialName: string;
  /**
   * Runs when the user confirms a name. If it rejects, the dialog stays open
   * and surfaces the error so the user can retry.
   */
  onSave: (name: string) => Promise<void>;
  onClose: () => void;
};

/**
 * Name-a-query modal shown when saving a draft. Replaces the old
 * `window.prompt` so the prompt matches the app chrome and can surface
 * save errors inline. Built on the same Base UI `Dialog` primitive as
 * `ui/confirm-dialog`.
 */
export function SaveQueryDialog({ open, initialName, onSave, onClose }: Props) {
  const { t } = useTranslation();
  const [name, setName] = useState(initialName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset the field each time the dialog opens.
  useEffect(() => {
    if (open) {
      setName(initialName);
      setError(null);
    }
  }, [open, initialName]);

  const submit = async () => {
    const trimmed = name.trim();
    if (!trimmed) {
      setError(t("queries.saveDialog.errorEmpty"));
      inputRef.current?.focus();
      return;
    }
    try {
      setBusy(true);
      setError(null);
      await onSave(trimmed);
      onClose();
    } catch (err) {
      setError(
        err instanceof Error ? err.message : t("queries.editor.errorSave"),
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !busy) onClose();
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
          <form
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <div className="px-5 pb-4 pt-5">
              <Dialog.Title className="text-[15px] font-semibold leading-5">
                {t("queries.saveDialog.title")}
              </Dialog.Title>
              <Dialog.Description className="mt-1 text-[12px] leading-5 text-rv-mute-500">
                {t("queries.saveDialog.description")}
              </Dialog.Description>

              <label className="mt-4 block text-[12px] font-medium text-rv-mute-700">
                {t("queries.saveDialog.label")}
              </label>
              <Input
                ref={inputRef}
                autoFocus
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("queries.saveDialog.placeholder")}
                disabled={busy}
                className="mt-1.5"
                maxLength={160}
              />
              {error && (
                <p className="mt-2 text-[12px] leading-5 text-rv-danger">
                  {error}
                </p>
              )}
            </div>

            <footer className="flex items-center justify-end gap-2 border-t border-rv-divider px-5 py-3">
              <Button
                type="button"
                variant="flat"
                size="sm"
                onClick={onClose}
                disabled={busy}
              >
                {t("common.cancel", "Cancel")}
              </Button>
              <Button
                type="submit"
                variant="solid-primary"
                size="sm"
                disabled={busy || !name.trim()}
              >
                {busy
                  ? t("common.saving")
                  : t("queries.saveDialog.save")}
              </Button>
            </footer>
          </form>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
