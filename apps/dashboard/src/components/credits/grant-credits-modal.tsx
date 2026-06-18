import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Dialog } from "@base-ui-components/react/dialog";
import { X } from "lucide-react";
import type { GrantCreditsRequest } from "@rovenue/shared";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { NativeSelect } from "../../ui/native-select";
import { Segmented } from "../../ui/segmented";
import { Textarea } from "../../ui/textarea";
import { cn } from "../../lib/cn";
import { useGrantCredits } from "../../lib/hooks/useProjectCredits";
import { useSubscribers } from "../../lib/hooks/useSubscribers";

type CreditGrantType = "BONUS" | "PURCHASE" | "REFUND";

const TYPES: ReadonlyArray<CreditGrantType> = ["BONUS", "PURCHASE", "REFUND"];

type Props = {
  projectId: string;
  open: boolean;
  onClose: () => void;
};

export function GrantCreditsModal({ projectId, open, onClose }: Props) {
  const { t } = useTranslation();

  const [subscriberSearch, setSubscriberSearch] = useState("");
  const [subscriberId, setSubscriberId] = useState("");
  const [type, setType] = useState<CreditGrantType>("BONUS");
  const [amount, setAmount] = useState("");
  const [referenceType, setReferenceType] = useState("");
  const [referenceId, setReferenceId] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Debounce subscriber search like the subscription grant modal.
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleSearchChange = (v: string) => {
    setSubscriberSearch(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => setDebouncedSearch(v), 200);
  };

  useEffect(() => {
    if (!open) return;
    setSubscriberSearch("");
    setDebouncedSearch("");
    setSubscriberId("");
    setType("BONUS");
    setAmount("");
    setReferenceType("");
    setReferenceId("");
    setDescription("");
    setError(null);
  }, [open]);

  const subscribersQuery = useSubscribers({
    projectId,
    q: debouncedSearch || undefined,
    limit: 50,
  });

  const subscriberRows = useMemo(
    () => subscribersQuery.data?.pages.flatMap((p) => p.subscribers) ?? [],
    [subscribersQuery.data],
  );

  const grant = useGrantCredits(projectId);

  const parsedAmount = Number(amount);
  const amountInvalid =
    amount === "" || !Number.isInteger(parsedAmount) || parsedAmount <= 0;

  const canSubmit =
    Boolean(subscriberId) && !amountInvalid && !grant.isPending;

  const submit = async () => {
    if (!canSubmit) return;
    setError(null);

    const body: GrantCreditsRequest = {
      subscriberId,
      amount: parsedAmount,
      type,
      ...(referenceType.trim() ? { referenceType: referenceType.trim() } : {}),
      ...(referenceId.trim() ? { referenceId: referenceId.trim() } : {}),
      ...(description.trim() ? { description: description.trim() } : {}),
    };

    try {
      await grant.mutateAsync(body);
      onClose();
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t("credits.grant.errors.unknown", "Something went wrong."),
      );
    }
  };

  const idSubscriber = useId();
  const idAmount = useId();
  const idRefType = useId();
  const idRefId = useId();
  const idDescription = useId();

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
          <header className="flex items-start justify-between border-b border-rv-divider px-5 py-4">
            <div>
              <Dialog.Title className="text-[15px] font-semibold">
                {t("credits.grant.title")}
              </Dialog.Title>
              <Dialog.Description className="mt-0.5 text-[12px] text-rv-mute-500">
                {t("credits.grant.subtitle")}
              </Dialog.Description>
            </div>
            <Dialog.Close
              aria-label={t("common.cancel")}
              className="rounded-md p-1 text-rv-mute-500 transition hover:bg-rv-c2 hover:text-foreground"
            >
              <X size={16} />
            </Dialog.Close>
          </header>

          <div className="flex-1 overflow-y-auto px-5 py-4">
            <div className="grid grid-cols-1 gap-4">
              <Field label={t("credits.grant.fields.subscriber")} htmlFor={idSubscriber}>
                <Input
                  placeholder={t("credits.grant.fields.subscriberSearch")}
                  value={subscriberSearch}
                  onChange={(e) => handleSearchChange(e.target.value)}
                  className="mb-1"
                />
                <NativeSelect
                  id={idSubscriber}
                  value={subscriberId}
                  onChange={(e) => setSubscriberId(e.target.value)}
                >
                  <option value="">
                    {subscribersQuery.isPending
                      ? t("common.loading")
                      : t("credits.grant.fields.subscriberPlaceholder")}
                  </option>
                  {subscriberRows.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.appUserId}
                    </option>
                  ))}
                </NativeSelect>
              </Field>

              <div>
                <div className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">
                  {t("credits.grant.fields.type")}
                </div>
                <Segmented<CreditGrantType>
                  options={TYPES}
                  value={type}
                  onChange={setType}
                  ariaLabel={t("credits.grant.fields.type")}
                  className="w-full"
                  renderLabel={(opt) => t(`credits.grant.types.${opt}`)}
                />
              </div>

              <Field label={t("credits.grant.fields.amount")} htmlFor={idAmount}>
                <Input
                  id={idAmount}
                  type="number"
                  inputMode="numeric"
                  min={1}
                  step={1}
                  placeholder={t("credits.grant.fields.amountPlaceholder")}
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                />
              </Field>

              <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                <Field label={t("credits.grant.fields.referenceType")} htmlFor={idRefType}>
                  <Input
                    id={idRefType}
                    placeholder={t("credits.grant.fields.referenceTypePlaceholder")}
                    value={referenceType}
                    maxLength={60}
                    onChange={(e) => setReferenceType(e.target.value)}
                  />
                </Field>
                <Field label={t("credits.grant.fields.referenceId")} htmlFor={idRefId}>
                  <Input
                    id={idRefId}
                    placeholder={t("credits.grant.fields.referenceIdPlaceholder")}
                    value={referenceId}
                    maxLength={120}
                    onChange={(e) => setReferenceId(e.target.value)}
                  />
                </Field>
              </div>

              <div>
                <div className="mb-1 flex items-center justify-between">
                  <label
                    htmlFor={idDescription}
                    className="text-[11px] font-medium uppercase tracking-wider text-rv-mute-500"
                  >
                    {t("credits.grant.fields.description")}{" "}
                    <span className="normal-case text-rv-mute-400">
                      ({t("common.optional")})
                    </span>
                  </label>
                  <span
                    className={cn(
                      "text-[11px] tabular-nums",
                      description.length > 200 ? "text-rv-danger" : "text-rv-mute-400",
                    )}
                  >
                    {description.length}/200
                  </span>
                </div>
                <Textarea
                  id={idDescription}
                  placeholder={t("credits.grant.fields.descriptionPlaceholder")}
                  value={description}
                  maxLength={200}
                  onChange={(e) => setDescription(e.target.value)}
                />
              </div>
            </div>
          </div>

          <footer className="flex items-center justify-between border-t border-rv-divider bg-rv-c1 px-5 py-3">
            <span className="text-[12px] text-rv-danger" role="alert">
              {error ?? ""}
            </span>
            <div className="flex gap-2">
              <Button variant="flat" size="sm" onClick={onClose} type="button">
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
                  ? t("credits.grant.submitting")
                  : t("credits.grant.submit")}
              </Button>
            </div>
          </footer>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

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
