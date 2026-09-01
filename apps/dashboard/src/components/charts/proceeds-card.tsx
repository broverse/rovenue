import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { ChartProceedsRow } from "@rovenue/shared";
import { useChartProceeds } from "../../lib/hooks/useProjectCharts";
import { fmtMoney, fmtPct } from "./format";

// =============================================================
// ProceedsCard — estimated proceeds after store commission
// (spec §4.3, .superpowers/sdd/2026-09-01-analytics-integrity-and-
// proceeds/task-7-context.md)
// =============================================================
//
// Fetched from `GET /proceeds` (useChartProceeds), never from the
// `/series/:chartId` catalog dispatcher: that endpoint returns one
// blended daily line and cannot show a store with a configured rate
// beside one without. There is deliberately no `estimated_proceeds`
// chart-catalog entry either: catalog ids are daily series the
// dispatcher serves (or will), and this one never can be — listing it
// told users the figure was unwired while this card sat two panels
// away. This card is always on the page instead.
//
// The honesty requirement this component exists to satisfy: a
// proceeds figure is an ESTIMATE, not a payout. Apple's Small
// Business tier depends on the developer's whole-account prior-year
// proceeds and both stores apply tax handling we cannot see —
// presenting this as a payout would be the same class of error as
// fabricating a currency. Every rendered figure therefore carries the
// applied rate and the word "estimated" right next to it.
//
// `rate` and `proceedsUsd` arrive `null` TOGETHER for a store with no
// configured commission rate. That means "we don't know", never "the
// store takes nothing" — it must never render as 0% or fall back to
// a blended project total, so it gets its own distinct row treatment.

const DEFAULT_WINDOW_DAYS = 28;

const STORE_LABEL_KEY: Record<string, string> = {
  APP_STORE: "charts.channels.stores.apple",
  PLAY_STORE: "charts.channels.stores.google",
  STRIPE: "charts.channels.stores.stripe",
  MANUAL: "charts.channels.stores.manual",
};

type Props = {
  projectId: string;
};

export function ProceedsCard({ projectId }: Props) {
  const { t } = useTranslation();
  const { data, isLoading } = useChartProceeds({
    projectId,
    windowDays: DEFAULT_WINDOW_DAYS,
  });

  const rows = data?.rows ?? [];
  const isEmpty = rows.length === 0;

  return (
    <div
      data-testid="proceeds-card"
      className="rounded-lg border border-rv-divider bg-rv-c1 px-4 py-3.5"
    >
      <h4 className="mb-1 flex items-baseline justify-between gap-2.5 truncate text-[13px] font-semibold">
        <span className="truncate">{t("charts.proceeds.title")}</span>
        <span className="shrink-0 font-rv-mono text-[11px] font-normal text-rv-mute-500">
          {t("charts.proceeds.subtitle", {
            days: data?.windowDays ?? DEFAULT_WINDOW_DAYS,
          })}
        </span>
      </h4>
      <p className="mb-3 text-[11px] text-rv-mute-500">
        {t("charts.proceeds.disclaimer")}
      </p>
      <div className="flex flex-col gap-2">
        {rows.map((row) => (
          <ProceedsRow key={row.store} row={row} t={t} />
        ))}
        {isEmpty && (
          <div
            data-testid="proceeds-empty"
            className="py-2 text-center text-[11px] text-rv-mute-500"
          >
            {isLoading
              ? t("charts.proceeds.loading")
              : t("charts.proceeds.empty")}
          </div>
        )}
      </div>
    </div>
  );
}

function ProceedsRow({
  row,
  t,
}: {
  row: ChartProceedsRow;
  t: TFunction;
}) {
  const labelKey = STORE_LABEL_KEY[row.store];
  const label = labelKey ? t(labelKey, row.store) : row.store;
  // `rate`/`proceedsUsd` are null TOGETHER — see the header comment.
  const unconfigured = row.rate === null;

  return (
    <div
      data-testid={`proceeds-row-${row.store}`}
      className="flex items-center justify-between gap-2 text-[11px]"
    >
      <span className="min-w-0 truncate text-rv-mute-700">{label}</span>
      {unconfigured ? (
        <span
          data-testid={`proceeds-rate-${row.store}`}
          className="shrink-0 text-rv-mute-400"
        >
          {t("charts.proceeds.rateNotConfigured")}
        </span>
      ) : (
        <span
          data-testid={`proceeds-rate-${row.store}`}
          className="shrink-0 font-rv-mono tabular-nums text-rv-mute-700"
        >
          {t("charts.proceeds.estimatedAt", {
            amount: fmtMoney(row.proceedsUsd),
            rate: fmtPct(row.rate),
          })}
        </span>
      )}
    </div>
  );
}
