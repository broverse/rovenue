import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ImageIcon, Trash2, UploadCloud } from "lucide-react";
import {
  ASSET_KINDS,
  ASSET_NAME_MAX_LENGTH,
  ERROR_CODE,
  type AssetKind,
} from "@rovenue/shared";
import { Button } from "../../ui/button";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { EmptyStateCard, LoadingState } from "../dashboard";
import { ApiError } from "../../lib/api";
import {
  useAssets,
  useAssetUsage,
  useDeleteAsset,
  useUploadAsset,
  type Asset,
  type PublishedPaywallRef,
  type StorageUsage,
} from "../../lib/hooks/useAssets";
import { formatAssetByteSize } from "./byte-size";
import { kindLabel } from "./kind-label";

// =============================================================
// AssetLibrary — the dashboard's project-scoped asset CDN screen
// =============================================================
//
// Every t() key below is a static string literal, never a template
// literal built from `kind` — this repo has been bitten by
// non-greppable dynamic i18n keys before. `kindLabel`/`uploadTriggerLabel`
// switch on the (narrow, exhaustive) AssetKind union instead of
// interpolating it into a key path.
//
// Upload progress is real, not a spinner: `useUploadAsset`'s mutation
// takes an `onProgress` callback driven by `XMLHttpRequest.upload.
// onprogress` (see useAssets.ts's module comment for why `fetch` can't
// do this) — a 50 MB video on a slow connection is a minutes-long
// operation, and an indeterminate spinner reads as a hang long before
// it's actually done.
//
// The storage-used affordance renders "Unlimited" rather than a bar
// with no denominator when `usage.limitBytes` is null (HOST_MODE=self,
// or an enterprise tier) — a progress bar with no maximum is
// meaningless, not just unstyled.

const ASSET_ACCEPT: Record<AssetKind, string> = {
  image: "image/*",
  video: "video/*",
  lottie: "application/json,.json",
};

function stripExtension(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}

function uploadTriggerLabel(t: TFunction, kind: AssetKind): string {
  switch (kind) {
    case "image":
      return t("settings.assets.upload.image", "Upload image");
    case "video":
      return t("settings.assets.upload.video", "Upload video");
    case "lottie":
      return t("settings.assets.upload.lottie", "Upload Lottie");
  }
}

/** Every ERROR_CODE this route can return (task-11-brief), mapped to a
 *  message an author can act on — never the same generic sentence for
 *  all six. */
function describeUploadError(t: TFunction, kind: AssetKind, err: unknown): string {
  if (err instanceof ApiError) {
    const kl = kindLabel(t, kind);
    switch (err.code) {
      case ERROR_CODE.ASSET_FORMAT_UNSUPPORTED:
        return t("settings.assets.upload.errors.formatUnsupported", {
          defaultValue: "This file isn't a supported {{kind}} format.",
          kind: kl,
        });
      case ERROR_CODE.ASSET_FILE_TOO_LARGE:
        return t("settings.assets.upload.errors.fileTooLarge", {
          defaultValue: "This {{kind}} file is too large.",
          kind: kl,
        });
      case ERROR_CODE.ASSET_QUOTA_EXCEEDED:
        return t(
          "settings.assets.upload.errors.quotaExceeded",
          "This project has reached its storage limit.",
        );
      case ERROR_CODE.ASSET_INVALID_NAME:
        return t(
          "settings.assets.upload.errors.invalidName",
          "That name isn't valid. Use letters, numbers, spaces, periods, hyphens, or underscores.",
        );
      case ERROR_CODE.ASSET_PROCESSING_FAILED:
        return t(
          "settings.assets.upload.errors.processingFailed",
          "This file couldn't be processed. Try a different file.",
        );
      case ERROR_CODE.ASSET_STORAGE_UNAVAILABLE:
        return t(
          "settings.assets.upload.errors.storageUnavailable",
          "Asset storage isn't configured for this environment.",
        );
      default:
        return err.message;
    }
  }
  return t("settings.assets.upload.errors.generic", "Could not upload this asset. Please try again.");
}

