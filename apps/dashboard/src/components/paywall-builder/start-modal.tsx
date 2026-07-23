import { useMemo, useState } from "react";
import { component, useService } from "impair";
import { useTranslation } from "react-i18next";
import { FilePlus2, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { PaywallBuilderViewModel } from "./vm/paywall-builder.vm";
import { PRESETS, type PresetId } from "./presets";
import { previewBlocks, type PreviewBlock } from "./start-model";

type Props = { onClose: () => void };

/** Card thumbnail height in px. */
const THUMB_HEIGHT = 132;
/** Silhouette band heights in px, by kind. */
const BAND_HEIGHT = { media: 34, line: 6, cells: 26, action: 12, gap: 8 } as const;

function Silhouette({ blocks }: { blocks: PreviewBlock[] }) {
  return (
    <div
      className="flex flex-col gap-1.5 rounded-md bg-rv-c3 p-2.5"
      style={{ height: THUMB_HEIGHT }}
    >
      {blocks.map((block, i) => {
        const key = `${block.kind}-${i}`;
        if (block.kind === "media") {
          return (
            <div key={key} style={{ height: BAND_HEIGHT.media }} className="rounded bg-rv-c4" />
          );
        }
        if (block.kind === "line") {
          return (
            <div
              key={key}
              style={{ height: BAND_HEIGHT.line, width: `${block.width * 100}%` }}
              className="mx-auto rounded-full bg-rv-mute-600/50"
            />
          );
        }
        if (block.kind === "cells") {
          return (
            <div key={key} style={{ height: BAND_HEIGHT.cells }} className="flex flex-col gap-1">
              <div className="flex-1 rounded border border-rv-divider-strong bg-rv-c4" />
              <div className="flex-1 rounded border border-rv-accent-500/50 bg-rv-accent-500/15" />
            </div>
          );
        }
        if (block.kind === "action") {
          return (
            <div
              key={key}
              style={{ height: BAND_HEIGHT.action }}
              className="rounded bg-rv-accent-500/70"
            />
          );
        }
        return <div key={key} style={{ height: BAND_HEIGHT.gap }} />;
      })}
    </div>
  );
}

/**
 * Starting points for a paywall. Applying a preset REPLACES the whole
 * config, so on a non-empty tree a card arms a confirm first — on an
 * empty tree there is nothing to lose and it applies straight away.
 */
export const StartModal = component(({ onClose }: Props) => {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const [confirmingId, setConfirmingId] = useState<PresetId | null>(null);

  const treeIsEmpty = vm.config.root.children.length === 0;

  // Building a preset's config just to draw its silhouette is pure work —
  // do it once per locale rather than on every re-render.
  const silhouettes = useMemo(() => {
    const locale = vm.defaultLocale || "en";
    return new Map(PRESETS.map((p) => [p.id, previewBlocks(p.build(locale))] as const));
  }, [vm.defaultLocale]);

  const choose = (id: PresetId) => {
    if (!treeIsEmpty && confirmingId !== id) {
      setConfirmingId(id);
      return;
    }
    vm.applyPreset(id);
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[88vh] w-[min(880px,94vw)] flex-col rounded-xl border border-rv-divider-strong bg-rv-c1 shadow-[0_30px_80px_rgba(0,0,0,0.6)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-rv-divider px-5 py-4">
          <div className="flex-1">
            <h2 className="text-[15px] font-semibold text-foreground">
              {t("paywalls.builder.start.title", "Start a paywall")}
            </h2>
            <p className="mt-0.5 text-[12px] text-rv-mute-500">
              {t(
                "paywalls.builder.start.subtitle",
                "Begin from a layout and edit everything after — or start from a blank canvas.",
              )}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            title={t("paywalls.builder.start.close", "Close")}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-rv-mute-600 transition hover:bg-rv-c2 hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-auto px-5 py-4">
          <div className="grid grid-cols-3 gap-4">
            {PRESETS.map((preset) => {
              const confirming = confirmingId === preset.id;
              return (
                <button
                  key={preset.id}
                  type="button"
                  onClick={() => choose(preset.id)}
                  className={cn(
                    "cursor-pointer rounded-lg border p-2.5 text-left transition",
                    confirming
                      ? "border-rv-warning bg-rv-warning/10"
                      : "border-rv-divider bg-rv-c2 hover:border-rv-accent-500/50 hover:bg-rv-c3",
                  )}
                >
                  <Silhouette blocks={silhouettes.get(preset.id) ?? []} />
                  <div className="mt-2.5">
                    <span className="rounded bg-rv-accent-500/15 px-1.5 py-0.5 font-rv-mono text-[9px] uppercase tracking-wider text-rv-accent-500">
                      {preset.tag}
                    </span>
                    <div className="mt-1.5 text-[13px] font-medium text-foreground">
                      {preset.name}
                    </div>
                    <div className="mt-0.5 text-[11px] leading-snug text-rv-mute-500">
                      {confirming
                        ? t(
                            "paywalls.builder.start.confirmReplace",
                            "Click again to replace your current design.",
                          )
                        : preset.description}
                    </div>
                  </div>
                </button>
              );
            })}

            {/* Blank canvas is deliberately last — it changes nothing, so it never confirms. */}
            <button
              type="button"
              onClick={onClose}
              className="cursor-pointer rounded-lg border border-rv-divider bg-rv-c2 p-2.5 text-left transition hover:border-rv-accent-500/50 hover:bg-rv-c3"
            >
              <div
                className="flex flex-col items-center justify-center gap-1.5 rounded-md bg-rv-c3 text-rv-mute-500"
                style={{ height: THUMB_HEIGHT }}
              >
                <FilePlus2 size={20} />
                <span className="text-[11px]">
                  {t("paywalls.builder.start.blankThumb", "Empty")}
                </span>
              </div>
              <div className="mt-2.5">
                <span className="rounded bg-rv-c4 px-1.5 py-0.5 font-rv-mono text-[9px] uppercase tracking-wider text-rv-mute-600">
                  {t("paywalls.builder.start.blankTag", "Start empty")}
                </span>
                <div className="mt-1.5 text-[13px] font-medium text-foreground">
                  {t("paywalls.builder.start.blankName", "Blank canvas")}
                </div>
                <div className="mt-0.5 text-[11px] leading-snug text-rv-mute-500">
                  {t("paywalls.builder.start.blankDescription", "Build from scratch.")}
                </div>
              </div>
            </button>
          </div>
        </div>

        <div className="flex items-center border-t border-rv-divider px-5 py-3">
          <div className="flex-1 text-[11px] text-rv-mute-500">
            {t("paywalls.builder.start.footerHint", "Everything is editable after you pick one.")}
          </div>
        </div>
      </div>
    </div>
  );
});
