import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useChartFilterOptions } from "../../lib/hooks/useProjectCharts";

// =============================================================
// CountryCoverageCard — country breakdown that states its own gaps
// (spec §4.2, .superpowers/sdd/2026-09-01-analytics-integrity-and-
// proceeds/task-7-context.md)
// =============================================================
//
// Country coverage is partial in TWO independent ways (Task 3's
// verified matrix): Apple is full; Google is full except
// VOIDED_PURCHASE refunds; Stripe carries a country only on
// `charge.refunded` — `invoice.paid` (the majority of Stripe volume)
// carries none. On top of that, events recorded before the country
// column existed have no country at all.
//
// Rather than hard-code that matrix (which drifts the moment any of
// it changes) or render the gap as an "Unknown" bucket sitting next
// to real countries as though it were one of them, this card DERIVES
// coverage from `countryCoverage` — two uncapped counts over the same
// window (`countIf(country != '')` and `count()`), computed by the API.
// That is a real, computed coverage figure reflecting whichever gaps
// are currently true — store-specific or the historical boundary alike
// — without the UI needing to know which one is responsible.
//
// It must NOT be recomputed from the `country` / `platform` lists on
// this same response: those feed a dropdown and the API caps them at 50
// rows, so summing them understated coverage for any project selling in
// more than 50 storefronts — a worldwide Apple-only project with full
// coverage was shown a partial-coverage warning blaming stores it does
// not use. The lists below are for DISPLAY; the statistic has its own
// uncapped source.

const DEFAULT_WINDOW_DAYS = 28;
const MAX_COUNTRY_ROWS = 8;
const FULL_COVERAGE_PCT = 100;

type Props = {
  projectId: string;
};

export function CountryCoverageCard({ projectId }: Props) {
  const { t } = useTranslation();
  const { data, isLoading } = useChartFilterOptions({
    projectId,
    windowDays: DEFAULT_WINDOW_DAYS,
  });

  const country = data?.country ?? [];

  const totalEvents = data?.countryCoverage.totalEvents ?? 0;
  const knownCountryEvents = data?.countryCoverage.eventsWithCountry ?? 0;

  const noRevenue = totalEvents === 0;
  const coveragePct = noRevenue
    ? null
    : Math.round((knownCountryEvents / totalEvents) * 100);
  const isPartial = coveragePct !== null && coveragePct < FULL_COVERAGE_PCT;

  const sortedCountries = useMemo(
    () =>
      [...country].sort((a, b) => b.count - a.count).slice(0, MAX_COUNTRY_ROWS),
    [country],
  );

  return (
    <div
      data-testid="country-coverage-card"
      className="rounded-lg border border-rv-divider bg-rv-c1 px-4 py-3.5"
    >
      <h4 className="mb-1 flex items-baseline justify-between gap-2.5 truncate text-[13px] font-semibold">
        <span className="truncate">{t("charts.countryCoverage.title")}</span>
        <span className="shrink-0 font-rv-mono text-[11px] font-normal text-rv-mute-500">
          {t("charts.countryCoverage.subtitle", {
            days: data?.windowDays ?? DEFAULT_WINDOW_DAYS,
          })}
        </span>
      </h4>

      {!noRevenue && coveragePct !== null && (
        <p
          data-testid="country-coverage-note"
          className="mb-3 text-[11px] text-rv-mute-500"
        >
          {isPartial
            ? t("charts.countryCoverage.partialNote", { pct: coveragePct })
            : t("charts.countryCoverage.fullNote")}
        </p>
      )}

      <div className="flex flex-col gap-2">
        {sortedCountries.map((c) => (
          <div
            key={c.value}
            data-testid={`country-row-${c.value}`}
            className="flex items-center justify-between gap-2 text-[11px]"
          >
            <span className="min-w-0 truncate text-rv-mute-700">
              {c.label}
            </span>
            <span className="shrink-0 font-rv-mono tabular-nums text-rv-mute-500">
              {c.count.toLocaleString()}
            </span>
          </div>
        ))}

        {noRevenue && (
          <div
            data-testid="country-coverage-empty"
            className="py-2 text-center text-[11px] text-rv-mute-500"
          >
            {isLoading
              ? t("charts.countryCoverage.loading")
              : t("charts.countryCoverage.empty")}
          </div>
        )}

        {!noRevenue && sortedCountries.length === 0 && (
          <div
            data-testid="country-coverage-no-known"
            className="py-2 text-center text-[11px] text-rv-mute-500"
          >
            {t("charts.countryCoverage.noKnownCountries")}
          </div>
        )}
      </div>
    </div>
  );
}