/**
 * The delete-warning copy. The boundary this states is load-bearing:
 * `useAssetUsage` only ever reports PUBLISHED paywalls (the server's
 * `listPublishedUsage` joins on a paywall's current published version —
 * see packages/db/src/drizzle/repositories/assets.ts), so an asset
 * referenced only by a draft comes back as an EMPTY list here. If the
 * zero-case read "0 paywalls use this asset" an author would reasonably
 * take that as "nothing depends on this" and delete something their
 * in-progress draft still needs. Both branches below say "published
 * paywalls", never bare "paywalls", and the zero-case spells out the
 * draft blind spot explicitly rather than leaving it implicit.
 */
function buildUsageDescription(t: TFunction, paywalls: PublishedPaywallRef[]): string {
  if (paywalls.length === 0) {
    return t(
      "settings.assets.delete.usageZero",
      "0 published paywalls currently reference this asset. Drafts aren't checked here, so an unpublished draft could still depend on it.",
    );
  }
  const names = paywalls.map((p) => p.name).join(", ");
  return t("settings.assets.delete.usageSome", {
    defaultValue_one:
      "{{count}} published paywall uses this asset: {{names}}. Deleting it will break that paywall immediately.",
    defaultValue_other:
      "{{count}} published paywalls use this asset: {{names}}. Deleting it will break those paywalls immediately.",
    count: paywalls.length,
    names,
  });
}

