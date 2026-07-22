import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Dialog } from "@base-ui-components/react/dialog";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { PaywallRemoteConfig } from "@rovenue/shared";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { NativeSelect } from "../../ui/native-select";
import { Switch } from "../../ui/switch";
import { cn } from "../../lib/cn";
import {
  useCreatePaywall,
  useProjectPaywalls,
  useUpdatePaywall,
} from "../../lib/hooks/useProjectPaywalls";
import { useProjectOfferings } from "../../lib/hooks/useProjectOfferings";
import { ApiError } from "../../lib/api";
import { RemoteConfigEditor } from "./remote-config-editor";
import { emptyRemoteConfig } from "./remote-config-utils";
import type { Paywall } from "./types";

type CreateProps = {
  mode: "create";
  projectId: string;
  open: boolean;
  onClose: () => void;
  onCreated?: (id: string) => void;
};

type EditProps = {
  mode: "edit";
  projectId: string;
  open: boolean;
  onClose: () => void;
  paywall: Paywall;
};

type Props = CreateProps | EditProps;

// Mirrors the backend validator (apps/api/src/routes/dashboard/paywalls.ts):
// lowercase alphanumeric, hyphens and underscores only.
const IDENTIFIER_RE = /^[a-z0-9-_]+$/;

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function offeringLabel(row: { identifier: string; metadata: Record<string, unknown> }): string {
  const name = typeof row.metadata?.name === "string" ? row.metadata.name : undefined;
  return name || row.identifier;
}

