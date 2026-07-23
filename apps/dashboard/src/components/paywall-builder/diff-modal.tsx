import { useEffect } from "react";
import { component, useService } from "impair";
import { useTranslation } from "react-i18next";
import { ArrowRight, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { PaywallBuilderViewModel } from "./vm/paywall-builder.vm";

type Props = { onClose: () => void };

const KIND_CLASS: Record<string, string> = {
  added: "bg-rv-success/15 text-rv-success",
  removed: "bg-rv-danger/15 text-rv-danger",
  changed: "bg-rv-warning/15 text-rv-warning",
};

/**
 * "What ships when I hit Publish" — the published version on the left,
 * the draft on the right. Entries come from `diffBuilderConfigs` on the
 * server so this component never has to reimplement tree comparison.
 */
export const DiffModal = component(({ onClose }: Props) => {
  const vm = useService(PaywallBuilderViewModel);
  const { t } = useTranslation();

  useEffect(() => {
    void vm.loadDiff();
  }, [vm]);

  const diff = vm.diffResult;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-6"
      onClick={onClose}
    >
      <div
        className="flex max-h-[84vh] w-[min(680px,94vw)] flex-col rounded-xl border border-rv-divider-strong bg-rv-c1 shadow-[0_30px_80px_rgba(0,0,0,0.6)]"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start gap-3 border-b border-rv-divider px-5 py-4">
          <div className="flex-1">
            <h2 className="text-[15px] font-semibold text-foreground">
              {diff
                ? t("paywalls.builder.diff.title", "Published v{{from}} → draft", {
                    from: diff.from.versionNo ?? "—",
                  })
                : t("paywalls.builder.diff.loading", "Comparing…")}
            </h2>
            <p className="mt-0.5 text-[12px] text-rv-mute-500">
              {diff
                ? t("paywalls.builder.diff.subtitle", {
                    count: diff.entries.length,
                    defaultValue: "{{count}} change ships when you publish.",
                    defaultValue_other: "{{count}} changes ship when you publish.",
                  })
                : ""}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 cursor-pointer items-center justify-center rounded-md text-rv-mute-600 transition hover:bg-rv-c2 hover:text-foreground"
          >
            <X size={16} />
          </button>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          {diff && diff.entries.length === 0 && (
            <div className="py-8 text-center text-[13px] text-rv-mute-500">
              {t("paywalls.builder.diff.none", "The draft matches the published version.")}
            </div>
          )}
          {diff?.entries.map((e, i) => (
            <div
              key={`${e.scope}-${e.nodeId ?? ""}-${e.field}-${i}`}
              className="flex items-start gap-3 border-b border-rv-divider py-2.5 last:border-b-0"
            >
              <span
                className={cn(
                  "mt-0.5 rounded px-1.5 py-0.5 font-rv-mono text-[9px] uppercase tracking-wider",
                  KIND_CLASS[e.kind],
                )}
              >
                {e.kind}
              </span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] text-foreground">
                  {e.nodeId
                    ? `${e.nodeType ?? "node"} · ${e.nodeId}`
                    : t(`paywalls.builder.diff.scope.${e.scope}`, e.scope)}
                </div>
                <div className="truncate font-rv-mono text-[10px] text-rv-mute-500">
                  {e.field}
                </div>
                <div className="mt-1 flex items-center gap-2 font-rv-mono text-[11px]">
                  {e.from !== null && (
                    <span className="truncate rounded bg-rv-danger/10 px-1.5 py-0.5 text-rv-danger line-through">
                      {e.from}
                    </span>
                  )}
                  {e.from !== null && e.to !== null && (
                    <ArrowRight size={11} className="flex-shrink-0 text-rv-mute-500" />
                  )}
                  {e.to !== null && (
                    <span className="truncate rounded bg-rv-success/10 px-1.5 py-0.5 text-rv-success">
                      {e.to}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-rv-divider px-5 py-3">
          <button
            type="button"
            onClick={onClose}
            className="inline-flex h-8 cursor-pointer items-center rounded-md border border-rv-divider bg-rv-c2 px-3 text-[12px] text-foreground transition hover:bg-rv-c3"
          >
            {t("paywalls.builder.diff.close", "Close")}
          </button>
          <button
            type="button"
            disabled={!vm.canPublish}
            onClick={() => {
              void vm.publish();
              onClose();
            }}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-md px-3 text-[12px] font-medium transition",
              vm.canPublish
                ? "cursor-pointer bg-rv-accent-500 text-white hover:bg-rv-accent-600"
                : "cursor-not-allowed bg-rv-c2 text-rv-mute-600 opacity-60",
            )}
          >
            {t("paywalls.builder.diff.publish", "Publish these changes")}
          </button>
        </div>
      </div>
    </div>
  );
});
