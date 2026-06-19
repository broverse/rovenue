import { useEffect, useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@base-ui-components/react/dialog";
import { X } from "lucide-react";
import type { GrantSubscriptionRequest } from "@rovenue/shared";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { NativeSelect } from "../../ui/native-select";
import { Segmented } from "../../ui/segmented";
import { Textarea } from "../../ui/textarea";
import { cn } from "../../lib/cn";
import { useGrantSubscription } from "../../lib/hooks/useProjectSubscriptions";
import { useProjectProducts } from "../../lib/hooks/useProjectProducts";
import { SubscriberCombobox } from "../subscribers/subscriber-combobox";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Preset =
  | "1d"
  | "1w"
  | "1mo"
  | "3mo"
  | "6mo"
  | "1yr"
  | "lifetime"
  | "custom";

const PRESETS: ReadonlyArray<Preset> = [
  "1d",
  "1w",
  "1mo",
  "3mo",
  "6mo",
  "1yr",
  "lifetime",
  "custom",
];

type Props = {
  projectId: string;
  open: boolean;
  onClose: () => void;
  /**
   * Pre-select a subscriber (internal Rovenue id). When set, the subscriber
   * search/picker is replaced by a read-only field — used when the modal is
   * launched from a specific customer's detail panel.
   */
  initialSubscriberId?: string;
  /** Human-readable label for the pre-selected subscriber (e.g. app user id). */
  initialSubscriberLabel?: string;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Returns tomorrow as YYYY-MM-DD (UTC). */
function tomorrowIso(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/** Returns true if the date string is in the past or today. */
function isExpiredOrToday(dateStr: string): boolean {
  if (!dateStr) return true;
  const chosen = new Date(dateStr).getTime();
  const tomorrow = new Date(tomorrowIso()).getTime();
  return chosen < tomorrow;
}

// ---------------------------------------------------------------------------
// GrantSubscriptionModal
// ---------------------------------------------------------------------------

export function GrantSubscriptionModal({
  projectId,
  open,
  onClose,
  initialSubscriberId,
  initialSubscriberLabel,
}: Props) {
  const { t } = useTranslation();
  const lockedSubscriber = Boolean(initialSubscriberId);

  // ── form state ────────────────────────────────────────────────────────────
  const [subscriberId, setSubscriberId] = useState("");
  const [productId, setProductId] = useState("");
  const [preset, setPreset] = useState<Preset>("1mo");
  const [customDate, setCustomDate] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Reset when modal opens.
  useEffect(() => {
    if (!open) return;
    setSubscriberId(initialSubscriberId ?? "");
    setProductId("");
    setPreset("1mo");
    setCustomDate("");
    setNote("");
    setError(null);
  }, [open, initialSubscriberId]);

  // ── data queries ──────────────────────────────────────────────────────────
  const productsQuery = useProjectProducts({ projectId, limit: 200 });

  // Flatten paginated pages.
  const productRows = useMemo(
    () => productsQuery.data?.pages.flatMap((p) => p.products) ?? [],
    [productsQuery.data],
  );

  // ── mutation ──────────────────────────────────────────────────────────────
  const grant = useGrantSubscription(projectId);

  // ── validation ────────────────────────────────────────────────────────────
  const customDateInvalid =
    preset === "custom" && (!customDate || isExpiredOrToday(customDate));
  const canSubmit =
    Boolean(subscriberId) &&
    Boolean(productId) &&
    !customDateInvalid &&
    !grant.isPending;

  // ── submit ────────────────────────────────────────────────────────────────
  const submit = async () => {
    if (!canSubmit) return;
    setError(null);

    const duration: GrantSubscriptionRequest["duration"] =
      preset === "custom"
        ? { kind: "custom", expiresAt: new Date(customDate).toISOString() }
        : { kind: "preset", preset };

    const body: GrantSubscriptionRequest = {
      subscriberId,
      productId,
      duration,
      ...(note.trim() ? { note: note.trim() } : {}),
    };

    try {
      await grant.mutateAsync(body);
      onClose();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("subscriptions.grant.errors.unknown", "Something went wrong."),
      );
    }
  };

  // ── ids for accessibility ─────────────────────────────────────────────────
  const idSubscriber = useId();
  const idProduct = useId();
  const idCustomDate = useId();
  const idNote = useId();

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
            "fixed left-1/2 top-1/2 z-50 flex w-[520px] max-w-[calc(100vw-32px)] max-h-[calc(100vh-48px)] -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-xl border border-rv-divider bg-rv-c1 shadow-[0_20px_80px_rgba(0,0,0,0.5)]",
            "transition duration-150 ease-out data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0 data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0",
            "focus:outline-none",
          )}
        >
          {/* ── Header ── */}
          <header className="flex items-start justify-between border-b border-rv-divider px-5 py-4">
            <div>
              <Dialog.Title className="text-[15px] font-semibold">
                {t("subscriptions.grant.title", "Grant subscription")}
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-[12px] text-rv-mute-500">
                {t(
                  "subscriptions.grant.subtitle",
                  "Manually provision a subscription for a subscriber.",
                )}
              </Dialog.Description>
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
              {/* Subscriber */}
              <Field
                label={t("subscriptions.grant.fields.subscriber", "Subscriber")}
                htmlFor={idSubscriber}
              >
                {lockedSubscriber ? (
                  <Input
                    id={idSubscriber}
                    value={initialSubscriberLabel ?? initialSubscriberId ?? ""}
                    readOnly
                    disabled
                  />
                ) : (
                  <SubscriberCombobox
                    id={idSubscriber}
                    projectId={projectId}
                    value={subscriberId}
                    onChange={setSubscriberId}
                  />
                )}
              </Field>

              {/* Product */}
              <Field
                label={t("subscriptions.grant.fields.product", "Product")}
                htmlFor={idProduct}
              >
                <NativeSelect
                  id={idProduct}
                  value={productId}
                  onChange={(e) => setProductId(e.target.value)}
                >
                  <option value="">
                    {productsQuery.isPending
                      ? t("common.loading")
                      : t(
                          "subscriptions.grant.fields.productPlaceholder",
                          "— select product —",
                        )}
                  </option>
                  {productRows.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.displayName} ({p.identifier})
                    </option>
                  ))}
                </NativeSelect>
              </Field>

              {/* Duration */}
              <div>
                <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
                  {t("subscriptions.grant.fields.duration", "Duration")}
                </div>
                <Segmented<Preset>
                  options={PRESETS}
                  value={preset}
                  onChange={setPreset}
                  ariaLabel={t(
                    "subscriptions.grant.fields.durationAria",
                    "Duration preset",
                  )}
                  className="w-full"
                />
                {preset === "custom" && (
                  <div className="mt-2">
                    <label
                      htmlFor={idCustomDate}
                      className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-rv-mute-500"
                    >
                      {t(
                        "subscriptions.grant.fields.expiresAt",
                        "Expires at",
                      )}
                    </label>
                    <Input
                      id={idCustomDate}
                      type="date"
                      min={tomorrowIso()}
                      value={customDate}
                      onChange={(e) => setCustomDate(e.target.value)}
                    />
                    {customDateInvalid && customDate && (
                      <p className="mt-1 text-[11px] text-rv-danger">
                        {t(
                          "subscriptions.grant.errors.datePast",
                          "Date must be in the future.",
                        )}
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Note */}
              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label
                    htmlFor={idNote}
                    className="text-[11px] font-medium uppercase tracking-wider text-rv-mute-500"
                  >
                    {t("subscriptions.grant.fields.note", "Note")}{" "}
                    <span className="normal-case text-rv-mute-400">
                      ({t("common.optional")})
                    </span>
                  </label>
                  <span
                    className={cn(
                      "text-[11px] tabular-nums",
                      note.length > 200
                        ? "text-rv-danger"
                        : "text-rv-mute-400",
                    )}
                  >
                    {note.length}/200
                  </span>
                </div>
                <Textarea
                  id={idNote}
                  placeholder={t(
                    "subscriptions.grant.fields.notePlaceholder",
                    "Why was this subscription granted?",
                  )}
                  value={note}
                  maxLength={200}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
            </div>
          </div>

          {/* ── Footer ── */}
          <footer className="flex items-center justify-between border-t border-rv-divider bg-rv-c1 px-5 py-3">
            <span className="text-[12px] text-rv-danger" role="alert">
              {error ?? ""}
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
                {grant.isPending
                  ? t("subscriptions.grant.submitting", "Granting…")
                  : t("subscriptions.grant.submit", "Grant subscription")}
              </Button>
            </div>
          </footer>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ---------------------------------------------------------------------------
// Field wrapper
// ---------------------------------------------------------------------------

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <label
        htmlFor={htmlFor}
        className="mb-1 block text-[11px] font-medium uppercase tracking-wider text-rv-mute-500"
      >
        {label}
      </label>
      {children}
    </div>
  );
}
