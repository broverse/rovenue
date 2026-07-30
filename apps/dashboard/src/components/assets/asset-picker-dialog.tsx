import { Dialog } from "@base-ui-components/react/dialog";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { AssetKind } from "@rovenue/shared";
import { Button } from "../../ui/button";
import { cn } from "../../lib/cn";
import { useAssets, type Asset } from "../../lib/hooks/useAssets";
import { formatAssetByteSize } from "./byte-size";
import { kindLabel } from "./kind-label";

// =============================================================
// AssetPickerDialog — browse uploaded assets from a URL field
// =============================================================
//
// Consumed from the paywall builder inspector's `ThemeUrlField`
// (image/video/lottie url + video's posterUrl): selecting a row here
// calls `onSelect(asset.url)`, which the field writes through the
// EXACT SAME `onChange` a hand-typed URL would hit. Uploading through
// the asset library is an option, never a requirement — this dialog
// has no "the field must go through me" gate, and the field's text
// input is never replaced by a select-only control. A node's `url` is
// a plain string; there is no way, and no need, to tell an uploaded
// asset's URL apart from a hand-typed external one once it's in there.
//
// Filtered to a single `kind` — a project's video assets are never
// offered for an image field and vice versa, because the field only
// makes sense pointed at bytes the renderer will actually decode as
// that kind.

export function AssetPickerDialog({
  projectId,
  kind,
  open,
  onClose,
  onSelect,
}: {
  projectId: string;
  kind: AssetKind;
  open: boolean;
  onClose: () => void;
  onSelect: (url: string) => void;
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
            "fixed left-1/2 top-1/2 z-50 w-[440px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2",
            "rounded-xl border border-rv-divider bg-rv-c1 shadow-[0_30px_80px_rgba(0,0,0,0.45)]",
            "transition-[opacity,transform] duration-200 ease-out",
            "data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
            "data-[ending-style]:-translate-y-[46%] data-[starting-style]:-translate-y-[46%]",
            "focus:outline-none",
          )}
        >
          {open && (
            <PickerBody projectId={projectId} kind={kind} onClose={onClose} onSelect={onSelect} />
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PickerBody({
  projectId,
  kind,
  onClose,
  onSelect,
}: {
  projectId: string;
  kind: AssetKind;
  onClose: () => void;
  onSelect: (url: string) => void;
}) {
  const { t } = useTranslation();
  const assetsQuery = useAssets(projectId);
  const assets = (assetsQuery.data?.assets ?? []).filter((a) => a.kind === kind);
  const kl = kindLabel(t, kind);

  return (
    <>
      <header className="flex items-start justify-between border-b border-rv-divider px-5 pb-3 pt-4">
        <Dialog.Title className="text-[15px] font-semibold leading-5">
          {t("settings.assets.picker.title", "Choose an asset")}
        </Dialog.Title>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close", "Close")}
          className="-mr-1 -mt-1 rounded-md p-1 text-rv-mute-500 transition hover:bg-rv-c2 hover:text-foreground focus:outline-none focus-visible:ring-2 focus-visible:ring-rv-accent-500"
        >
          <X size={14} />
        </button>
      </header>

      <div className="flex max-h-[360px] flex-col gap-1.5 overflow-y-auto px-5 py-4">
        {assetsQuery.isLoading ? (
          <p className="text-[12px] text-rv-mute-500">{t("common.loading", "Loading…")}</p>
        ) : assets.length === 0 ? (
          <p className="text-[12px] text-rv-mute-500">
            {t("settings.assets.picker.empty", {
              defaultValue: "No {{kind}} assets uploaded yet. Upload one from the asset library, or type a URL directly.",
              kind: kl,
            })}
          </p>
        ) : (
          assets.map((asset) => (
            <AssetPickerRow key={asset.id} asset={asset} onSelect={() => onSelect(asset.url)} />
          ))
        )}
      </div>

      <footer className="flex items-center justify-end gap-2 border-t border-rv-divider px-5 py-3">
        <Button type="button" variant="flat" size="sm" onClick={onClose}>
          {t("common.cancel", "Cancel")}
        </Button>
      </footer>
    </>
  );
}

function AssetPickerRow({ asset, onSelect }: { asset: Asset; onSelect: () => void }) {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex items-center justify-between rounded-md border border-rv-divider bg-rv-c2 px-3 py-2 text-left text-[12px] transition hover:border-rv-accent-500"
    >
      <span className="min-w-0 truncate text-foreground">{asset.name}</span>
      <span className="ml-3 flex shrink-0 items-center gap-2 text-rv-mute-500">
        <span>{formatAssetByteSize(asset.byteSize)}</span>
        <span className="rounded bg-rv-c3 px-2 py-0.5 font-medium text-rv-accent-600">
          {t("settings.assets.picker.select", "Use this asset")}
        </span>
      </span>
    </button>
  );
}
