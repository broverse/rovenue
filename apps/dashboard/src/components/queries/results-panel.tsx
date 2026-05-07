import { ArrowDown, BarChart3 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { Button } from "../../ui/button";
import { formatNumberCell } from "./format";
import { QUERY_LOGS, QUERY_PLAN } from "./mock-data";
import type { QueryResultTab, SavedQuery } from "./types";

type Props = {
  query: SavedQuery;
  resultTab: QueryResultTab;
  onResultTabChange: (next: QueryResultTab) => void;
};

const TABS: ReadonlyArray<{ k: QueryResultTab; labelKey: string; showCount?: boolean }> = [
  { k: "table", labelKey: "queries.results.tabs.results", showCount: true },
  { k: "chart", labelKey: "queries.results.tabs.visualization" },
  { k: "plan", labelKey: "queries.results.tabs.plan" },
  { k: "logs", labelKey: "queries.results.tabs.logs" },
];

/**
 * Results panel under the editor — shared header (tabs + run stats) and
 * one of four bodies: a sortable-looking table, a horizontal-bar chart,
 * a flat query plan, or a log timeline.
 */
export function ResultsPanel({ query, resultTab, onResultTabChange }: Props) {
  const { t } = useTranslation();
  const maxBarValue =
    query.rows && query.rows.length > 0
      ? Math.max(...query.rows.map((r) => Number(r[2] ?? 0) || 0))
      : 1;

  return (
    <section className="mt-3.5 overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
      <header className="flex flex-wrap items-center gap-3 border-b border-rv-divider px-3.5 sm:h-10 sm:flex-nowrap">
        <div className="flex overflow-x-auto">
          {TABS.map((tab) => {
            const active = resultTab === tab.k;
            return (
              <button
                key={tab.k}
                type="button"
                onClick={() => onResultTabChange(tab.k)}
                className={cn(
                  "-mb-px flex h-10 shrink-0 cursor-pointer items-center gap-1.5 border-b-2 px-3 text-[12px] transition",
                  active
                    ? "border-rv-accent-500 text-rv-accent-400"
                    : "border-transparent text-rv-mute-600 hover:text-foreground",
                )}
              >
                <span>{t(tab.labelKey)}</span>
                {tab.showCount && (
                  <span
                    className={cn(
                      "rounded-full px-1.5 py-px font-rv-mono text-[10px]",
                      active
                        ? "bg-rv-accent-500/18 text-rv-accent-400"
                        : "bg-rv-c3 text-rv-mute-600",
                    )}
                  >
                    {query.rowCount ?? 0}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="flex w-full flex-wrap items-center gap-x-3.5 gap-y-1 pb-2 font-rv-mono text-[11px] text-rv-mute-500 sm:ml-auto sm:w-auto sm:flex-nowrap sm:pb-0">
          <span className="flex items-center gap-1">
            <span className="size-1.5 rounded-full bg-rv-success" aria-hidden />
            <b className="font-medium text-rv-success">{t("queries.results.success")}</b>
          </span>
          <span className="hidden sm:inline">
            ·{" "}
            <b className="font-medium text-foreground">
              {t("queries.results.duration", { ms: query.durationMs })}
            </b>{" "}
            ·{" "}
            {t("queries.results.rowsScanned", {
              rows: query.rowCount ?? 0,
              bytes: query.bytesScanned ?? "—",
            })}
          </span>
          <span className="sm:hidden">
            <b className="font-medium text-foreground">
              {t("queries.results.duration", { ms: query.durationMs })}
            </b>
          </span>
          <Button variant="light" className="ml-auto h-6 text-[11px] sm:ml-0">
            <ArrowDown size={11} />
            {t("queries.results.exportCsv")}
          </Button>
        </div>
      </header>

      {resultTab === "table" && (
        <ResultsTable query={query} maxBarValue={maxBarValue} />
      )}
      {resultTab === "chart" && (
        <ResultsChart query={query} maxBarValue={maxBarValue} />
      )}
      {resultTab === "plan" && <ResultsPlan />}
      {resultTab === "logs" && <ResultsLogs />}
    </section>
  );
}

function ResultsTable({ query, maxBarValue }: { query: SavedQuery; maxBarValue: number }) {
  const { t } = useTranslation();
  if (!query.rows || !query.columns) {
    return (
      <div className="px-4 py-12 text-center font-rv-mono text-[12px] text-rv-mute-500">
        {t("queries.results.empty")}
      </div>
    );
  }
  return (
    <div className="max-h-80 overflow-auto">
      <table className="w-full border-collapse font-rv-mono text-[12px]">
        <thead>
          <tr>
            <th className="sticky top-0 z-[1] w-8 whitespace-nowrap border-b border-rv-divider bg-rv-c2 px-3 py-1.5 text-left text-[11px] font-medium text-rv-mute-700">
              #
            </th>
            {query.columns.map((c) => (
              <th
                key={c.name}
                className="sticky top-0 z-[1] whitespace-nowrap border-b border-rv-divider bg-rv-c2 px-3 py-1.5 text-left text-[11px] font-medium text-rv-mute-700"
              >
                {c.name}
                <span className="ml-1.5 text-[9px] font-normal uppercase tracking-wider text-rv-mute-500">
                  {c.type}
                </span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {query.rows.map((row, i) => (
            <tr
              key={i}
              className="border-b border-white/[0.04] transition hover:bg-rv-c2"
            >
              <td className="w-8 whitespace-nowrap px-3 py-1.5 text-rv-mute-500 tabular-nums">
                {i + 1}
              </td>
              {row.map((v, j) => {
                const isNumber = typeof v === "number";
                return (
                  <td
                    key={j}
                    className={cn(
                      "whitespace-nowrap px-3 py-1.5 tabular-nums",
                      isNumber ? "text-foreground" : "text-rv-mute-700",
                    )}
                  >
                    {formatNumberCell(v)}
                    {j === 2 && isNumber && (
                      <span
                        className="ml-2 inline-block h-1 rounded bg-rv-accent-500/35 align-middle"
                        style={{ width: `${(Number(v) / maxBarValue) * 80}px` }}
                        aria-hidden
                      />
                    )}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ResultsChart({ query, maxBarValue }: { query: SavedQuery; maxBarValue: number }) {
  const { t } = useTranslation();
  if (!query.rows) {
    return (
      <div className="px-4 py-12 text-center font-rv-mono text-[12px] text-rv-mute-500">
        {t("queries.results.empty")}
      </div>
    );
  }
  return (
    <div className="p-4.5">
      <div className="mb-3 flex flex-wrap items-baseline gap-2.5">
        <h4 className="text-[13px] font-medium">
          {t("queries.results.chart.title", { name: query.name })}
        </h4>
        <span className="text-[11px] text-rv-mute-500">
          {t("queries.results.chart.subtitle", { count: query.rowCount ?? 0 })}
        </span>
        <div className="ml-auto flex flex-wrap gap-1.5">
          <Button variant="light" className="h-6 text-[11px]">
            <BarChart3 size={11} />
            {t("queries.results.chart.bar")}
          </Button>
          <Button variant="light" className="h-6 text-[11px]">
            {t("queries.results.chart.line")}
          </Button>
          <Button variant="light" className="h-6 text-[11px]">
            {t("queries.results.chart.pie")}
          </Button>
        </div>
      </div>
      <div className="grid items-center gap-x-3 gap-y-1.5 font-rv-mono text-[11.5px] [grid-template-columns:60px_1fr_90px]">
        {query.rows.map((row, i) => {
          const value = Number(row[2] ?? 0);
          return (
            <div key={i} className="contents">
              <span className="text-rv-mute-700">{row[0]}</span>
              <div className="h-3 overflow-hidden rounded bg-rv-c2">
                <div
                  className="h-full bg-gradient-to-r from-rv-accent-600 to-rv-accent-400"
                  style={{ width: `${(value / maxBarValue) * 100}%` }}
                />
              </div>
              <span className="text-right text-rv-mute-700">
                ${(value / 1000).toFixed(1)}k
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function ResultsPlan() {
  return (
    <div className="overflow-x-auto p-4.5 font-rv-mono text-[11.5px] leading-[1.8] text-rv-mute-700">
      {QUERY_PLAN.map((node, i) => (
        <div
          key={i}
          className="flex gap-3 py-1"
          style={{ paddingLeft: node.depth * 18 }}
        >
          <span className="min-w-[110px] font-medium text-rv-accent-400">{node.op}</span>
          <span className="min-w-[80px] text-rv-mute-500">{node.cost}</span>
          <span className="min-w-[100px] text-rv-warning">{node.rows} rows</span>
          <span className="text-rv-mute-600">{node.detail}</span>
        </div>
      ))}
    </div>
  );
}

function ResultsLogs() {
  const { t } = useTranslation();
  return (
    <div className="overflow-x-auto p-4.5 font-rv-mono text-[11.5px] leading-[1.8] text-rv-mute-700">
      {QUERY_LOGS.map((log, i) => (
        <div key={i}>
          <span className="text-rv-mute-500">{log.ts}</span>{" "}
          <span
            className={cn(
              log.level === "info" && "text-rv-success",
              log.level === "warn" && "text-rv-warning",
              log.level === "error" && "text-rv-danger",
            )}
          >
            [{t(`queries.results.logs.level.${log.level}`)}]
          </span>{" "}
          {log.message}
        </div>
      ))}
    </div>
  );
}
