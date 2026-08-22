import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { Film, ImageIcon, Sparkles, Trash2, TriangleAlert, UploadCloud } from "lucide-react";
import {
  ASSET_KINDS,
  ASSET_NAME_MAX_LENGTH,
  ERROR_CODE,
  type AssetKind,
} from "@rovenue/shared";
import { Button } from "../../ui/button";
import { ConfirmDialog } from "../../ui/confirm-dialog";
import { EmptyStateCard, LoadingState } from "../dashboard";
import { cn } from "../../lib/cn";
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
import { billingEnabled } from "../../lib/host-mode";
import { formatAssetByteSize } from "./byte-size";
import { kindLabel } from "./kind-label";
import { storageNoticeFor, type StorageNotice } from "./storage-notice";

// =============================================================
// AssetLibrary — the dashboard's project-scoped asset CDN surface
// =============================================================
//
// ONE component serves two surfaces: the full-screen route
// (/projects/:projectId/assets) and the dialog a builder field's
// "Browse" button opens (`AssetLibraryModal`). There is deliberately no
// separate read-only "picker" component — an author who opens Browse
// and finds the image they wanted missing must be able to upload it
// right there instead of leaving the builder, and a second component
// would mean a second upload path, a second progress affordance and a
// second copy of the delete warning below to keep in sync.
//
// Two optional props turn on select mode and nothing else:
//   - `selectKind` filters the grid to one kind AND restricts the
//     upload triggers to it (an image field that let you upload a video
//     would list an asset it then refuses to render).
//   - `onSelect` makes each tile a button returning `asset.url`.
// With neither, this is exactly the screen it has always been.
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

/** Grid geometry. Hoisted because the tile width and the modal width
 *  (asset-library-modal.tsx) are one decision, not two: the modal is
 *  sized to fit a whole number of these columns. */
const TILE_MIN_WIDTH_PX = 150;
const TILE_PREVIEW_HEIGHT_PX = 96;

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
 *
 * This warning is the ONLY guard on deletion, and it is now reachable
 * from inside a builder as well as from the library route — deleting
 * mid-build is exactly as consequential as deleting from the route, so
 * the same copy is shown in both, never a shortened one.
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

