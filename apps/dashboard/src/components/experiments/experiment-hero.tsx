import { Trans, useTranslation } from "react-i18next";
import {
  AlertTriangle,
  Check,
  Copy,
  MoreHorizontal,
  RotateCcw,
} from "lucide-react";
import { Button } from "../../ui/button";
import { cn } from "../../lib/cn";
import { ExperimentStatusChip } from "./experiment-status-chip";
import { ExperimentStatusDot } from "./experiment-status-dot";
import type { ExperimentSummary } from "./types";

type Props = {
  experiment: ExperimentSummary;
};

/**
 * Hero panel above the variant comparison — title-line metadata,
 * action buttons, 5-up KPI strip, and an optional "ship winner" banner
 * when confidence ≥ 80% and no winner has been shipped yet.
 */
export function ExperimentHero({ experiment }: Props) {
  const { t } = useTranslation();
  const ageLabel = experiment.ageLabelValues
    ? t(experiment.ageLabelKey, experiment.ageLabelValues)
    : t(experiment.ageLabelKey);
  const isRunning = experiment.status === "running";
  const isCompleted = experiment.status === "completed";
  const showWinner =
    experiment.confidence >= 0.8 && !experiment.winner && experiment.status === "running";

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-5">
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="mb-2 flex items-center gap-2.5 font-rv-mono text-[11px] text-rv-mute-500">
            <ExperimentStatusDot status={experiment.status} />
            <ExperimentStatusChip status={experiment.status} />
            <span>·</span>
            <span>{t(`experiments.groups.${experiment.group}`)}</span>
            <span>·</span>
            <span>
              {t("experiments.hero.metricLabel")}{" "}
              <span className="text-foreground">{experiment.metric}</span>
            </span>
          </div>
          <h1 className="m-0 mb-1.5 font-rv-mono text-[22px] font-semibold leading-tight tracking-tight">
            {experiment.id}
          </h1>
          <p className="max-w-[640px] text-[13px] text-rv-mute-600">
            {experiment.description}
          </p>
        </div>
        <div className="flex flex-shrink-0 gap-1.5">
          <Button variant="flat">
            <Copy size={13} />
            {t("experiments.actions.duplicate")}
          </Button>
          {isRunning && (
            <>
              <Button variant="flat">
                <AlertTriangle size={13} />
                {t("experiments.actions.stop")}
              </Button>
              <Button variant="solid-primary">
                <Check size={13} />
                {t("experiments.actions.shipWinner")}
              </Button>
            </>
          )}
          {isCompleted && (
            <Button variant="solid-primary">
              <RotateCcw size={13} />
              {t("experiments.actions.rerun")}
            </Button>
          )}
          <Button
            variant="light"
            size="icon"
            aria-label={t("experiments.actions.more")}
          >
            <MoreHorizontal size={14} />
          </Button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3.5 border-t border-rv-divider pt-4 md:grid-cols-5">
        <HeroMeta label={t("experiments.hero.meta.started")} value={experiment.started ?? "—"} detail={ageLabel} />
        <HeroMeta
          label={t("experiments.hero.meta.assigned")}
          value={experiment.assigned.toLocaleString()}
          detail={t("experiments.hero.meta.acrossVariants", { count: experiment.variantCount })}
        />
        <HeroMeta
          label={t("experiments.hero.meta.confidence")}
          value={
            <span
              className={cn(
                experiment.confidence >= 0.8 ? "text-rv-success" : "text-foreground",
              )}
            >
              {(experiment.confidence * 100).toFixed(0)}%
            </span>
          }
          detail={t("experiments.hero.meta.confidenceTarget")}
        />
        <HeroMeta
          label={t("experiments.hero.meta.lift")}
          value={
            <span
              className={cn(
                experiment.lift > 0 && "text-rv-success",
                experiment.lift < 0 && "text-rv-danger",
                experiment.lift === 0 && "text-rv-mute-500",
              )}
            >
              {experiment.lift > 0 ? "+" : ""}
              {experiment.lift.toFixed(1)}%
            </span>
          }
          detail={t("experiments.hero.meta.vsControl")}
        />
        <HeroMeta
          label={t("experiments.hero.meta.power")}
          value="0.92"
          detail={t("experiments.hero.meta.powerDetail")}
        />
      </div>

      {showWinner && (
        <div className="mt-3.5 flex items-center gap-3 rounded-md border border-rv-success/30 bg-rv-success/10 px-3.5 py-2.5">
          <span className="inline-flex size-6 flex-shrink-0 items-center justify-center rounded-md bg-rv-success font-rv-mono text-[11px] font-bold text-white">
            <Check size={12} />
          </span>
          <div className="flex-1 text-[12px] text-rv-mute-600">
            <Trans
              i18nKey="experiments.hero.winnerBanner.message"
              values={{
                confidence: (experiment.confidence * 100).toFixed(0),
                variant: "variant_b",
              }}
              components={[
                <b key="v" className="font-rv-mono text-foreground" />,
                <b key="c" className="font-rv-mono text-foreground" />,
              ]}
            />
            <div className="mt-0.5 text-[11px] text-rv-mute-600">
              {t("experiments.hero.winnerBanner.sub", {
                lift: experiment.lift.toFixed(1),
                metric: experiment.metric,
              })}
            </div>
          </div>
          <Button variant="solid-primary">
            <Check size={13} />
            {t("experiments.hero.winnerBanner.cta", { variant: "variant_b" })}
          </Button>
        </div>
      )}
    </section>
  );
}

type HeroMetaProps = {
  label: string;
  value: React.ReactNode;
  detail: string;
};

function HeroMeta({ label, value, detail }: HeroMetaProps) {
  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
        {label}
      </div>
      <div className="mt-1 font-rv-mono text-[14px] font-medium tabular-nums">
        {value}
      </div>
      <div className="mt-0.5 font-rv-mono text-[10px] text-rv-mute-500">
        {detail}
      </div>
    </div>
  );
}
