import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ExperimentResultsResponse } from "@rovenue/shared";
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
 * The three "is this experiment trustworthy" signals from
 * `computeExperimentResults` — pairwise conversion significance, the
 * SRM guardrail, and sample-size progress — plus the experiment's own
 * metric name. Replaces the old mock `ConfigurationCard`: owner /
 * segments / allocation-key were never backed by a real field (the
 * experiment schema has no such columns), so rather than leave a
 * placeholder for data that will never exist, that card is gone.
 */
export function ExperimentAnalysisCard({ experiment, results }: Props) {
  const { t } = useTranslation();
  // `conversion` (a pairwise stat over exactly two variants) is computed
  // from the exposure-join heuristic server-side regardless of
  // experiment type — unlike `attributedConversions` it isn't PAYWALL-
  // gated, so it's shown whenever the endpoint returns one.
  const conversion = results?.conversion ?? null;
  const srm = results?.srm ?? null;
  const sampleSize = results?.sampleSize ?? null;

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
    </section>
  );
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
