import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { EvalSparkline } from "./eval-sparkline";
import { FlagToggle } from "./flag-toggle";
import { RolloutBar } from "./rollout-bar";
import { TagPill } from "./tag-pill";
import { TypeBadge } from "./type-badge";
import { formatEvalCount } from "./format";
import type { FeatureFlag } from "./types";

type Props = {
  flag: FeatureFlag;
  index: number;
  selected: boolean;
  onSelect: () => void;
  onToggle: () => void;
};

const GRID = "grid-cols-[28px_minmax(0,1fr)_140px_140px_120px_60px]";

export function FlagRow({ flag, index, selected, onSelect, onToggle }: Props) {
  const { t } = useTranslation();

  const sparkColor = flag.killed
    ? "var(--color-rv-danger)"
    : flag.enabled
      ? "var(--color-rv-accent-500)"
      : "var(--color-rv-mute-500)";

  const rolloutLabel = flag.killed
    ? t("featureFlags.row.killed")
    : `${flag.rolloutPct}%`;
  const rolloutColor = flag.killed
    ? "text-rv-danger"
    : flag.rolloutPct === 100
      ? "text-rv-success"
      : "text-foreground";

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "grid items-center gap-3.5 border-b border-rv-divider px-4 py-3 transition",
        GRID,
        "cursor-pointer hover:bg-rv-c2",
        selected &&
          "bg-rv-accent-500/[0.08] shadow-[inset_2px_0_0_var(--color-rv-accent-500)]",
      )}
    >
      <TypeBadge type={flag.type} />

      <div className="min-w-0">
        <div className="truncate font-rv-mono text-[13px] font-medium">
          {flag.key}
        </div>
        <div className="mt-0.5 truncate text-[11px] text-rv-mute-500">
          {flag.description}
        </div>
        <div className="mt-1 flex flex-wrap gap-1">
          <TagPill
            tone={flag.env === "prod" ? "env-prod" : "env-staging"}
          >
            {flag.env}
          </TagPill>
          {flag.linkedExperiment && (
            <TagPill tone="linked-experiment">
              {t("featureFlags.row.expPrefix")} {flag.linkedExperiment}
            </TagPill>
          )}
          {flag.tags.slice(0, 2).map((tag) => (
            <TagPill key={tag}>{tag}</TagPill>
          ))}
        </div>
      </div>

      <div>
        <div className="flex items-center justify-between font-rv-mono text-[11px]">
          <span className={rolloutColor}>{rolloutLabel}</span>
          {flag.variants && (
            <span className="text-rv-mute-500">
              {t("featureFlags.row.nWay", { count: flag.variants.length })}
            </span>
          )}
        </div>
        <RolloutBar
          pct={flag.rolloutPct}
          killed={flag.killed}
          className="mt-1.5"
        />
      </div>

      <div>
        <div className="font-rv-mono text-[12px] tabular-nums">
          {formatEvalCount(flag.evals24h)}
        </div>
        <div className="mt-0.5">
          <EvalSparkline seed={index} color={sparkColor} />
        </div>
      </div>

      <div className="font-rv-mono text-[11px]">
        <div>{flag.lastChanged}</div>
        <div className="text-[10px] text-rv-mute-500">@{flag.by}</div>
      </div>

      <div className="flex justify-end">
        <FlagToggle
          enabled={flag.enabled}
          killed={flag.killed}
          onToggle={onToggle}
          title={
            flag.killed
              ? t("featureFlags.row.toggleKilledTitle")
              : flag.enabled
                ? t("featureFlags.row.toggleOnTitle")
                : t("featureFlags.row.toggleOffTitle")
          }
        />
      </div>
    </div>
  );
}

FlagRow.GRID = GRID;
