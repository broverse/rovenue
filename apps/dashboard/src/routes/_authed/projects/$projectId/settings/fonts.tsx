import { useId, useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Dialog } from "@base-ui-components/react/dialog";
import { Plus, Trash2, Type, X } from "lucide-react";
import {
  FONT_ALLOWED_FORMATS,
  FONT_FACES_MAX_PER_PROJECT,
} from "@rovenue/shared";
import { Button } from "../../../../../ui/button";
import { Card, CardHeader } from "../../../../../ui/card";
import { Input } from "../../../../../ui/input";
import { NativeSelect } from "../../../../../ui/native-select";
import { ConfirmDialog } from "../../../../../ui/confirm-dialog";
import {
  EmptyStateCard,
  LoadingState,
} from "../../../../../components/dashboard";
import { cn } from "../../../../../lib/cn";
import { ApiError } from "../../../../../lib/api";
import {
  useDeleteFontFamily,
  useFontFamilies,
  useUploadFontFace,
  type FontFace,
  type FontFaceStyle,
  type FontFamily,
} from "../../../../../lib/hooks/useFonts";

// =============================================================
// /projects/:projectId/settings/fonts
// =============================================================
//
// Fonts are a project asset shared across every paywall (design spec
// §5) — they live in project settings, not inside the paywall
// builder. Wave E2 adds the picker that consumes what's uploaded
// here.
//
// Deleting a family a paywall still references is allowed on purpose
// (design spec §4.1): affected paywalls fall back to the system
// font. That's stated up front in the delete confirmation below, not
// left for someone to discover after the fact.

export const Route = createFileRoute(
  "/_authed/projects/$projectId/settings/fonts",
)({
  component: FontsRoute,
});

function FontsRoute() {
  const { projectId } = useParams({
    from: "/_authed/projects/$projectId/settings/fonts",
  });
  return <FontsPage projectId={projectId} />;
}

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

const FONT_STYLE_OPTIONS: ReadonlyArray<{ value: FontFaceStyle; label: string }> = [
  { value: "normal", label: "Normal" },
  { value: "italic", label: "Italic" },
];
const DEFAULT_FONT_STYLE: FontFaceStyle = "normal";

const NEW_FAMILY_VALUE = "__new__";
const BYTES_PER_KB = 1024;
const KB_DECIMAL_PLACES = 1;

const FONT_FILE_ACCEPT = FONT_ALLOWED_FORMATS.map((f) => `.${f}`).join(",");

function formatByteSize(byteSize: number): string {
  return `${(byteSize / BYTES_PER_KB).toFixed(KB_DECIMAL_PLACES)} KB`;
}

export function FontsPage({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const familiesQuery = useFontFamilies(projectId);
  const uploadFace = useUploadFontFace(projectId);
  const deleteFamily = useDeleteFontFamily(projectId);

  const [uploadOpen, setUploadOpen] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<FontFamily | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);

  const families = familiesQuery.data ?? [];
  const totalFaces = families.reduce((sum, f) => sum + f.faces.length, 0);

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h1 className="m-0 text-[22px] font-semibold leading-7">
            {t("settings.fonts.title", "Fonts")}
          </h1>
          <p className="mt-1 text-[13px] text-rv-mute-500">
            {t(
              "settings.fonts.subtitle",
              "Upload custom font files for paywalls. Faces are shared across every paywall in this project.",
            )}
          </p>
        </div>
        <div className="flex items-center gap-3">
          <span className="text-[12px] text-rv-mute-500">
            {t("settings.fonts.faceCount", {
              defaultValue: "{{count}} / {{max}} faces used",
              count: totalFaces,
              max: FONT_FACES_MAX_PER_PROJECT,
            })}
          </span>
          <Button variant="solid-primary" size="sm" onClick={() => setUploadOpen(true)}>
            <Plus size={13} />
            {t("settings.fonts.upload.trigger", "Upload font")}
          </Button>
        </div>
      </header>

      {familiesQuery.isLoading ? (
        <LoadingState />
      ) : families.length === 0 ? (
        <EmptyStateCard
          icon={Type}
          title={t("settings.fonts.empty.title", "No fonts yet")}
          description={t(
            "settings.fonts.empty.description",
            "Upload an OTF, TTF, or WOFF2 file to make it available to every paywall in this project.",
          )}
          actions={
            <Button variant="flat" size="sm" onClick={() => setUploadOpen(true)}>
              <Plus size={13} />
              {t("settings.fonts.upload.trigger", "Upload font")}
            </Button>
          }
        />
      ) : (
        <div className="flex flex-col gap-3">
          {families.map((family) => (
            <FontFamilyCard
              key={family.id}
              family={family}
              onDelete={() => setPendingDelete(family)}
            />
          ))}
        </div>
      )}

      <UploadFontDialog
        open={uploadOpen}
        families={families}
        onClose={() => setUploadOpen(false)}
        onUpload={(input) => uploadFace.mutateAsync(input)}
      />

      <ConfirmDialog
        open={pendingDelete !== null}
        tone="danger"
        title={t("settings.fonts.delete.title", {
          defaultValue: "Delete {{name}}?",
          name: pendingDelete?.name ?? "",
        })}
        description={t("settings.fonts.delete.description", {
          defaultValue:
            "Any paywall using {{name}} will fall back to the system font. This can't be undone.",
          name: pendingDelete?.name ?? "",
        })}
        confirmLabel={t("settings.fonts.delete.confirm", "Delete font")}
        onConfirm={async () => {
          if (!pendingDelete) return;
          try {
            await deleteFamily.mutateAsync(pendingDelete.id);
          } catch (err) {
            setDeleteError(
              err instanceof ApiError
                ? err.message
                : t(
                    "settings.fonts.delete.errors.generic",
                    "Could not delete the font. Please try again.",
                  ),
            );
          }
        }}
        onClose={() => setPendingDelete(null)}
      />

      <ConfirmDialog
        open={deleteError !== null}
        tone="danger"
        hideCancel
        title={t("settings.fonts.delete.failedTitle", "Couldn't delete the font")}
        description={deleteError}
        confirmLabel={t("common.dismiss", "Dismiss")}
        onConfirm={() => setDeleteError(null)}
        onClose={() => setDeleteError(null)}
      />
    </div>
  );
}

function FontFamilyCard({
  family,
  onDelete,
}: {
  family: FontFamily;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  return (
    <Card>
      <CardHeader
        title={family.name}
        subtitle={t("settings.fonts.family.facesCount", {
          defaultValue_one: "{{count}} face",
          defaultValue_other: "{{count}} faces",
          count: family.faces.length,
        })}
        right={
          <Button variant="light" size="sm" onClick={onDelete}>
            <Trash2 size={13} />
            {t("settings.fonts.family.delete", "Delete")}
          </Button>
        }
      />
      {family.faces.length > 0 && (
        <div className="flex flex-col gap-1 px-5 pb-4">
          {family.faces.map((face) => (
            <FontFaceRow key={face.id} face={face} />
          ))}
        </div>
      )}
    </Card>
  );
}

function FontFaceRow({ face }: { face: FontFace }) {
  const styleLabel =
    FONT_STYLE_OPTIONS.find((o) => o.value === face.style)?.label ?? face.style;
  return (
    <div className="flex items-center justify-between rounded-md border border-rv-divider bg-rv-c2 px-3 py-1.5 font-rv-mono text-[11px] text-rv-mute-600">
      <span>
        {face.weight} · {styleLabel} · {face.format.toUpperCase()}
      </span>
      <span className="text-rv-mute-500">{formatByteSize(face.byteSize)}</span>
    </div>
  );
}

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

function UploadFontDialog({
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