export function AssetLibrary({
  projectId,
  variant = "page",
  selectKind,
  onSelect,
  currentUrl,
}: {
  projectId: string;
  /** "modal" drops the page heading — the dialog supplies its own title. */
  variant?: "page" | "modal";
  selectKind?: AssetKind;
  onSelect?: (url: string) => void;
  /** The URL the field that opened this already holds — marks its tile. */
  currentUrl?: string;
}) {
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

  const uploadableKinds = selectKind ? [selectKind] : ASSET_KINDS;
  const assets = (assetsQuery.data?.assets ?? []).filter(
    (a) => !selectKind || a.kind === selectKind,
  );
  const usage = assetsQuery.data?.usage;
  const storageNotice = storageNoticeFor(usage);
  // A full project cannot accept a single further byte: the server's
  // reservation refuses anything that would take the total past the cap.
  // Disabling the trigger states that up front instead of letting the
  // author pick a file and collect a 402 for it.
  const storageFull = storageNotice === "full";

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
      {variant === "page" && (
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
      )}

      <div className="flex flex-wrap items-center gap-2">
        {uploadableKinds.map((kind) => (
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
              disabled={uploadingKind !== null || storageFull}
              onClick={() => fileInputRefs[kind].current?.click()}
            >
              <UploadCloud size={13} />
              {uploadTriggerLabel(t, kind)}
            </Button>
          </div>
        ))}
        {variant === "modal" && usage && (
          <div className="ml-auto">
            <StorageUsageBar usage={usage} compact />
          </div>
        )}
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

      {usage && storageNotice !== "none" && (
        <StorageQuotaNotice notice={storageNotice} usage={usage} projectId={projectId} />
      )}

      {uploadError && (
        <div className="rounded-md border border-rv-danger/30 bg-rv-danger/10 px-3 py-2 text-[12px] text-rv-danger">
          {uploadError}
        </div>
      )}

      {assetsQuery.isLoading ? (
        <LoadingState />
      ) : assets.length === 0 ? (
        selectKind ? (
          <p className="text-[12px] text-rv-mute-500">
            {t("settings.assets.picker.empty", {
              defaultValue:
                "No {{kind}} assets yet. Upload one above, or close this and type a URL directly.",
              kind: kindLabel(t, selectKind),
            })}
          </p>
        ) : (
          <EmptyStateCard
            icon={ImageIcon}
            title={t("settings.assets.empty.title", "No assets yet")}
            description={t(
              "settings.assets.empty.description",
              "Upload an image, video, or Lottie file to make it available to every paywall in this project.",
            )}
          />
        )
      ) : (
        <div
          className="grid gap-2"
          style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${TILE_MIN_WIDTH_PX}px, 1fr))` }}
        >
          {assets.map((asset) => (
            <AssetTile
              key={asset.id}
              asset={asset}
              inUse={Boolean(currentUrl) && asset.url === currentUrl}
              onSelect={onSelect ? () => onSelect(asset.url) : undefined}
              onDelete={() => setPendingDelete(asset)}
            />
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
            : usageQuery.isError
              ? t(
                  "settings.assets.delete.usageFailed",
                  "Couldn't check which published paywalls use this asset. Deleting it now could break a live paywall with no warning.",
                )
              : buildUsageDescription(t, usageQuery.data?.publishedPaywalls ?? [])
        }
        /* Fails closed. An empty `data` looks the same whether the answer
           was "nothing uses it" or the request never landed, and only one
           of those is safe to act on — so an unverified delete is not
           offered at all rather than offered with a caveat. */
        confirmDisabled={usageQuery.isLoading || usageQuery.isError}
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

/** Bar fill and notice text share one colour scale, so "the bar went
 *  red" and "uploads stopped" read as the same fact. */
const NOTICE_FILL_CLASS: Record<StorageNotice, string> = {
  none: "bg-rv-c4",
  warning: "bg-rv-warning",
  critical: "bg-rv-danger",
  full: "bg-rv-danger",
};

const NOTICE_BOX_CLASS: Record<Exclude<StorageNotice, "none">, string> = {
  warning: "border-rv-warning/30 bg-rv-warning/[0.08] text-rv-warning",
  critical: "border-rv-danger/30 bg-rv-danger/10 text-rv-danger",
  full: "border-rv-danger/30 bg-rv-danger/10 text-rv-danger",
};

/**
 * The banner an author sees before — and instead of — a failed upload.
 *
 * `role="status"`, not `alert`: this is a standing condition of the
 * project rather than an event that just happened, and it is already on
 * screen at first render for a project that is full.
 *
 * The upgrade link is cloud-only. A self-hosted deployment has no tiers
 * to move between — `quotasUnlimited()` means it never reaches this
 * state at all — so offering an upgrade there would advertise a product
 * the operator cannot buy.
 */
function StorageQuotaNotice({
  notice,
  usage,
  projectId,
}: {
  notice: Exclude<StorageNotice, "none">;
  usage: StorageUsage;
  projectId: string;
}) {
  const { t } = useTranslation();
  const used = formatAssetByteSize(usage.usedBytes);
  const limit = formatAssetByteSize(usage.limitBytes ?? 0);

  return (
    <div
      role="status"
      className={cn(
        "flex flex-wrap items-center gap-2 rounded-md border px-3 py-2 text-[12px]",
        NOTICE_BOX_CLASS[notice],
      )}
    >
      <TriangleAlert size={14} className="flex-shrink-0" />
      <span>
        {notice === "full"
          ? t("settings.assets.usage.full", {
              defaultValue:
                "Storage is full — {{used}} of {{limit}} used. Delete an asset to make room, or move to a bigger plan.",
              used,
              limit,
            })
          : t("settings.assets.usage.low", {
              defaultValue: "Storage is running low — {{used}} of {{limit}} used.",
              used,
              limit,
            })}
      </span>
        {/* A plain <a>, not a router <Link>: this notice now renders
            inside `AssetLibraryModal` too, and that modal is opened from
            both builders' inspectors — subtrees whose own tests (and the
            dialog portal) carry no router context, where `useLinkProps`
            throws on a null router. A full page load to billing is the
            right outcome for a "leave what you are doing and upgrade"
            link anyway. */}
      {billingEnabled && (
        <a
          href={`/projects/${projectId}/settings/billing`}
          className="font-medium underline underline-offset-2"
        >
          {t("settings.assets.usage.upgrade", "Upgrade for more storage")}
        </a>
      )}
    </div>
  );
}

function StorageUsageBar({ usage, compact = false }: { usage: StorageUsage; compact?: boolean }) {
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
  const label = t("settings.assets.usage.used", {
    defaultValue: "{{used}} of {{limit}} used",
    used: formatAssetByteSize(usage.usedBytes),
    limit: formatAssetByteSize(usage.limitBytes),
  });
  if (compact) {
    // In a dialog the bar is chrome competing with the grid; the figure
    // it labels is the part an author acts on before uploading.
    return <span className="text-[11px] text-rv-mute-500">{label}</span>;
  }
  return (
    <div className="flex flex-col gap-1">
      <span className="text-[12px] text-rv-mute-500">{label}</span>
      <div
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        className="h-1.5 w-full max-w-[220px] overflow-hidden rounded-full bg-rv-c2"
      >
        <div
          className={cn("h-full", NOTICE_FILL_CLASS[storageNoticeFor(usage)])}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/**
 * A tile, not a row: picking an image is a decision made by eye, and a
 * list of file names makes it blind. Only images get a real preview —
 * a video would have to load and decode to show a frame, and a Lottie
 * would need its player, so both get their kind's icon rather than an
 * autoplaying thumbnail inside a picker.
 *
 * The select target and the delete button are SIBLINGS, never nested:
 * a <button> inside a <button> is invalid, and in select mode the whole
 * body is the select target.
 */
function AssetTile({
  asset,
  inUse,
  onSelect,
  onDelete,
}: {
  asset: Asset;
  /** This asset is the one the field that opened the library holds. */
  inUse: boolean;
  onSelect?: () => void;
  onDelete: () => void;
}) {
  const { t } = useTranslation();
  const hasDimensions = asset.width !== null && asset.height !== null;

  const body = (
    <>
      <div
        className="flex w-full items-center justify-center overflow-hidden rounded-t-md bg-rv-c3"
        style={{ height: TILE_PREVIEW_HEIGHT_PX }}
      >
        <AssetPreview asset={asset} />
      </div>
      <div className="flex min-w-0 flex-col px-2 py-1.5 text-left text-[11px]">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate font-medium text-foreground">{asset.name}</span>
          {/* `listPublishedUsage` is blind to drafts, so the delete
              warning cannot see the very node being edited. This marker
              is the only thing standing between "Browse, spot the image,
              delete the duplicate" and a silently 404'd field. */}
          {inUse && (
            <span className="shrink-0 rounded bg-rv-accent-500/15 px-1 py-px text-[9px] font-medium uppercase tracking-wide text-rv-accent-600">
              {t("settings.assets.picker.inUse", "In use")}
            </span>
          )}
        </span>
        <span className="truncate text-rv-mute-500">
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
    </>
  );

  return (
    <div className="group relative overflow-hidden rounded-md border border-rv-divider bg-rv-c2">
      {onSelect ? (
        <button
          type="button"
          onClick={onSelect}
          className={cn(
            "flex w-full flex-col transition",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-rv-accent-500",
          )}
        >
          {body}
          {/* Nothing else marks a tile as clickable — the grid looks
              identical on the manage-only route. `pointer-events-none`
              keeps it from swallowing the click it advertises. */}
          <span className="pointer-events-none absolute inset-x-0 bottom-0 bg-rv-accent-500/90 py-1 text-center text-[10px] font-medium text-white opacity-0 transition group-hover:opacity-100">
            {t("settings.assets.picker.select", "Use this asset")}
          </span>
        </button>
      ) : (
        <div className="flex w-full flex-col">{body}</div>
      )}
      <button
        type="button"
        onClick={onDelete}
        aria-label={t("settings.assets.delete.trigger", "Delete")}
        title={t("settings.assets.delete.trigger", "Delete")}
        className="absolute right-1.5 top-1.5 rounded bg-rv-c1/85 p-1 text-rv-mute-500 opacity-0 transition hover:text-rv-danger focus:outline-none focus-visible:opacity-100 focus-visible:ring-2 focus-visible:ring-rv-accent-500 group-hover:opacity-100"
      >
        <Trash2 size={12} />
      </button>
    </div>
  );
}

function AssetPreview({ asset }: { asset: Asset }) {
  if (asset.kind === "image") {
    return (
      <img
        src={asset.url}
        alt=""
        loading="lazy"
        className="h-full w-full object-cover"
      />
    );
  }
  const Icon = asset.kind === "video" ? Film : Sparkles;
  return <Icon size={20} className="text-rv-mute-500" />;
}
