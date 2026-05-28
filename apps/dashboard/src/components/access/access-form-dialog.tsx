import { useEffect, useId, useRef, useState } from "react";
import { Dialog } from "@base-ui-components/react/dialog";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { Textarea } from "../../ui/textarea";
import { cn } from "../../lib/cn";

const SLUG_RE = /^[a-z0-9][a-z0-9_-]*$/i;

export interface AccessFormInput {
  identifier: string;
  displayName: string;
  description: string | null;
}

interface Props {
  open: boolean;
  mode: "create" | "edit";
  projectId: string;
  initial?: {
    identifier: string;
    displayName: string;
    description: string | null;
  };
  onClose: () => void;
  onSave: (input: AccessFormInput) => void | Promise<void>;
}

/**
 * Create/edit dialog for an `access` row. The form is intentionally
 * thin: identifier (slug-validated), display name, optional description.
 * Submitting calls the caller-supplied `onSave`, which owns the mutation
 * + error-toast wiring at the route level.
 */
export function AccessFormDialog(props: Props) {
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
  const identifierId = useId();
  const displayNameId = useId();
  const descriptionId = useId();
  const identifierRef = useRef<HTMLInputElement>(null);

  const [identifier, setIdentifier] = useState(props.initial?.identifier ?? "");
  const [displayName, setDisplayName] = useState(
    props.initial?.displayName ?? "",
  );
  const [description, setDescription] = useState(
    props.initial?.description ?? "",
  );
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    identifierRef.current?.focus();
  }, []);

  function submit() {
    setError(null);
    if (!SLUG_RE.test(identifier)) {
      setError(
        t(
          "access.form.errors.slug",
          "identifier must be slug-like (letters, numbers, hyphens, underscores)",
        ),
      );
      return;
    }
    if (!displayName.trim()) {
      setError(
        t("access.form.errors.displayName", "Display name is required"),
      );
      return;
    }
    void props.onSave({
      identifier: identifier.trim(),
      displayName: displayName.trim(),
      description: description.trim() ? description.trim() : null,
    });
  }

  const editing = props.mode === "edit";
  const title = editing
    ? t("access.form.editTitle", "Edit access")
    : t("access.form.createTitle", "New access");
  const submitLabel = editing
    ? t("access.form.save", "Save")
    : t("access.form.create", "Create");

  return (
    <div className="flex flex-col">
      <header className="flex items-start justify-between border-b border-rv-divider px-5 pb-3 pt-4">
        <div>
          <Dialog.Title className="text-[15px] font-semibold leading-5">
            {title}
          </Dialog.Title>
          <Dialog.Description className="mt-0.5 text-[12px] text-rv-mute-500">
            {editing
              ? t(
                  "access.form.editSubtitle",
                  "Update the access identifier or display name. Linked offerings stay attached.",
                )
              : t(
                  "access.form.createSubtitle",
                  "Create a new access bundle that offerings can grant.",
                )}
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
        <div className="flex flex-col gap-1.5">
          <label
            htmlFor={identifierId}
            className="text-[12px] font-medium text-foreground"
          >
            {t("access.form.identifier.label", "Identifier")}
          </label>
          <Input
            id={identifierId}
            ref={identifierRef}
            aria-label="identifier"
            mono
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            placeholder="premium"
            autoComplete="off"
            spellCheck={false}
          />
          <p className="text-[11px] leading-snug text-rv-mute-500">
            {t(
              "access.form.identifier.hint",
              "Stable slug used by the SDK and webhooks. Use lowercase letters, numbers, hyphens or underscores.",
            )}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor={displayNameId}
            className="text-[12px] font-medium text-foreground"
          >
            {t("access.form.displayName.label", "Display name")}
          </label>
          <Input
            id={displayNameId}
            aria-label="display name"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Premium"
            autoComplete="off"
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label
            htmlFor={descriptionId}
            className="text-[12px] font-medium text-foreground"
          >
            {t("access.form.description.label", "Description")}
            <span className="ml-1 text-[11px] font-normal text-rv-mute-500">
              {t("common.optional", "optional")}
            </span>
          </label>
          <Textarea
            id={descriptionId}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t(
              "access.form.description.placeholder",
              "What does this access unlock for the user?",
            )}
            rows={3}
          />
        </div>

        {error && (
          <p
            className="text-[12px] text-rv-danger"
            role="alert"
          >
            {error}
          </p>
        )}
      </div>

      <footer className="flex items-center justify-end gap-2 border-t border-rv-divider px-5 py-3">
        <Button
          type="button"
          variant="flat"
          size="sm"
          onClick={props.onClose}
        >
          {t("common.cancel", "Cancel")}
        </Button>
        <Button
          type="button"
          variant="solid-primary"
          size="sm"
          onClick={submit}
        >
          {submitLabel}
        </Button>
      </footer>
    </div>
  );
}
