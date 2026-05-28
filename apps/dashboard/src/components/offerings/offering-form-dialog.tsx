import { useEffect, useId, useMemo, useRef, useState } from "react";
import { Dialog } from "@base-ui-components/react/dialog";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Switch } from "../../ui/switch";
import { Textarea } from "../../ui/textarea";
import { cn } from "../../lib/cn";
import {
  useCreateOffering,
  useProjectOfferings,
  useUpdateOffering,
} from "../../lib/hooks/useProjectOfferings";
import { useProjectAccess } from "../../lib/hooks/useProjectAccess";
import { ApiError } from "../../lib/api";
import type { Offering } from "./types";

type CreateProps = {
  mode: "create";
  projectId: string;
  open: boolean;
  onClose: () => void;
  onCreated?: (id: string) => void;
  initial?: { accessId?: string };
};

type EditProps = {
  mode: "edit";
  projectId: string;
  open: boolean;
  onClose: () => void;
  offering: Offering;
};

type Props = CreateProps | EditProps;

// Identifier rules mirror the backend validator: lowercase alphanumeric,
// hyphens and underscores only. We slugify the name as a starting point
// and let the user override.
function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function OfferingFormDialog(props: Props) {
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
            "fixed left-1/2 top-1/2 z-50 w-[460px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2",
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
  const accessId = useId();
  const descriptionId = useId();
  const defaultId = useId();
  const nameRef = useRef<HTMLInputElement>(null);

  const editing = props.mode === "edit";
  const initialOffering = editing ? props.offering : null;
  const initialPrefill = !editing ? props.initial : undefined;

  const [name, setName] = useState(initialOffering?.name ?? "");
  const [identifier, setIdentifier] = useState(initialOffering?.key ?? "");
  // In edit mode we never want to overwrite the user's existing identifier
  // from the name field; treat it as "touched" from the start.
  const [identifierTouched, setIdentifierTouched] = useState(editing);
  const [description, setDescription] = useState(initialOffering?.description ?? "");
  const [isDefault, setIsDefault] = useState(initialOffering?.isDefault ?? false);
  const [accessIdValue, setAccessIdValue] = useState(
    (editing ? (initialOffering as Offering | null)?.accessId : initialPrefill?.accessId) ?? "",
  );
  const [submitError, setSubmitError] = useState<string | null>(null);

  const create = useCreateOffering(props.projectId);
  const update = useUpdateOffering(
    props.projectId,
    props.mode === "edit" ? props.offering.id : "",
  );
  const offeringsQuery = useProjectOfferings(props.projectId);
  const accessQuery = useProjectAccess(props.projectId);
  const accessRows = accessQuery.data?.rows ?? [];

  const editingId = initialOffering?.id ?? null;
  const existingIdentifiers = useMemo(() => {
    const set = new Set<string>();
    for (const o of offeringsQuery.data?.offerings ?? []) {
      // In edit mode, exclude the offering being edited from the collision check
      // so the user can keep the same identifier on save.
      if (editingId && o.id === editingId) continue;
      set.add(o.identifier);
    }
    return set;
  }, [offeringsQuery.data, editingId]);

  // Auto-focus the name input on open so the user can start typing.
  useEffect(() => {
    nameRef.current?.focus();
  }, []);

  // Mirror name → identifier slug until the user takes manual control.
  useEffect(() => {
    if (identifierTouched) return;
    setIdentifier(slugify(name));
  }, [name, identifierTouched]);

  const trimmedName = name.trim();
  const trimmedIdentifier = identifier.trim();
  const identifierValid = /^[a-z0-9][a-z0-9_-]*$/.test(trimmedIdentifier);
  const identifierTaken =
    trimmedIdentifier.length > 0 && existingIdentifiers.has(trimmedIdentifier);

  const trimmedDescription = description.trim();
  const isDirty = editing
    ? trimmedName !== (initialOffering?.name ?? "") ||
      trimmedIdentifier !== (initialOffering?.key ?? "") ||
      trimmedDescription !== (initialOffering?.description ?? "") ||
      isDefault !== (initialOffering?.isDefault ?? false) ||
      accessIdValue !== ((initialOffering as Offering | null)?.accessId ?? "")
    : true;

  const pending = create.isPending || update.isPending;
  const canSubmit =
    trimmedName.length > 0 &&
    trimmedIdentifier.length > 0 &&
    identifierValid &&
    !identifierTaken &&
    !pending &&
    isDirty;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitError(null);
    const metadata: Record<string, unknown> = { name: trimmedName };
    if (trimmedDescription) metadata.description = trimmedDescription;

    try {
      if (props.mode === "create") {
        const res = await create.mutateAsync({
          identifier: trimmedIdentifier,
          accessId: accessIdValue,
          isDefault,
          metadata,
        });
        props.onCreated?.(res.offering.id);
      } else {
        await update.mutateAsync({
          identifier: trimmedIdentifier,
          accessId: accessIdValue,
          isDefault,
          metadata,
        });
      }
      props.onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        setSubmitError(err.message);
      } else {
        setSubmitError(
          t(
            "offerings.form.errors.generic",
            "Could not save the offering. Please try again.",
          ),
        );
      }
    }
  };

  const identifierHint = identifierTaken
    ? t(
        "offerings.form.identifier.taken",
        "An existing offering already uses this identifier.",
      )
    : trimmedIdentifier.length > 0 && !identifierValid
      ? t(
          "offerings.form.identifier.invalid",
          "Use lowercase letters, numbers, hyphens or underscores.",
        )
      : t(
          "offerings.form.identifier.hint",
          "Stable key referenced by the SDK and webhooks. Changing it will break existing client integrations.",
        );
  const identifierTone =
    identifierTaken || (trimmedIdentifier.length > 0 && !identifierValid)
      ? "text-rv-danger"
      : "text-rv-mute-500";

  const title = editing
    ? t("offerings.form.editTitle", "Edit offering")
    : t("offerings.form.createTitle", "New offering");
  const subtitle = editing
    ? t(
        "offerings.form.editSubtitle",
        "Update the offering's name, identifier or description. Linked products stay attached.",
      )
    : t(
        "offerings.form.createSubtitle",
        "Bundle SKUs that grant the same access. You can link products afterwards.",
      );
  const submitLabel = editing
    ? pending
      ? t("offerings.form.savingEdit", "Saving…")
      : t("offerings.form.saveEdit", "Save changes")
    : pending
      ? t("offerings.form.savingCreate", "Creating…")
      : t("offerings.form.saveCreate", "Create offering");

  return (
    <form onSubmit={onSubmit} className="flex flex-col">
      <header className="flex items-start justify-between border-b border-rv-divider px-5 pb-3 pt-4">
        <div>
          <Dialog.Title className="text-[15px] font-semibold leading-5">
            {title}
          </Dialog.Title>
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

      <div className="flex flex-col gap-4 px-5 py-5">
        <Field
          id={nameId}
          label={t("offerings.form.name.label", "Name")}
          hint={t(
            "offerings.form.name.hint",
            "Shown across the dashboard and on paywalls.",
          )}
        >
          <Input
            id={nameId}
            ref={nameRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t(
              "offerings.form.name.placeholder",
              "e.g. Pro subscriptions",
            )}
            autoComplete="off"
          />
        </Field>

        <Field
          id={identifierId}
          label={t("offerings.form.identifier.label", "Identifier")}
          hint={identifierHint}
          hintClassName={identifierTone}
        >
          <Input
            id={identifierId}
            mono
            value={identifier}
            onChange={(e) => {
              setIdentifierTouched(true);
              setIdentifier(e.target.value);
            }}
            placeholder="pro-subscriptions"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={identifierTaken || (trimmedIdentifier.length > 0 && !identifierValid)}
          />
        </Field>

        <Field
          id={accessId}
          label={t("offerings.form.access.label", "Access")}
          hint={t(
            "offerings.form.access.hint",
            "The access this offering grants to subscribers.",
          )}
        >
          <select
            id={accessId}
            value={accessIdValue}
            onChange={(e) => setAccessIdValue(e.target.value)}
            className="h-9 w-full rounded-md border border-rv-divider bg-rv-c2 px-2.5 font-rv-mono text-[12px] text-foreground transition focus:border-rv-accent-500 focus:outline-none focus:ring-2 focus:ring-rv-accent-500/30"
          >
            <option value="">
              {t("offerings.form.access.placeholder", "Select access…")}
            </option>
            {accessRows.map((row) => (
              <option key={row.id} value={row.id}>
                {row.displayName} ({row.identifier})
              </option>
            ))}
          </select>
        </Field>

        <Field
          id={descriptionId}
          label={t("offerings.form.description.label", "Description")}
          optional
          hint={t(
            "offerings.form.description.hint",
            "Optional context for teammates browsing the catalog.",
          )}
        >
          <Textarea
            id={descriptionId}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t(
              "offerings.form.description.placeholder",
              "What does this offering unlock for the user?",
            )}
            rows={3}
          />
        </Field>

        <label
          htmlFor={defaultId}
          className="flex cursor-pointer items-start gap-3 rounded-md border border-rv-divider bg-rv-c2 px-3 py-2.5"
        >
          <Switch
            checked={isDefault}
            onChange={setIsDefault}
            ariaLabel={t(
              "offerings.form.default.label",
              "Set as default offering",
            )}
            className="mt-0.5"
          />
          <span className="flex flex-col gap-0.5">
            <span className="text-[13px] font-medium text-foreground" id={defaultId}>
              {t("offerings.form.default.label", "Set as default offering")}
            </span>
            <span className="text-[12px] text-rv-mute-500">
              {t(
                "offerings.form.default.hint",
                "New subscribers fall into this offering when no other offering matches.",
              )}
            </span>
          </span>
        </label>

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
          onClick={props.onClose}
          disabled={pending}
        >
          {t("common.cancel", "Cancel")}
        </Button>
        <Button
          type="submit"
          variant="solid-primary"
          size="sm"
          disabled={!canSubmit}
        >
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
  optional,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  hintClassName?: string;
  optional?: boolean;
  children: React.ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-1.5">
      <label
        htmlFor={id}
        className="flex items-center gap-1.5 text-[12px] font-medium text-foreground"
      >
        {label}
        {optional && (
          <span className="text-[11px] font-normal text-rv-mute-500">
            {t("common.optional", "optional")}
          </span>
        )}
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