export function AssetLibrary({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const assetsQuery = useAssets(projectId);
  const uploadAsset = useUploadAsset(projectId);
  const deleteAsset = useDeleteAsset(projectId);

  const imageInputRef = useRef<HTMLInputElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const lottieInputRef = useRef<HTMLInputElement>(null);
  const fileInputRefs: Record<AssetKind, React.RefObject<HTMLInputElement | null>> = {
    image: imageInputRef,
    video: videoInputRef,
    lottie: lottieInputRef,
  };

  const [uploadingKind, setUploadingKind] = useState<AssetKind | null>(null);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);

  const [pendingDelete, setPendingDelete] = useState<Asset | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const usageQuery = useAssetUsage(projectId, pendingDelete?.id ?? null);

  const assets = assetsQuery.data?.assets ?? [];
  const usage = assetsQuery.data?.usage;

  async function startUpload(kind: AssetKind, file: File) {
    setUploadError(null);
    setUploadingKind(kind);
    setUploadProgress(0);
    const name = stripExtension(file.name).slice(0, ASSET_NAME_MAX_LENGTH) || file.name;
    try {
      await uploadAsset.mutateAsync({ kind, name, file, onProgress: setUploadProgress });
    } catch (err) {
      setUploadError(describeUploadError(t, kind, err));
    } finally {
      setUploadingKind(null);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="max-w-2xl">
          <h1 className="m-0 text-[22px] font-semibold leading-7">
            {t("settings.assets.title", "Assets")}
          </h1>
          <p className="mt-1 text-[13px] text-rv-mute-500">
            {t(
              "settings.assets.subtitle",
              "Upload images, videos, and Lottie animations for paywalls. Assets are shared across every paywall in this project.",
            )}
          </p>
        </div>
        {usage && <StorageUsageBar usage={usage} />}
      </header>

      <div className="flex flex-wrap items-center gap-2">
        {ASSET_KINDS.map((kind) => (
          <div key={kind}>
            <input
              ref={fileInputRefs[kind]}
              type="file"
              accept={ASSET_ACCEPT[kind]}
              data-testid={`asset-upload-input-${kind}`}
              className="hidden"
              onChange={(e) => {
                const file = e.currentTarget.files?.[0];
                e.currentTarget.value = "";
                if (file) void startUpload(kind, file);
              }}
            />
            <Button
              variant="flat"
              size="sm"
              disabled={uploadingKind !== null}
              onClick={() => fileInputRefs[kind].current?.click()}
            >
              <UploadCloud size={13} />
              {uploadTriggerLabel(t, kind)}
            </Button>
          </div>
        ))}
        {uploadingKind && (
          <div className="flex items-center gap-2 text-[12px] text-rv-mute-500">
            <span>
              {t("settings.assets.upload.progress", {
                defaultValue: "Uploading… {{percent}}%",
                percent: uploadProgress,
              })}
            </span>
            <div
              role="progressbar"
              aria-valuenow={uploadProgress}
              aria-valuemin={0}
              aria-valuemax={100}
              className="h-1.5 w-32 overflow-hidden rounded-full bg-rv-c2"
            >
              <div
                className="h-full bg-rv-accent-500 transition-[width]"
                style={{ width: `${uploadProgress}%` }}
              />
            </div>
          </div>
        )}
      </div>

      {uploadError && (
        <div className="rounded-md border border-rv-danger/30 bg-rv-danger/10 px-3 py-2 text-[12px] text-rv-danger">
          {uploadError}
        </div>
      )}

      {assetsQuery.isLoading ? (
        <LoadingState />
      ) : assets.length === 0 ? (
        <EmptyStateCard
          icon={ImageIcon}
          title={t("settings.assets.empty.title", "No assets yet")}
          description={t(
            "settings.assets.empty.description",
            "Upload an image, video, or Lottie file to make it available to every paywall in this project.",
          )}
        />
      ) : (
        <div className="flex flex-col gap-2">
          {assets.map((asset) => (
            <AssetRow key={asset.id} asset={asset} onDelete={() => setPendingDelete(asset)} />
          ))}
        </div>
      )}

      <ConfirmDialog
        open={pendingDelete !== null}
        tone="danger"
        title={t("settings.assets.delete.title", {
          defaultValue: "Delete {{name}}?",
          name: pendingDelete?.name ?? "",
        })}
        description={
          usageQuery.isLoading
            ? t(
                "settings.assets.delete.usageLoading",
                "Checking which published paywalls use this asset…",
              )
            : buildUsageDescription(t, usageQuery.data?.publishedPaywalls ?? [])
        }
        confirmLabel={t("settings.assets.delete.confirm", "Delete asset")}
        onConfirm={async () => {
          if (!pendingDelete) return;
          try {
            await deleteAsset.mutateAsync(pendingDelete.id);
          } catch (err) {
            setDeleteError(
              err instanceof ApiError
                ? err.message
                : t("settings.assets.delete.errors.generic", "Could not delete the asset. Please try again."),
            );
          }
        }}
        onClose={() => setPendingDelete(null)}
      />

      <ConfirmDialog
        open={deleteError !== null}
        tone="danger"
        hideCancel
        title={t("settings.assets.delete.failedTitle", "Couldn't delete the asset")}
        description={deleteError}
        confirmLabel={t("common.dismiss", "Dismiss")}
        onConfirm={() => setDeleteError(null)}
        onClose={() => setDeleteError(null)}
      />
    </div>
  );
}

function StorageUsageBar({ usage }: { usage: StorageUsage }) {
  const { t } = useTranslation();
  if (usage.limitBytes === null) {
    return (
      <div className="text-[12px] text-rv-mute-500">
        {t("settings.assets.usage.unlimited", "Unlimited storage")}
      </div>
    );
  }
  const pct =
    usage.limitBytes > 0 ? Math.min(100, Math.round((usage.usedBytes / usage.limitBytes) * 100)) : 0;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[12px] text-rv-mute-500">
        {t("settings.assets.usage.used", {
          defaultValue: "{{used}} of {{limit}} used",
          used: formatAssetByteSize(usage.usedBytes),
          limit: formatAssetByteSize(usage.limitBytes),
        })}
      </span>
      <div
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1.5 w-full max-w-[220px] overflow-hidden rounded-full bg-rv-c2"
      >
        <div className="h-full bg-rv-c4" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function AssetRow({ asset, onDelete }: { asset: Asset; onDelete: () => void }) {
  const { t } = useTranslation();
  const hasDimensions = asset.width !== null && asset.height !== null;
  return (
    <div className="flex items-center justify-between rounded-md border border-rv-divider bg-rv-c2 px-3 py-2 text-[12px]">
      <div className="flex min-w-0 flex-col">
        <span className="truncate font-medium text-foreground">{asset.name}</span>
        <span className="text-rv-mute-500">
          {kindLabel(t, asset.kind)}
          {hasDimensions &&
            ` · ${t("settings.assets.dimensions", {
              defaultValue: "{{width}} × {{height}}",
              width: asset.width,
              height: asset.height,
            })}`}
          {` · ${formatAssetByteSize(asset.byteSize)}`}
        </span>
      </div>
      <Button variant="light" size="sm" onClick={onDelete}>
        <Trash2 size={13} />
        {t("settings.assets.delete.trigger", "Delete")}
      </Button>
    </div>
  );
}
