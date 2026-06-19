import { useNavigate } from "@tanstack/react-router";
import { Trans, useTranslation } from "react-i18next";
import {
  Check,
  CircleStop,
  Copy,
  LineChart,
  MoreHorizontal,
  Pause,
  Pencil,
  Play,
  RotateCcw,
  Trash2,
} from "lucide-react";
import { Button } from "../../ui/button";
import {
  Menu,
  MenuItem,
  MenuSeparator,
  MenuTriggerButton,
} from "../../ui/menu";
import { cn } from "../../lib/cn";
import {
  useDeleteExperiment,
  useDuplicateExperiment,
  usePauseExperiment,
  useResumeExperiment,
  useStopExperiment,
} from "../../lib/hooks/useExperiments";
import { ExperimentStatusChip } from "./experiment-status-chip";
import { ExperimentStatusDot } from "./experiment-status-dot";
import type { ExperimentSummary } from "./types";

type Props = {
  experiment: ExperimentSummary;
  projectId: string;
  /**
   * Render the "View details" link in the action row. Set on the inline
   * experiments-list panel so paused/stopped experiments (which have no
   * primary lifecycle button) still have a way into the focused detail
   * page. Omitted on the detail page itself — it would self-link.
   */
  showDetailsLink?: boolean;
};

/**
 * Hero panel above the variant comparison — title-line metadata,
 * action buttons, 5-up KPI strip, and an optional "ship winner" banner
 * when confidence ≥ 80% and no winner has been shipped yet.
 *
 * Action layout (by status) — lifecycle verbs mirror the edit-page
 * LifecycleBar state machine (RUNNING → Pause/Complete, PAUSED →
 * Resume/Complete) so both surfaces drive the same transitions:
 *   draft     → Edit primary · ⋯ menu (Duplicate, Delete)
 *   running   → Pause · Complete · (Ship winner when a leader exists) · ⋯
 *   paused    → Resume · Complete · ⋯ menu (Duplicate)
 *   completed → Re-run · ⋯ menu (Duplicate)
 */
