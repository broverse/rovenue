import { useState } from "react";
import { createFileRoute, useParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { Plus, Trash2, Type } from "lucide-react";
import { FONT_FACES_MAX_PER_PROJECT } from "@rovenue/shared";
import { Button } from "../../../../../ui/button";
import { Card, CardHeader } from "../../../../../ui/card";
import { ConfirmDialog } from "../../../../../ui/confirm-dialog";
import {
  EmptyStateCard,
  LoadingState,
} from "../../../../../components/dashboard";
import {
  FONT_STYLE_OPTIONS,
  UploadFontDialog,
} from "../../../../../components/fonts/upload-font-dialog";
import { ApiError } from "../../../../../lib/api";
import {
  useDeleteFontFamily,
  useFontFamilies,
  useUploadFontFace,
  type FontFace,
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

const BYTES_PER_KB = 1024;
const KB_DECIMAL_PLACES = 1;

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

