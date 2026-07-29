import { useId, useState } from "react";
import { Dialog } from "@base-ui-components/react/dialog";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import { FONT_ALLOWED_FORMATS, FONT_FACES_MAX_PER_PROJECT } from "@rovenue/shared";
import { Button } from "../../ui/button";
import { Input } from "../../ui/input";
import { NativeSelect } from "../../ui/native-select";
import { cn } from "../../lib/cn";
import { ApiError } from "../../lib/api";
import type { FontFaceStyle, FontFamily } from "../../lib/hooks/useFonts";

// =============================================================
// UploadFontDialog — extracted from the fonts settings route
// =============================================================
//
// Moved out of routes/.../settings/fonts.tsx (2026-07-28 review finding):
// this dialog has no dependency on the rest of that file beyond the
// props already passed in, and this codebase's convention for a modal
// of this complexity is a dedicated file (see offering-form-dialog.tsx,
// delete-offering-dialog.tsx, delete-paywall-dialog.tsx). FONT_STYLE_OPTIONS
// is defined here and re-exported because fonts.tsx's FontFaceRow also
// needs the style label lookup — this is the single source of truth.

export const FONT_STYLE_OPTIONS: ReadonlyArray<{
  value: FontFaceStyle;
  label: string;
}> = [
  { value: "normal", label: "Normal" },
  { value: "italic", label: "Italic" },
];
const DEFAULT_FONT_STYLE: FontFaceStyle = "normal";

// The upload endpoint's own weight bounds (apps/api/src/routes/dashboard/fonts.ts)
// aren't exported from @rovenue/shared, so the select's range is mirrored here by
// hand — CSS font-weight's standard 100-900 numeric scale, a structured table of
// options, not a magic bound.
const FONT_WEIGHT_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 100, label: "100 · Thin" },
  { value: 200, label: "200 · Extra Light" },
  { value: 300, label: "300 · Light" },
  { value: 400, label: "400 · Regular" },
  { value: 500, label: "500 · Medium" },
  { value: 600, label: "600 · Semibold" },
  { value: 700, label: "700 · Bold" },
  { value: 800, label: "800 · Extra Bold" },
  { value: 900, label: "900 · Black" },
];
const DEFAULT_FONT_WEIGHT = 400;

const NEW_FAMILY_VALUE = "__new__";

const FONT_FILE_ACCEPT = FONT_ALLOWED_FORMATS.map((f) => `.${f}`).join(",");

function Field({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="text-[12px] font-medium text-foreground">
        {label}
      </label>
      {children}
      {hint && <p className="text-[11px] leading-snug text-rv-mute-500">{hint}</p>}
    </div>
  );
}

