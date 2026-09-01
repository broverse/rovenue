import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { CheckCircle2, Clock, Scale, ShieldAlert } from "lucide-react";
import type {
  ExperimentDecisionGate,
  ExperimentResultsResponse,
} from "@rovenue/shared";
import { cn } from "../../lib/cn";
import { decisionState } from "./format";
import { LiftPill } from "./lift-pill";
import type { ExperimentSummary } from "./types";

type Props = {
  experiment: ExperimentSummary;
  /**
   * Null when there's no live results yet (ClickHouse unconfigured or
   * zero exposures) — every analysis row below degrades to an explicit
   * "not available yet" string rather than a fabricated pass/fail.
   */
  results: ExperimentResultsResponse | null;
};

/**
 * Per-gate copy for the `blockedBy` list, in the operator's own words —
 * not the enum name. Rendered for EVERY gate in the array, in evaluation
 * order, never just `blockedBy[0]` (see the doc comment on
 * `ExperimentDecisionGate`).
 */
const BLOCKED_BY_KEYS: Record<ExperimentDecisionGate, string> = {
  SAMPLE_SIZE: "experiments.analysis.blockedBy.SAMPLE_SIZE",
  RUNTIME: "experiments.analysis.blockedBy.RUNTIME",
  EXPECTED_LOSS: "experiments.analysis.blockedBy.EXPECTED_LOSS",
  NO_LEADER: "experiments.analysis.blockedBy.NO_LEADER",
  PROCEEDS_RATE_UNCONFIGURED:
    "experiments.analysis.blockedBy.PROCEEDS_RATE_UNCONFIGURED",
  SRM: "experiments.analysis.blockedBy.SRM",
  CROSSOVER: "experiments.analysis.blockedBy.CROSSOVER",
  REFUND_GUARDRAIL: "experiments.analysis.blockedBy.REFUND_GUARDRAIL",
};

const DECISION_STYLES = {
  ship: {
    icon: CheckCircle2,
    tone: "border-rv-success/30 bg-rv-success/10 text-rv-success",
  },
  insufficientData: {
    icon: Clock,
    tone: "border-rv-divider bg-rv-c2 text-rv-mute-600",
  },
  noDifference: {
    icon: Scale,
    tone: "border-rv-warning/30 bg-rv-warning/10 text-rv-warning",
  },
  integrityBlocked: {
    icon: ShieldAlert,
    tone: "border-rv-danger/30 bg-rv-danger/10 text-rv-danger",
  },
} as const;

/**
 * The "is this experiment trustworthy" signals from
 * `computeExperimentResults` — pairwise conversion significance (fixed-
 * horizon, cross-check only), the SRM guardrail, sample-size progress,
 * the assumption-free Welch cross-check, and the decision engine's own
 * verdict (ship / still gathering data / no meaningful difference /
 * blocked on a data-integrity gate) with every blocking reason spelled
 * out. Replaces the old mock `ConfigurationCard`: owner / segments /
 * allocation-key were never backed by a real field (the experiment
 * schema has no such columns), so rather than leave a placeholder for
 * data that will never exist, that card is gone.
 */
