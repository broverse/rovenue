import { ArrowRight } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import type { Rule } from "./types";

type Props = {
  rule: Rule;
  index: number;
};

/**
 * One row in the targeting rules list. Match rules show their conditions as
 * a stack of attr/op/value chips and the served value; default rules omit
 * the conditions and render with a muted left-border.
 */
export function RuleCard({ rule, index }: Props) {
  const { t } = useTranslation();
  const isDefault = rule.type === "default";

  const serveTone =
    rule.serve === "true"
      ? "border-rv-success/30 bg-rv-success/15 text-rv-success"
      : rule.serve === "false"
        ? "border-rv-danger/30 bg-rv-danger/15 text-rv-danger"
        : "border-rv-accent-500/30 bg-rv-accent-500/15 text-rv-accent-400";

  return (
    <div
      className={cn(
        "rounded-md border border-rv-divider bg-rv-c2 px-3 py-3",
        isDefault
          ? "border-l-[3px] border-l-rv-mute-400"
          : "border-l-[3px] border-l-rv-accent-500",
      )}
    >
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-wider text-rv-mute-600">
          {isDefault
            ? t("featureFlags.rules.defaultLabel")
            : t("featureFlags.rules.matchLabel")}
        </span>
        <span className="rounded border border-rv-divider bg-rv-c3 px-1.5 py-px font-rv-mono text-[10px] text-rv-mute-500">
          {isDefault ? t("featureFlags.rules.elseOrdinal") : index + 1}
        </span>
      </div>

      {!isDefault && rule.conditions.length > 0 && (
        <div className="mt-1 flex flex-col gap-1.5">
          {rule.conditions.map((c, j) => (
            <div
              key={j}
              className="flex items-center gap-1.5 rounded border border-rv-divider bg-rv-c3 px-2 py-1 font-rv-mono text-[11px]"
            >
              <span className="text-rv-accent-400">{c.attribute}</span>
              <span className="text-rv-mute-500">{c.op}</span>
              <span className="text-foreground">{c.value}</span>
            </div>
          ))}
        </div>
      )}

      <div className="mt-2.5 flex items-center gap-2 border-t border-white/[0.06] pt-2.5">
        <span className="text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
          {t("featureFlags.rules.serve")}
        </span>
        <ArrowRight size={11} className="text-rv-mute-400" />
        <span
          className={cn(
            "rounded border px-2 py-px font-rv-mono text-[12px] font-medium",
            serveTone,
          )}
        >
          {rule.serve}
        </span>
        {!isDefault && rule.rolloutPct != null && rule.rolloutPct < 100 && (
          <span className="ml-auto font-rv-mono text-[10px] text-rv-mute-500">
            {t("featureFlags.rules.partialRollout", { pct: rule.rolloutPct })}
          </span>
        )}
      </div>
    </div>
  );
}
