import { useTranslation } from "react-i18next";
import { Check, X } from "lucide-react";
import { cn } from "../../lib/cn";
import { ExperimentStatusDot } from "./experiment-status-dot";
import { LiftPill } from "./lift-pill";
import type { ExperimentScope, ExperimentSummary } from "./types";

const SCOPES: ReadonlyArray<ExperimentScope> = ["running", "completed", "draft", "all"];

type Props = {
  experiments: ReadonlyArray<ExperimentSummary>;
  scope: ExperimentScope;
  onScopeChange: (next: ExperimentScope) => void;
  selectedId: string;
  onSelect: (id: string) => void;
  scopeCounts: Readonly<Record<ExperimentScope, number>>;
};

/**
 * Sticky 360px sidebar — segmented scope tabs at the top, then a
 * scrollable list of experiment cards. Each card carries the status
 * dot, key, variant count, description, age + assigned users, lift
 * pill, and a confidence track for running experiments (or a
 * win/loss line for completed ones).
 */
export function ExperimentsList({
  experiments,
  scope,
  onScopeChange,
  selectedId,
  onSelect,
  scopeCounts,
}: Props) {
  const { t } = useTranslation();
  return (
    <aside className="sticky top-[76px] flex max-h-[calc(100vh-96px)] flex-col overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
      <div className="flex items-center gap-2 border-b border-rv-divider px-3 py-2.5">
        <div
          role="tablist"
          aria-label={t("experiments.list.scopeAriaLabel")}
          className="inline-flex w-full gap-0.5 rounded-[5px] border border-rv-divider bg-rv-c2 p-0.5"
        >
          {SCOPES.map((s) => {
            const active = s === scope;
            return (
              <button
                key={s}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => onScopeChange(s)}
                className={cn(
                  "inline-flex h-6 flex-1 cursor-pointer items-center justify-center gap-1 rounded-[3px] px-2 text-[11px] transition",
                  active
                    ? "bg-rv-c4 text-foreground"
                    : "text-rv-mute-600 hover:text-foreground",
                )}
              >
                {t(`experiments.list.scope.${s}`)}
                <span
                  className={cn(
                    "font-rv-mono text-[9px] tabular-nums",
                    active ? "text-rv-mute-700" : "text-rv-mute-500",
                  )}
                >
                  {scopeCounts[s]}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {experiments.length === 0 && (
          <div className="px-4 py-6 text-center text-[12px] text-rv-mute-500">
            {t("experiments.list.empty")}
          </div>
        )}
        {experiments.map((e) => {
          const selected = selectedId === e.key;
          return (
            <button
              key={e.id}
              type="button"
              onClick={() => onSelect(e.key)}
              className={cn(
                "block w-full cursor-pointer border-b border-rv-divider px-3.5 py-3 text-left transition last:border-b-0",
                selected
                  ? "bg-rv-accent-500/10 shadow-[inset_2px_0_0_var(--color-rv-accent-500)]"
                  : "hover:bg-rv-c2",
              )}
            >
              <div className="mb-1.5 flex items-center gap-2">
                <ExperimentStatusDot status={e.status} />
                <div className="min-w-0 flex-1 truncate font-rv-mono text-[12px] font-medium text-foreground">
                  {e.key}
                </div>
                <div className="font-rv-mono text-[10px] text-rv-mute-500">
                  {t("experiments.list.variants", { count: e.variantCount })}
                </div>
              </div>
              <div className="mb-1.5 truncate text-[11px] text-rv-mute-600">
                {e.description}
              </div>
              <div className="flex items-center gap-2 font-rv-mono text-[10px] text-rv-mute-500">
                <span>
                  {e.ageLabelValues
                    ? t(e.ageLabelKey, e.ageLabelValues)
                    : t(e.ageLabelKey)}
                </span>
                <span className="text-rv-mute-400">·</span>
                <span>
                  {t("experiments.list.assignedUsers", {
                    count: e.assigned,
                    value: e.assigned.toLocaleString(),
                  })}
                </span>
                {e.lift !== 0 && (
                  <span className="ml-auto">
                    <LiftPill value={e.lift} />
                  </span>
                )}
              </div>
              {e.status === "running" && (
                <div className="mt-2 h-[3px] overflow-hidden rounded-full bg-rv-c3">
                  <span
                    className={cn(
                      "block h-full rounded-full transition-[width] duration-200 ease-out",
                      e.outcome === "win" && "bg-rv-success",
                      e.outcome === "loss" && "bg-rv-danger",
                      !e.outcome && "bg-rv-accent-500",
                    )}
                    style={{ width: `${e.confidence * 100}%` }}
                  />
                </div>
              )}
              {e.status === "completed" && e.winner && (
                <div
                  className={cn(
                    "mt-2 inline-flex items-center gap-1 font-rv-mono text-[10px]",
                    e.outcome === "win" ? "text-rv-success" : "text-rv-danger",
                  )}
                >
                  {e.outcome === "win" ? <Check size={10} /> : <X size={10} />}
                  {e.winner === "control"
                    ? t("experiments.list.keptControl")
                    : t("experiments.list.shippedWinner", { id: e.winner })}
                </div>
              )}
            </button>
          );
        })}
      </div>
    </aside>
  );
}