export function ExperimentHero({
  experiment,
  projectId,
  showDetailsLink = false,
}: Props) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const duplicate = useDuplicateExperiment();
  const remove = useDeleteExperiment();
  const pause = usePauseExperiment();
  const resume = useResumeExperiment();
  const stop = useStopExperiment();

  const ageLabel = experiment.ageLabelValues
    ? t(experiment.ageLabelKey, experiment.ageLabelValues)
    : t(experiment.ageLabelKey);
  const isRunning = experiment.status === "running";
  const isCompleted = experiment.status === "completed";
  const isDraft = experiment.status === "draft";
  const isPaused = experiment.status === "paused";
  // Any in-flight lifecycle mutation locks the whole action row so the
  // experiment can't be driven through two transitions at once.
  const lifecycleBusy =
    pause.isPending || resume.isPending || stop.isPending;
  // "Ship winner" can only promote a concrete variant; until the results
  // endpoint hydrates a leader (Phase 3) there's nothing to ship.
  const canShipWinner =
    isRunning && !experiment.winner && experiment.leadingVariant !== null;
  const showWinner =
    experiment.confidence >= 0.8 &&
    !experiment.winner &&
    experiment.status === "running" &&
    experiment.leadingVariant !== null;

  const handleEdit = () => {
    void navigate({
      to: "/projects/$projectId/experiments/$experimentId/edit",
      params: { projectId, experimentId: experiment.id },
    });
  };

  const handleViewDetails = () => {
    void navigate({
      to: "/projects/$projectId/experiments/$experimentId",
      params: { projectId, experimentId: experiment.id },
    });
  };

  const handlePause = async () => {
    try {
      await pause.mutateAsync(experiment.id);
    } catch (err) {
      window.alert(
        err instanceof Error
          ? err.message
          : t("experiments.lifecycle.pauseFailed"),
      );
    }
  };

  const handleResume = async () => {
    try {
      await resume.mutateAsync(experiment.id);
    } catch (err) {
      window.alert(
        err instanceof Error
          ? err.message
          : t("experiments.lifecycle.resumeFailed"),
      );
    }
  };

  const handleComplete = async () => {
    const confirmed = window.confirm(
      t("experiments.lifecycle.stopConfirm", { name: experiment.key }),
    );
    if (!confirmed) return;
    try {
      await stop.mutateAsync({ id: experiment.id });
    } catch (err) {
      window.alert(
        err instanceof Error
          ? err.message
          : t("experiments.lifecycle.stopFailed"),
      );
    }
  };

  const handleShipWinner = async () => {
    const winner = experiment.leadingVariant;
    if (!winner) return;
    const confirmed = window.confirm(
      t("experiments.hero.shipConfirm", { variant: winner }),
    );
    if (!confirmed) return;
    try {
      await stop.mutateAsync({
        id: experiment.id,
        body: { winnerVariantId: winner, promoteToFlag: true },
      });
    } catch (err) {
      window.alert(
        err instanceof Error
          ? err.message
          : t("experiments.lifecycle.stopFailed"),
      );
    }
  };

  const handleDuplicate = async () => {
    try {
      const res = await duplicate.mutateAsync(experiment.id);
      void navigate({
        to: "/projects/$projectId/experiments",
        params: { projectId },
        search: { selected: res.experiment.key, scope: "draft" },
      });
    } catch (err) {
      // Surface via window.alert — matches the project's existing
      // approach for destructive/lifecycle errors (no toast system).
      window.alert(
        err instanceof Error
          ? err.message
          : t("experiments.actions.duplicateFailed"),
      );
    }
  };

  const handleDelete = async () => {
    const confirmed = window.confirm(
      t("experiments.actions.deleteConfirm", { name: experiment.key }),
    );
    if (!confirmed) return;
    try {
      await remove.mutateAsync(experiment.id);
      void navigate({
        to: "/projects/$projectId/experiments",
        params: { projectId },
        search: {},
        replace: true,
      });
    } catch (err) {
      window.alert(
        err instanceof Error
          ? err.message
          : t("experiments.actions.deleteFailed"),
      );
    }
  };

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
            {experiment.key}
          </h1>
          <p className="max-w-[640px] text-[13px] text-rv-mute-600">
            {experiment.description}
          </p>
        </div>
        <div className="flex flex-shrink-0 gap-1.5">
          {showDetailsLink && !isRunning && (
            <Button variant="flat" onClick={handleViewDetails}>
              <LineChart size={13} />
              {t("experiments.actions.viewDetails")}
            </Button>
          )}
          {isDraft && (
            <Button variant="solid-primary" onClick={handleEdit}>
              <Pencil size={13} />
              {t("experiments.actions.edit")}
            </Button>
          )}
          {isRunning && (
            <>
              <Button
                variant="flat"
                onClick={handlePause}
                disabled={lifecycleBusy}
              >
                <Pause size={13} />
                {t("experiments.lifecycle.pause")}
              </Button>
              <Button
                variant="flat"
                onClick={handleComplete}
                disabled={lifecycleBusy}
              >
                <CircleStop size={13} />
                {t("experiments.lifecycle.complete")}
              </Button>
              {canShipWinner && (
                <Button
                  variant="solid-primary"
                  onClick={handleShipWinner}
                  disabled={lifecycleBusy}
                >
                  <Check size={13} />
                  {t("experiments.actions.shipWinner")}
                </Button>
              )}
            </>
          )}
          {isPaused && (
            <>
              <Button
                variant="solid-primary"
                onClick={handleResume}
                disabled={lifecycleBusy}
              >
                <Play size={13} />
                {t("experiments.lifecycle.resume")}
              </Button>
              <Button
                variant="flat"
                onClick={handleComplete}
                disabled={lifecycleBusy}
              >
                <CircleStop size={13} />
                {t("experiments.lifecycle.complete")}
              </Button>
            </>
          )}
          {isCompleted && (
            <Button
              variant="solid-primary"
              onClick={handleDuplicate}
              disabled={duplicate.isPending}
            >
              <RotateCcw size={13} />
              {t("experiments.actions.rerun")}
            </Button>
          )}
          <Menu
            align="end"
            trigger={() => (
              <MenuTriggerButton ariaLabel={t("experiments.actions.more")}>
                <MoreHorizontal size={14} />
              </MenuTriggerButton>
            )}
          >
            {(close) => (
              <>
                <MenuItem
                  icon={<Copy size={12} />}
                  disabled={duplicate.isPending}
                  onClick={() => {
                    close();
                    void handleDuplicate();
                  }}
                >
                  {t("experiments.actions.duplicate")}
                </MenuItem>
                {isDraft && (
                  <>
                    <MenuSeparator />
                    <MenuItem
                      icon={<Trash2 size={12} />}
                      tone="danger"
                      disabled={remove.isPending}
                      onClick={() => {
                        close();
                        void handleDelete();
                      }}
                    >
                      {t("experiments.actions.delete")}
                    </MenuItem>
                  </>
                )}
              </>
            )}
          </Menu>
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
                variant: experiment.leadingVariant ?? "",
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
          <Button
            variant="solid-primary"
            onClick={handleShipWinner}
            disabled={lifecycleBusy}
          >
            <Check size={13} />
            {t("experiments.hero.winnerBanner.cta", {
              variant: experiment.leadingVariant ?? "",
            })}
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