export function UploadFontDialog({
  open,
  families,
  onClose,
  onUpload,
}: {
  open: boolean;
  families: FontFamily[];
  onClose: () => void;
  onUpload: (input: {
    file: File;
    weight: number;
    style: FontFaceStyle;
    familyName?: string;
    familyId?: string;
  }) => Promise<unknown>;
}) {
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
            "fixed left-1/2 top-1/2 z-50 w-[460px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2",
            "rounded-xl border border-rv-divider bg-rv-c1 shadow-[0_30px_80px_rgba(0,0,0,0.45)]",
            "transition-[opacity,transform] duration-200 ease-out",
            "data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
            "data-[ending-style]:-translate-y-[46%] data-[starting-style]:-translate-y-[46%]",
            "focus:outline-none",
          )}
        >
          {open && (
            <UploadFontDialogBody
              families={families}
              onClose={onClose}
              onUpload={onUpload}
            />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function UploadFontDialogBody({
  families,
  onClose,
  onUpload,
}: {
  families: FontFamily[];
  onClose: () => void;
  onUpload: (input: {
    file: File;
    weight: number;
    style: FontFaceStyle;
    familyName?: string;
    familyId?: string;
  }) => Promise<unknown>;
}) {
  const { t } = useTranslation();
  const familyId = useId();
  const familyNameId = useId();
  const weightId = useId();
  const styleId = useId();
  const fileId = useId();

  const [familySelection, setFamilySelection] = useState<string>(NEW_FAMILY_VALUE);
  const [familyName, setFamilyName] = useState("");
  const [weight, setWeight] = useState<number>(DEFAULT_FONT_WEIGHT);
  const [style, setStyle] = useState<FontFaceStyle>(DEFAULT_FONT_STYLE);
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  const isNewFamily = familySelection === NEW_FAMILY_VALUE;
  const trimmedFamilyName = familyName.trim();
  const canSubmit =
    Boolean(file) && (isNewFamily ? trimmedFamilyName.length > 0 : true) && !submitting;

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!file || !canSubmit) return;
    setSubmitting(true);
    setSubmitError(null);
    try {
      await onUpload({
        file,
        weight,
        style,
        familyName: isNewFamily ? trimmedFamilyName : undefined,
        familyId: isNewFamily ? undefined : familySelection,
      });
      onClose();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === "FONT_FORMAT_UNSUPPORTED") {
          setSubmitError(
            t(
              "settings.fonts.upload.errors.formatUnsupported",
              "This file isn't a supported font format (OTF, TTF, or WOFF2).",
            ),
          );
        } else if (err.code === "FONT_FILE_TOO_LARGE") {
          setSubmitError(
            t("settings.fonts.upload.errors.fileTooLarge", "This font file is too large."),
          );
        } else if (err.code === "FONT_QUOTA_EXCEEDED") {
          setSubmitError(
            t("settings.fonts.upload.errors.quotaExceeded", {
              defaultValue: "This project has reached its {{max}}-face limit.",
              max: FONT_FACES_MAX_PER_PROJECT,
            }),
          );
        } else if (err.code === "FONT_FAMILY_NOT_FOUND") {
          setSubmitError(
            t(
              "settings.fonts.upload.errors.familyNotFound",
              "That font family no longer exists.",
            ),
          );
        } else {
          setSubmitError(err.message);
        }
      } else {
        setSubmitError(
          t("settings.fonts.upload.errors.generic", "Could not upload the font. Please try again."),
        );
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={onSubmit} className="flex flex-col">
      <header className="flex items-start justify-between border-b border-rv-divider px-5 pb-3 pt-4">
        <div>
          <Dialog.Title className="text-[15px] font-semibold leading-5">
            {t("settings.fonts.upload.title", "Upload a font face")}
          </Dialog.Title>
          <Dialog.Description className="mt-0.5 text-[12px] text-rv-mute-500">
            {t(
              "settings.fonts.upload.subtitle",
              "One weight/style combination per upload. Re-uploading the same combination replaces it.",
            )}
          </Dialog.Description>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close", "Close")}
          className="-mr-1 -mt-1 rounded-md p-1 text-rv-mute-500 transition hover:bg-rv-c2 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-rv-accent-500"
        >
          <X size={14} />
        </button>
      </header>

      <div className="flex flex-col gap-4 px-5 py-5">
        <Field id={familyId} label={t("settings.fonts.upload.family.label", "Family")}>
          <NativeSelect
            id={familyId}
            value={familySelection}
            onChange={(e) => setFamilySelection(e.target.value)}
          >
            <option value={NEW_FAMILY_VALUE}>
              {t("settings.fonts.upload.family.new", "New family")}
            </option>
            {families.map((f) => (
              <option key={f.id} value={f.id}>
                {f.name}
              </option>
            ))}
          </NativeSelect>
        </Field>

        {isNewFamily && (
          <Field
            id={familyNameId}
            label={t("settings.fonts.upload.familyName.label", "Family name")}
          >
            <Input
              id={familyNameId}
              value={familyName}
              onChange={(e) => setFamilyName(e.target.value)}
              placeholder={t(
                "settings.fonts.upload.familyName.placeholder",
                "e.g. Brand Sans",
              )}
              autoComplete="off"
            />
          </Field>
        )}

        <div className="grid grid-cols-2 gap-3">
          <Field id={weightId} label={t("settings.fonts.upload.weight.label", "Weight")}>
            <NativeSelect
              id={weightId}
              value={weight}
              onChange={(e) => setWeight(Number(e.target.value))}
            >
              {FONT_WEIGHT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </NativeSelect>
          </Field>

          <Field id={styleId} label={t("settings.fonts.upload.style.label", "Style")}>
            <NativeSelect
              id={styleId}
              value={style}
              onChange={(e) => setStyle(e.target.value as FontFaceStyle)}
            >
              {FONT_STYLE_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </NativeSelect>
          </Field>
        </div>

        <Field
          id={fileId}
          label={t("settings.fonts.upload.file.label", "Font file")}
          hint={t("settings.fonts.upload.file.hint", "OTF, TTF, or WOFF2.")}
        >
          <input
            id={fileId}
            type="file"
            accept={FONT_FILE_ACCEPT}
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            className="block w-full text-[12px] text-rv-mute-600 file:mr-3 file:rounded-md file:border file:border-rv-divider file:bg-rv-c2 file:px-3 file:py-1.5 file:text-[12px] file:font-medium file:text-foreground"
          />
        </Field>

        {submitError && (
          <div className="rounded-md border border-rv-danger/30 bg-rv-danger/10 px-3 py-2 text-[12px] text-rv-danger">
            {submitError}
          </div>
        )}
      </div>

      <footer className="flex items-center justify-end gap-2 border-t border-rv-divider px-5 py-3">
        <Button type="button" variant="flat" size="sm" onClick={onClose} disabled={submitting}>
          {t("common.cancel", "Cancel")}
        </Button>
        <Button type="submit" variant="solid-primary" size="sm" disabled={!canSubmit}>
          {submitting
            ? t("settings.fonts.upload.submitting", "Uploading…")
            : t("settings.fonts.upload.submit", "Upload")}
        </Button>
      </footer>
    </form>
  );
}