export function PaywallFormDialog(props: Props) {
  return (
    <Dialog.Root
      open={props.open}
      onOpenChange={(next) => {
        if (!next) props.onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40 backdrop-blur-[2px] transition-opacity duration-200 data-[ending-style]:opacity-0 data-[starting-style]:opacity-0" />
        <Dialog.Popup
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[560px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2",
            "rounded-xl border border-rv-divider bg-rv-c1 shadow-[0_30px_80px_rgba(0,0,0,0.45)]",
            "transition-[opacity,transform] duration-200 ease-out",
            "data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
            "data-[ending-style]:-translate-y-[46%] data-[starting-style]:-translate-y-[46%]",
            "focus:outline-none",
          )}
        >
          {props.open && <DialogBody {...props} />}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function DialogBody(props: Props) {
  const { t } = useTranslation();
  const nameId = useId();
  const identifierId = useId();
  const offeringId_ = useId();
  const activeId = useId();
  const nameRef = useRef<HTMLInputElement>(null);

  const editing = props.mode === "edit";
  const initial = editing ? props.paywall : null;

  const [name, setName] = useState(initial?.name ?? "");
  const [identifier, setIdentifier] = useState(initial?.identifier ?? "");
  const [identifierTouched, setIdentifierTouched] = useState(editing);
  const [offeringId, setOfferingId] = useState(initial?.offeringId ?? "");
  const [isActive, setIsActive] = useState(initial?.isActive ?? true);
  const [remoteConfig, setRemoteConfig] = useState<PaywallRemoteConfig>(
    initial?.remoteConfig ?? emptyRemoteConfig("en"),
  );
  const [remoteConfigValid, setRemoteConfigValid] = useState(true);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const create = useCreatePaywall(props.projectId);
  const update = useUpdatePaywall(props.projectId, props.mode === "edit" ? props.paywall.id : "");
  const paywallsQuery = useProjectPaywalls(props.projectId);
  const offeringsQuery = useProjectOfferings(props.projectId);
  const offerings = offeringsQuery.data?.offerings ?? [];

  const editingId = initial?.id ?? null;
  const existingIdentifiers = useMemo(() => {
    const set = new Set<string>();
    for (const p of paywallsQuery.data?.paywalls ?? []) {
      if (editingId && p.id === editingId) continue;
      set.add(p.identifier);
    }
    return set;
  }, [paywallsQuery.data, editingId]);

  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  useEffect(() => {
    if (identifierTouched) return;
    setIdentifier(slugify(name));
  }, [name, identifierTouched]);

  // Default offeringId to the first offering once the list arrives, in
  // create mode only.
  useEffect(() => {
    if (editing || offeringId || offerings.length === 0) return;
    setOfferingId(offerings[0]!.id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [editing, offerings.length]);

  const trimmedName = name.trim();
  const trimmedIdentifier = identifier.trim();
  const identifierValid = IDENTIFIER_RE.test(trimmedIdentifier);
  const identifierTaken =
    trimmedIdentifier.length > 0 && existingIdentifiers.has(trimmedIdentifier);

  const isDirty = editing
    ? trimmedName !== (initial?.name ?? "") ||
      offeringId !== (initial?.offeringId ?? "") ||
      isActive !== (initial?.isActive ?? true) ||
      JSON.stringify(remoteConfig) !== JSON.stringify(initial?.remoteConfig ?? {})
    : true;

  const pending = create.isPending || update.isPending;
  const canSubmit =
    trimmedName.length > 0 &&
    offeringId.length > 0 &&
    remoteConfigValid &&
    (editing || (trimmedIdentifier.length > 0 && identifierValid && !identifierTaken)) &&
    !pending &&
    isDirty;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitError(null);
    try {
      if (props.mode === "create") {
        const res = await create.mutateAsync({
          identifier: trimmedIdentifier,
          name: trimmedName,
          offeringId,
          remoteConfig,
          isActive,
        });
        props.onCreated?.(res.paywall.id);
      } else {
        await update.mutateAsync({
          name: trimmedName,
          offeringId,
          remoteConfig,
          isActive,
        });
      }
      props.onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        setSubmitError(err.message);
      } else {
        setSubmitError(
          t("paywalls.form.errors.generic", "Could not save the paywall. Please try again."),
        );
      }
    }
  };

  const identifierHint = editing
    ? t("paywalls.form.identifier.locked", "Can't be changed after creation.")
    : identifierTaken
      ? t("paywalls.form.identifier.taken", "An existing paywall already uses this identifier.")
      : trimmedIdentifier.length > 0 && !identifierValid
        ? t(
            "paywalls.form.identifier.invalid",
            "Use lowercase letters, numbers, hyphens or underscores.",
          )
        : t(
            "paywalls.form.identifier.hint",
            "Stable key referenced by placements and experiments. Set once and can't be changed after creation.",
          );
  const identifierTone =
    !editing && (identifierTaken || (trimmedIdentifier.length > 0 && !identifierValid))
      ? "text-rv-danger"
      : "text-rv-mute-500";

  const title = editing
    ? t("paywalls.form.editTitle", "Edit paywall")
    : t("paywalls.form.createTitle", "New paywall");
  const subtitle = editing
    ? t("paywalls.form.editSubtitle", "Update the paywall's config. The identifier stays fixed.")
    : t(
        "paywalls.form.createSubtitle",
        "Bind a remote-config document to an offering for the SDK to render.",
      );
  const submitLabel = editing
    ? pending
      ? t("paywalls.form.savingEdit", "Saving…")
      : t("paywalls.form.saveEdit", "Save changes")
    : pending
      ? t("paywalls.form.savingCreate", "Creating…")
      : t("paywalls.form.saveCreate", "Create paywall");

  return (
    <form onSubmit={onSubmit} className="flex max-h-[85vh] flex-col">
      <header className="flex items-start justify-between border-b border-rv-divider px-5 pb-3 pt-4">
        <div>
          <Dialog.Title className="text-[15px] font-semibold leading-5">{title}</Dialog.Title>
          <Dialog.Description className="mt-0.5 text-[12px] text-rv-mute-500">
            {subtitle}
          </Dialog.Description>
        </div>
        <button
          type="button"
          onClick={props.onClose}
          aria-label={t("common.close", "Close")}
          className="-mr-1 -mt-1 rounded-md p-1 text-rv-mute-500 transition hover:bg-rv-c2 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-rv-accent-500"
        >
          <X size={14} />
        </button>
      </header>

      <div className="flex flex-col gap-4 overflow-y-auto px-5 py-5">
        <div className="grid grid-cols-2 gap-3">
          <Field id={nameId} label={t("paywalls.form.name.label", "Name")}>
            <Input
              id={nameId}
              ref={nameRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("paywalls.form.name.placeholder", "e.g. Onboarding paywall")}
              autoComplete="off"
            />
          </Field>

          <Field
            id={identifierId}
            label={t("paywalls.form.identifier.label", "Identifier")}
            hint={identifierHint}
            hintClassName={identifierTone}
          >
            <Input
              id={identifierId}
              mono
              value={identifier}
              onChange={(e) => {
                if (editing) return;
                setIdentifierTouched(true);
                setIdentifier(e.target.value);
              }}
              placeholder="onboarding-paywall"
              autoComplete="off"
              spellCheck={false}
              disabled={editing}
              aria-invalid={
                !editing && (identifierTaken || (trimmedIdentifier.length > 0 && !identifierValid))
              }
            />
          </Field>
        </div>

        <Field
          id={offeringId_}
          label={t("paywalls.form.offering.label", "Offering")}
          hint={t("paywalls.form.offering.hint", "Which offering this paywall's packages come from.")}
        >
          <NativeSelect
            id={offeringId_}
            value={offeringId}
            onChange={(e) => setOfferingId(e.target.value)}
            disabled={offerings.length === 0}
          >
            {offerings.length === 0 && (
              <option value="">
                {t("paywalls.form.offering.empty", "No offerings yet")}
              </option>
            )}
            {offerings.map((o) => (
              <option key={o.id} value={o.id}>
                {offeringLabel(o)}
              </option>
            ))}
          </NativeSelect>
        </Field>

        <label
          htmlFor={activeId}
          className="flex cursor-pointer items-start gap-3 rounded-md border border-rv-divider bg-rv-c2 px-3 py-2.5"
        >
          <Switch
            checked={isActive}
            onChange={setIsActive}
            ariaLabel={t("paywalls.form.active.label", "Active")}
            className="mt-0.5"
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-[13px] font-medium text-foreground" id={activeId}>
              {t("paywalls.form.active.label", "Active")}
            </span>
            <span className="text-[12px] text-rv-mute-500">
              {t(
                "paywalls.form.active.hint",
                "Inactive paywalls are excluded from placement/experiment resolution.",
              )}
            </span>
          </span>
        </label>

        <div className="flex flex-col gap-1.5">
          <span className="text-[12px] font-medium text-foreground">
            {t("paywalls.form.remoteConfig.label", "Remote config")}
          </span>
          <RemoteConfigEditor
            value={remoteConfig}
            onChange={setRemoteConfig}
            onValidityChange={setRemoteConfigValid}
          />
        </div>

        {submitError && (
          <div className="rounded-md border border-rv-danger/30 bg-rv-danger/10 px-3 py-2 text-[12px] text-rv-danger">
            {submitError}
          </div>
        )}
      </div>

      <footer className="flex items-center justify-end gap-2 border-t border-rv-divider px-5 py-3">
        <Button type="button" variant="flat" size="sm" onClick={props.onClose} disabled={pending}>
          {t("common.cancel", "Cancel")}
        </Button>
        <Button type="submit" variant="solid-primary" size="sm" disabled={!canSubmit}>
          {submitLabel}
        </Button>
      </footer>
    </form>
  );
}

function Field({
  id,
  label,
  hint,
  hintClassName,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  hintClassName?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[12px] font-medium text-foreground">
        {label}
      </label>
      {children}
      {hint && (
        <p className={cn("text-[11px] leading-snug", hintClassName ?? "text-rv-mute-500")}>
          {hint}
        </p>
      )}
    </div>
  );
}
