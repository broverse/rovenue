import { Dialog } from "@base-ui-components/react/dialog";
import { useTranslation } from "react-i18next";
import { X } from "lucide-react";
import type { AssetKind } from "@rovenue/shared";
import { Button } from "../../ui/button";
import { cn } from "../../lib/cn";
import { AssetLibrary } from "./asset-library";

// =============================================================
// AssetLibraryModal — the asset library, in a dialog
// =============================================================
//
// Opened from a URL field's "Browse" button in BOTH builders: the
// paywall inspector's `ThemeUrlField` (image/video/lottie url and a
// video's posterUrl) and the onboarding funnel's Media URL field. It
// renders the real `AssetLibrary`, not a read-only copy of it, so
// uploading and deleting are available wherever browsing is — an
// author who opens Browse and finds the image missing adds it here
// instead of leaving the builder and losing their place.
//
// Selecting calls `onSelect(asset.url)`, which every caller writes
// through the EXACT SAME `onChange` a hand-typed URL would hit.
// Uploading through the library is an option, never a requirement:
// this dialog has no "the field must go through me" gate, and no
// caller replaces its text input with a select-only control. A node's
// `url` is a plain string; there is no way, and no need, to tell an
// uploaded asset's URL apart from a hand-typed external one once it's
// in there.
//
// `kind` filters the grid AND the upload triggers to one kind — a
// project's video assets are never offered for an image field and vice
// versa, because the field only makes sense pointed at bytes the
// renderer will actually decode as that kind.
//
// Closing is the CALLER's business, exactly as it was for the picker
// this replaces: `onSelect` does not auto-close, because a caller that
// tracks which of two rows (light/dark) it is filling has to clear that
// state itself anyway.

/** Four `TILE_MIN_WIDTH_PX` columns plus gaps and the body's padding. */
const MODAL_WIDTH_PX = 720;
const BODY_MAX_HEIGHT_PX = 440;

export function AssetLibraryModal({
  projectId,
  kind,
  open,
  onClose,
  onSelect,
  currentUrl,
}: {
  projectId: string;
  /** Omit to browse every kind — a manage-only view. */
  kind?: AssetKind;
  open: boolean;
  onClose: () => void;
  /** Omit to manage without picking. */
  onSelect?: (url: string) => void;
  /** The URL the calling field already holds, so its tile is marked. */
  currentUrl?: string;
}) {
  const { t } = useTranslation();
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
            "fixed left-1/2 top-1/2 z-50 max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2",
            "rounded-xl border border-rv-divider bg-rv-c1 shadow-[0_30px_80px_rgba(0,0,0,0.45)]",
            "transition-[opacity,transform] duration-200 ease-out",
            "data-[ending-style]:opacity-0 data-[starting-style]:opacity-0",
            "data-[ending-style]:-translate-y-[46%] data-[starting-style]:-translate-y-[46%]",
            "focus:outline-none",
          )}
          style={{ width: MODAL_WIDTH_PX }}
        >
          {/* Mounted only while open so `useAssets` isn't fetched for
              every field on a builder screen that nobody has browsed. */}
          {open && (
            <>
              <header className="flex shrink-0 items-start justify-between border-b border-rv-divider px-5 pb-3 pt-4">
                <Dialog.Title className="text-[15px] font-semibold leading-5">
                  {onSelect
                    ? t("settings.assets.picker.title", "Choose an asset")
                    : t("settings.assets.title", "Assets")}
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

              <div
                className="min-h-0 flex-1 overflow-y-auto px-5 py-4"
                style={{ maxHeight: BODY_MAX_HEIGHT_PX }}
              >
                <AssetLibrary
                  projectId={projectId}
                  variant="modal"
                  selectKind={kind}
                  onSelect={onSelect}
                  currentUrl={currentUrl}
                />
              </div>

              <footer className="flex shrink-0 items-center justify-end gap-2 border-t border-rv-divider px-5 py-3">
                <Button type="button" variant="flat" size="sm" onClick={onClose}>
                  {t("common.cancel", "Cancel")}
                </Button>
              </footer>
            </>
          )}
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
