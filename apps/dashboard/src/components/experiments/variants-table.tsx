import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { variantColor } from "./format";
import type { ResultVariantRow } from "./types";

type Props = {
  variants: ReadonlyArray<ResultVariantRow>;
  /**
   * Shows the precisely-attributed conversions + derived-rate columns —
   * only meaningful for PAYWALL-type experiments (see
   * `isPaywallExperimentGroup`). Other experiment types have no
   * per-variant conversion signal in the live payload at all, so the
   * columns are hidden rather than shown empty.
   */
  showAttributed: boolean;
};

/** Posterior columns span the width of the five data columns below when a
 *  variant lacks the data to fit them — one merged "not enough data yet"
 *  cell rather than five separate dashes that would read as five computed
 *  zeroes. */
const POSTERIOR_COLUMN_COUNT = 4;

/**
 * Live variant comparison table.
 *
 * THREE DENOMINATORS APPEAR HERE, and they are deliberately all visible:
 *
 *   Users     exposed subscribers, un-windowed. What SRM checks the split
 *             of, and nothing else.
 *   Mature    exposed subscribers whose maturation window has elapsed and
 *             who saw only one variant. THE metric denominator — every
 *             posterior column to its right was fitted on this number, and
 *             "Conv. rate" is over it.
 *   Excluded  the difference, split into the two reasons for it. Mature +
 *             immature + crossover accounts for every exposed subscriber.
 *
 * Showing `Users 20 000` beside a posterior fitted on 6 000 mature
 * subscribers, with no way to tell, was the seam this table used to hide.
 * The attributed-conversion rate (PAYWALL only) is a fourth quantity —
 * precisely-attributed purchases over exposed users — and is labelled as
 * its own column rather than merged into the windowed rate.
 *
 * Every number comes straight off `ExperimentResultsResponse`; there's no
 * per-variant ARPU/lift/CI beyond what's rendered, so nothing is fabricated.
 */
export function VariantsTable({ variants, showAttributed }: Props) {
  const { t } = useTranslation();
  return (
    <section className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
      <header className="flex items-center justify-between border-b border-rv-divider px-5 py-3.5">
        <h3 className="m-0 text-[14px] font-semibold">
          {t("experiments.variants.title")}
        </h3>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr>
              <Th width="22%">{t("experiments.variants.cols.variant")}</Th>
              <Th align="right">{t("experiments.variants.cols.exposures")}</Th>
              <Th align="right">{t("experiments.variants.cols.users")}</Th>
              <Th align="right">
                {t("experiments.variants.cols.matureUsers", "Mature")}
              </Th>
              <Th align="right">
                {t("experiments.variants.cols.excluded", "Excluded")}
              </Th>
              <Th align="right">
                {t("experiments.variants.cols.conversionRate", "Conv. rate")}
              </Th>
              {showAttributed && (
                <Th align="right">
                  {t("experiments.variants.cols.attributed")}
                </Th>
              )}
              {showAttributed && (
                <Th align="right">{t("experiments.variants.cols.rate")}</Th>
              )}
              <Th align="right">
                {t("experiments.variants.cols.posteriorMean")}
              </Th>
              <Th align="right">
                {t("experiments.variants.cols.credibleInterval")}
              </Th>
              <Th align="right">
                {t("experiments.variants.cols.probabilityBest")}
              </Th>
              <Th align="right">
                {t("experiments.variants.cols.expectedLoss")}
              </Th>
            </tr>
          </thead>
          <tbody>
            {variants.map((v) => {
              const rate =
                showAttributed &&
                v.attributedConversions !== null &&
                v.uniqueUsers > 0
                  ? (v.attributedConversions / v.uniqueUsers) * 100
                  : null;
              return (
                <tr
                  key={v.variantId}
                  className="border-b border-white/[0.04] last:border-b-0"
                >
                  <td className="px-3.5 py-3.5 align-middle">
                    <div className="flex items-center gap-2.5">
                      <span
                        className="size-2.5 flex-shrink-0 rounded-[3px]"
                        style={{ background: variantColor(v.colorToken) }}
                      />
                      <div className="font-rv-mono text-[13px] font-medium">
                        {v.variantId}
                        {v.isControl && (
                          <span className="ml-1.5 font-rv-mono text-[10px] font-normal text-rv-mute-500">
                            · {t("experiments.variants.control")}
                          </span>
                        )}
                      </div>
                    </div>
                  </td>
                  <NumCell>{v.exposures.toLocaleString()}</NumCell>
                  <NumCell>{v.uniqueUsers.toLocaleString()}</NumCell>
                  <NumCell>{v.matureUsers.toLocaleString()}</NumCell>
                  <NumCell>
                    <span
                      title={t(
                        "experiments.variants.excludedTitle",
                        "Immature (window not elapsed) / crossover (seen under more than one variant)",
                      )}
                    >
                      {v.excludedImmature.toLocaleString()} /{" "}
                      {v.excludedCrossover.toLocaleString()}
                    </span>
                  </NumCell>
                  <NumCell>
                    {v.conversionRate === null
                      ? "—"
                      : `${(v.conversionRate * 100).toFixed(2)}%`}
                  </NumCell>
                  {showAttributed && (
                    <NumCell>
                      {(v.attributedConversions ?? 0).toLocaleString()}
                    </NumCell>
                  )}
                  {showAttributed && (
                    <NumCell>{rate === null ? "—" : `${rate.toFixed(2)}%`}</NumCell>
                  )}
                  {v.sufficientData ? (
                    <>
                      <NumCell>{formatMetric(v.posteriorMean)}</NumCell>
                      <NumCell>
                        {formatCredibleInterval(
                          v.credibleIntervalLow,
                          v.credibleIntervalHigh,
                        )}
                      </NumCell>
                      <NumCell>{formatProbability(v.probabilityBest)}</NumCell>
                      <NumCell>{formatMetric(v.expectedLoss)}</NumCell>
                    </>
                  ) : (
                    <td
                      colSpan={POSTERIOR_COLUMN_COUNT}
                      className="px-3.5 py-3.5 text-right align-middle font-rv-mono text-rv-mute-500"
                    >
                      {t("experiments.variants.notEnoughData")}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="m-0 border-t border-rv-divider px-5 py-2.5 text-[11px] leading-snug text-rv-mute-500">
        {t(
          "experiments.variants.denominatorNote",
          "Users is the exposed count SRM checks. Mature is the windowed, crossover-free count every posterior and Conv. rate is computed over; Excluded shows the two reasons for the difference.",
        )}
      </p>
    </section>
  );
}

function formatMetric(value: number | null): string {
  if (value === null) return "—";
  return value.toLocaleString(undefined, { maximumFractionDigits: 4 });
}

function formatProbability(value: number | null): string {
  if (value === null) return "—";
  return `${(value * 100).toFixed(1)}%`;
}

function formatCredibleInterval(low: number | null, high: number | null): string {
  if (low === null || high === null) return "—";
  return `${formatMetric(low)} – ${formatMetric(high)}`;
}

type ThProps = {
  children: React.ReactNode;
  width?: string;
  align?: "left" | "right";
};

function Th({ children, width, align = "left" }: ThProps) {
  return (
    <th
      style={{ width }}
      className={cn(
        "border-b border-rv-divider bg-rv-c2 px-3.5 py-2.5 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500",
        align === "right" ? "text-right" : "text-left",
      )}
    >
      {children}
    </th>
  );
}

function NumCell({ children }: { children: React.ReactNode }) {
  return (
    <td className="px-3.5 py-3.5 text-right align-middle font-rv-mono tabular-nums">
      {children}
    </td>
  );
}
