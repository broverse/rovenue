import { useEffect, useState } from "react";
import { component, useService } from "impair";
import { useTranslation } from "react-i18next";
import { GitCompare, History, RotateCcw } from "lucide-react";
import { cn } from "../../lib/cn";
import { PaywallBuilderViewModel } from "./vm/paywall-builder.vm";

type Props = {
  onClose: () => void;
  onOpenDiff: () => void;
};

/**
 * Publish history dropdown. Versions are immutable except for their
 * label, so the only mutating actions here are "name this version",
 * "revert draft to this version" and "discard draft changes" — none of
 * which touch what devices are currently served.
 */
export const VersionMenu = component(({ onClose, onOpenDiff }: Props) => {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();
  const [labelling, setLabelling] = useState<number | null>(null);
  const [labelDraft, setLabelDraft] = useState("");

  useEffect(() => {
    void vm.loadVersions();
  }, [vm]);

  return (
    <>
      <div className="fixed inset-0 z-[49]" onClick={onClose} />
      <div className="absolute right-0 top-full z-50 mt-1 w-[340px] rounded-lg border border-rv-divider-strong bg-rv-c1 p-1.5 shadow-[0_18px_44px_rgba(0,0,0,0.5)]">
        <div className="mb-1 px-1.5 py-1 font-rv-mono text-[9px] uppercase tracking-wider text-rv-mute-500">
          {t("paywalls.builder.versions.title", "Version history")}
        </div>

        {vm.versions.length === 0 && (
          <div className="px-2 py-3 text-[12px] text-rv-mute-500">
            {t("paywalls.builder.versions.empty", "Nothing published yet.")}
          </div>
        )}

        {vm.versions.map((v) => (
          <div key={v.id} className="flex items-start gap-2 rounded px-2 py-1.5 hover:bg-rv-c2">
            <span className="mt-0.5 min-w-[26px] font-rv-mono text-[11px] text-rv-mute-500">
              v{v.versionNo}
            </span>
            <div className="min-w-0 flex-1">
              {labelling === v.versionNo ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    void vm.labelVersion(v.versionNo, labelDraft.trim() || null);
                    setLabelling(null);
                  }}
                >
                  <input
                    autoFocus
                    value={labelDraft}
                    onChange={(e) => setLabelDraft(e.currentTarget.value)}
                    onBlur={() => setLabelling(null)}
                    placeholder={t("paywalls.builder.versions.labelPlaceholder", "Name this version…")}
                    className="h-6 w-full rounded border border-rv-divider bg-rv-c2 px-1.5 text-[12px] text-foreground outline-none focus:border-rv-accent-500"
                  />
                </form>
              ) : (
                <button
                  type="button"
                  onClick={() => {
                    setLabelDraft(v.label ?? "");
                    setLabelling(v.versionNo);
                  }}
                  className="block w-full cursor-text truncate text-left text-[12px] text-foreground"
                >
                  {v.label ?? t("paywalls.builder.versions.unnamed", "Unnamed version")}
                </button>
              )}
              <div className="mt-0.5 font-rv-mono text-[10px] text-rv-mute-500">
                {new Date(v.publishedAt).toLocaleString()}
              </div>
            </div>
            {v.isLive && (
              <span className="mt-0.5 rounded bg-rv-success/15 px-1.5 py-0.5 font-rv-mono text-[9px] uppercase tracking-wider text-rv-success">
                {t("paywalls.builder.versions.live", "live")}
              </span>
            )}
            {!v.isLive && (
              <button
                type="button"
                title={t("paywalls.builder.versions.revert", "Revert draft to this version")}
                onClick={() => {
                  void vm.revertTo(v.versionNo);
                  onClose();
                }}
                className="mt-0.5 flex h-5 w-5 cursor-pointer items-center justify-center rounded text-rv-mute-500 transition hover:bg-rv-c3 hover:text-foreground"
              >
                <RotateCcw size={11} />
              </button>
            )}
          </div>
        ))}

        <div className="my-1 h-px bg-rv-divider" />

        <button
          type="button"
          onClick={() => {
            onClose();
            onOpenDiff();
          }}
          className="flex w-full cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] text-foreground transition hover:bg-rv-c2"
        >
          <GitCompare size={13} className="text-rv-mute-500" />
          {t("paywalls.builder.versions.diff", "Diff draft vs published")}
        </button>
        <button
          type="button"
          disabled={vm.publishedVersionId === null}
          onClick={() => {
            void vm.discardToPublished();
            onClose();
          }}
          className={cn(
            "flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-[12px] transition",
            vm.publishedVersionId === null
              ? "cursor-not-allowed text-rv-mute-600 opacity-50"
              : "cursor-pointer text-rv-danger hover:bg-rv-danger/10",
          )}
        >
          <History size={13} />
          {t("paywalls.builder.versions.discard", "Discard draft changes")}
        </button>
      </div>
    </>
  );
});
