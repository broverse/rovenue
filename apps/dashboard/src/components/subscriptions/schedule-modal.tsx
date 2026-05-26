import { useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@base-ui-components/react/dialog";
import { X } from "lucide-react";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Checkbox } from "../../ui/checkbox";
import { cn } from "../../lib/cn";
import { useScheduleAction } from "../../lib/hooks/useProjectSubscriptions";
import type { Subscription } from "./types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Props = {
  projectId: string;
  open: boolean;
  selected: ReadonlyArray<Subscription>;
  onClose: () => void;
};

// ---------------------------------------------------------------------------
// ScheduleCancelModal
// ---------------------------------------------------------------------------

export function ScheduleCancelModal({
  projectId,
  open,
  selected,
  onClose,
}: Props) {
  const { t } = useTranslation();

  const [dueAt, setDueAt] = useState("");
  const [revokeImmediately, setRevokeImmediately] = useState(false);
  const [errorText, setErrorText] = useState<string | null>(null);

  const schedule = useScheduleAction(projectId);

  const anyManual = selected.some((s) => s.store === "manual");

  // Reset when modal opens.
  useEffect(() => {
    if (!open) return;
    setDueAt("");
    setRevokeImmediately(false);
    setErrorText(null);
  }, [open]);

  /** Minimum datetime-local value: now + 60 s, truncated to minutes. */
  const minDateLocal = new Date(Date.now() + 60_000).toISOString().slice(0, 16);

  const canSubmit =
    !!dueAt &&
    new Date(dueAt).getTime() > Date.now() + 60_000 &&
    selected.length > 0 &&
    !schedule.isPending;

  const submit = async () => {
    if (!canSubmit) return;
    setErrorText(null);
    const iso = new Date(dueAt).toISOString();

    const results = await Promise.allSettled(
      selected.map((s) =>
        schedule.mutateAsync({
          purchaseId: s.id,
          body: {
            action: "CANCEL",
            dueAt: iso,
            revokeImmediately: anyManual ? revokeImmediately : false,
          },
        }),
      ),
    );

    const failures = results.filter((r) => r.status === "rejected");
    if (failures.length === 0) {
      onClose();
    } else {
      setErrorText(
        t("subscriptions.schedule.partialFailure", {
          failed: failures.length,
          total: results.length,
        }),
      );
    }
  };

  const idDueAt = useId();

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
            "fixed left-1/2 top-1/2 z-50 flex w-[480px] max-w-[calc(100vw-32px)] max-h-[calc(100vh-48px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-rv-divider bg-rv-c1 shadow-[0_20px_80px_rgba(0,0,0,0.5)]",
            "transition duration-150 ease-out data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0",
            "focus:outline-none",
          )}
        >
          {/* ── Header ── */}
          <header className="flex items-start justify-between border-b border-rv-divider px-5 py-4">
            <div>
              <Dialog.Title className="text-[15px] font-semibold">
                {t("subscriptions.schedule.title", {
                  count: selected.length,
                })}
              </Dialog.Title>
            </div>
            <Dialog.Close
              aria-label={t("common.cancel")}
              className="rounded-md p-1 text-rv-mute-500 transition hover:bg-rv-c2 hover:text-foreground"
            >
              <X size={16} />
            </Dialog.Close>
          </header>

          {/* ── Body ── */}
          <div className="flex-1 overflow-y-auto px-5 py-4">
            <div className="grid grid-cols-1 gap-4">
              {/* dueAt */}
              <div>
                <label
                  htmlFor={idDueAt}
                  className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-rv-mute-500"
                >
                  {t("subscriptions.schedule.dueAt", "When")}
                </label>
                <Input
                  id={idDueAt}
                  type="datetime-local"
                  min={minDateLocal}
                  value={dueAt}
                  onChange={(e) => setDueAt(e.target.value)}
                />
              </div>

              {/* revokeImmediately — only for manual subscriptions */}
              {anyManual && (
                <div className="flex items-center gap-2.5">
                  <Checkbox
                    checked={revokeImmediately}
                    onChange={() => setRevokeImmediately((v) => !v)}
                    ariaLabel={t(
                      "subscriptions.schedule.revokeImmediately",
                      "Revoke access immediately on cancel",
                    )}
                  />
                  <span
                    className="cursor-pointer select-none text-[13px] text-rv-foreground"
                    onClick={() => setRevokeImmediately((v) => !v)}
                  >
                    {t(
                      "subscriptions.schedule.revokeImmediately",
                      "Revoke access immediately on cancel",
                    )}
                  </span>
                </div>
              )}

              {/* Store note */}
              <p className="text-[12px] leading-relaxed text-rv-mute-500">
                {t(
                  "subscriptions.schedule.storeNote",
                  "App Store and Play Store cancellations are requested via webhook; the final state will sync from the store.",
                )}
              </p>
            </div>
          </div>

          {/* ── Footer ── */}
          <footer className="flex items-center justify-between border-t border-rv-divider bg-rv-c1 px-5 py-3">
            <span className="text-[12px] text-rv-danger" role="alert">
              {errorText ?? ""}
            </span>
            <div className="flex gap-2">
              <Button
                variant="flat"
                size="sm"
                onClick={onClose}
                type="button"
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="solid-primary"
                size="sm"
                onClick={submit}
                disabled={!canSubmit}
                type="button"
              >
                {schedule.isPending
                  ? t(
                      "subscriptions.schedule.submitting",
                      "Scheduling…",
                    )
                  : t("subscriptions.schedule.submit", "Schedule cancel")}
              </Button>
            </div>
          </footer>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