export function ExperimentAnalysisCard({ experiment, results }: Props) {
  const { t } = useTranslation();
  // `conversion` (a pairwise stat over exactly two variants) is computed
  // from the exposure-join heuristic server-side regardless of
  // experiment type — unlike `attributedConversions` it isn't PAYWALL-
  // gated, so it's shown whenever the endpoint returns one. This is a
  // FIXED-HORIZON frequentist cross-check, valid only at the planned
  // sample size — the recommendation below is never made on it.
  const conversion = results?.conversion ?? null;
  const srm = results?.integrity.srm ?? null;
  const sampleSize = results?.sampleSize ?? null;
  const recommendation = results?.recommendation ?? null;
  const crossCheck = results?.crossCheck ?? null;
  const state = recommendation ? decisionState(recommendation) : null;
  const decisionStyle = state ? DECISION_STYLES[state] : null;
  const DecisionIcon = decisionStyle?.icon;

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4">
      <h3 className="m-0 mb-3 text-[14px] font-semibold">
        {t("experiments.analysis.title")}
      </h3>
      <Kv k={t("experiments.analysis.metric")} v={experiment.metric || "—"} />
      <Kv
        k={t("experiments.analysis.conversion")}
        v={
          conversion ? (
            <span className="inline-flex items-center gap-1.5">
              <LiftPill value={conversion.relativeLift * 100} inline />
              <span className="text-rv-mute-500">
                p={conversion.pValue.toFixed(3)}
              </span>
            </span>
          ) : (
            <Muted>{t("experiments.analysis.conversionUnavailable")}</Muted>
          )
        }
      />
      <Kv
        k={t("experiments.analysis.srm")}
        v={
          srm ? (
            <span className={srm.isMismatch ? "text-rv-danger" : "text-rv-success"}>
              {srm.isMismatch
                ? t("experiments.analysis.srmMismatch", {
                    pValue: srm.pValue.toFixed(3),
                  })
                : t("experiments.analysis.srmPassed", {
                    pValue: srm.pValue.toFixed(3),
                  })}
            </span>
          ) : (
            <Muted>{t("experiments.analysis.srmUnavailable")}</Muted>
          )
        }
      />
      <Kv
        k={t("experiments.analysis.sampleSize")}
        v={
          sampleSize ? (
            <span
              className={
                sampleSize.reached ? "text-rv-success" : "text-rv-mute-500"
              }
            >
              {t("experiments.analysis.sampleSizeProgress", {
                required: sampleSize.required.toLocaleString(),
                reached: sampleSize.reached
                  ? t("experiments.analysis.sampleSizeReached")
                  : t("experiments.analysis.sampleSizeNotReached"),
              })}
            </span>
          ) : (
            <Muted>{t("experiments.analysis.sampleSizeUnavailable")}</Muted>
          )
        }
      />

      {crossCheck && (
        <Kv
          k={t("experiments.analysis.crossCheck.title")}
          v={
            <span
              className={cn(
                "inline-flex flex-col items-end gap-0.5",
                crossCheck.signDisagreement && "text-rv-warning",
              )}
            >
              <span>
                {t("experiments.analysis.crossCheck.posterior")}{" "}
                {formatSignedPct(crossCheck.posteriorRelativeLift)}
                {" · "}
                {t("experiments.analysis.crossCheck.welch")}{" "}
                {formatSignedPct(crossCheck.welchRelativeLift)}
              </span>
              {crossCheck.signDisagreement && (
                <span className="text-[10px] font-normal normal-case text-rv-warning">
                  {t("experiments.analysis.crossCheck.disagreement")}
                </span>
              )}
            </span>
          }
        />
      )}

      {recommendation && state && decisionStyle && (
        <div
          className={cn(
            "mt-3 rounded-md border px-3 py-2.5 text-[12px]",
            decisionStyle.tone,
          )}
        >
          <div className="flex items-center gap-2 font-medium">
            {DecisionIcon && <DecisionIcon size={14} className="flex-shrink-0" />}
            <span>{t(`experiments.analysis.decision.${state}`)}</span>
          </div>
          {recommendation.blockedBy.length > 0 && (
            <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-[11px] font-normal text-rv-mute-600">
              {recommendation.blockedBy.map((gate) => (
                <li key={gate}>{t(BLOCKED_BY_KEYS[gate])}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

function formatSignedPct(value: number | null): string {
  if (value === null) return "—";
  const pct = value * 100;
  return `${pct > 0 ? "+" : ""}${pct.toFixed(1)}%`;
}

function Muted({ children }: { children: ReactNode }) {
  return <span className="text-rv-mute-500">{children}</span>;
}

function Kv({ k, v }: { k: string; v: ReactNode }) {
  return (
    <div className="flex items-center justify-between border-b border-white/[0.04] py-1.5 text-[12px] last:border-b-0">
      <span className="text-rv-mute-500">{k}</span>
      <span className="font-rv-mono text-[11px] text-foreground">{v}</span>
    </div>
  );
}
