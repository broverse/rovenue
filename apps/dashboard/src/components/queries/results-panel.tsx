import { BarChart3, Loader2 } from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { QueryExecuteResponse } from "@rovenue/shared";
import { cn } from "../../lib/cn";
import { Button } from "../../ui/button";
import { formatNumberCell } from "./format";
import type { QueryResultTab } from "./types";

type Props = {
  result: QueryExecuteResponse | null;
  loading: boolean;
  error: string | null;
  resultTab: QueryResultTab;
  onResultTabChange: (next: QueryResultTab) => void;
};

const TABS: ReadonlyArray<{ k: QueryResultTab; labelKey: string; showCount?: boolean }> = [
  { k: "table", labelKey: "queries.results.tabs.results", showCount: true },
  { k: "chart", labelKey: "queries.results.tabs.visualization" },
];

/**
 * Results panel under the editor — shared header (tabs + run stats) and
 * one of two bodies: a sortable-looking table or a horizontal-bar chart
 * built from the most recent execution payload.
 */
export function ResultsPanel({
  result,
  loading,
  error,
  resultTab,
  onResultTabChange,
}: Props) {
  const { t } = useTranslation();
  const rowCount = result?.rowCount ?? 0;

  const numericColumnIndex = useMemo(() => {
    if (!result) return null;
    return result.columns.findIndex((c, i) => {
      if (i === 0) return false;
      const t = c.type.toLowerCase();
      return (
        t.includes("int") ||
        t.includes("float") ||
        t.includes("decimal") ||
        t.includes("uint") ||
        t.includes("double")
      );
    });
  }, [result]);

  const maxBarValue = useMemo(() => {
    if (!result || numericColumnIndex === null || numericColumnIndex < 0) {
      return 1;
    }
    let max = 0;
    for (const row of result.rows) {
      const v = Number(row[numericColumnIndex] ?? 0) || 0;
      if (v > max) max = v;
    }
    return max || 1;
  }, [result, numericColumnIndex]);

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
                    {rowCount}
                  </span>
                )}
              </button>
            );
          })}
        </div>
        <div className="flex w-full flex-wrap items-center gap-x-3.5 gap-y-1 pb-2 font-rv-mono text-[11px] text-rv-mute-500 sm:ml-auto sm:w-auto sm:flex-nowrap sm:pb-0">
          {loading ? (
            <span className="inline-flex items-center gap-1 text-rv-mute-600">
              <Loader2 size={11} className="animate-spin" />
              <b className="font-medium">{t("queries.results.running")}</b>
            </span>
          ) : error ? (
            <span className="inline-flex items-center gap-1 text-rv-danger">
              <span className="size-1.5 rounded-full bg-rv-danger" aria-hidden />
              <b className="font-medium">{t("queries.results.failed")}</b>
            </span>
          ) : result ? (
            <>
              <span className="flex items-center gap-1">
                <span
                  className="size-1.5 rounded-full bg-rv-success"
                  aria-hidden
                />
                <b className="font-medium text-rv-success">
                  {t("queries.results.success")}
                </b>
              </span>
              <span className="hidden sm:inline">
                ·{" "}
                <b className="font-medium text-foreground">
                  {t("queries.results.duration", { ms: result.durationMs })}
                </b>{" "}
                ·{" "}
                {t("queries.results.rowsReturned", { rows: result.rowCount })}
              </span>
              {result.truncated && (
                <span className="text-rv-warning">
                  {t("queries.results.truncated")}
                </span>
              )}
            </>
          ) : (
            <span className="text-rv-mute-600">
              {t("queries.results.notRun")}
            </span>
          )}
        </div>
      </header>

      {resultTab === "table" && (
        <ResultsTable
          result={result}
          loading={loading}
          error={error}
          numericColumnIndex={numericColumnIndex}
          maxBarValue={maxBarValue}
        />
      )}
      {resultTab === "chart" && (
        <ResultsChart
          result={result}
          loading={loading}
          error={error}
          numericColumnIndex={numericColumnIndex}
          maxBarValue={maxBarValue}
        />
      )}
    </section>
  );
}

function ResultsEmpty({
  loading,
  error,
}: {
  loading: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  if (loading) {
    return (
      <div className="flex items-center justify-center gap-2 px-4 py-12 font-rv-mono text-[12px] text-rv-mute-500">
        <Loader2 size={12} className="animate-spin" />
        {t("queries.results.running")}
      </div>
    );
  }
  if (error) {
    return (
      <div className="px-4 py-10 text-center font-rv-mono text-[12px]">
        <p className="text-rv-danger">{error}</p>
      </div>
    );
  }
  return (
    <div className="px-4 py-12 text-center font-rv-mono text-[12px] text-rv-mute-500">
      {t("queries.results.runHint")}
    </div>
  );
}

function ResultsTable({
  result,
  loading,
  error,
  numericColumnIndex,
  maxBarValue,
}: {
  result: QueryExecuteResponse | null;
  loading: boolean;
  error: string | null;
  numericColumnIndex: number | null;
  maxBarValue: number;
}) {
  if (!result || result.rows.length === 0) {
    return <ResultsEmpty loading={loading} error={error} />;
  }
  return (
    <div className="max-h-80 overflow-auto">
      <table className="w-full border-collapse font-rv-mono text-[12px]">
        <thead>
          <tr>
            <th className="sticky top-0 z-[1] w-8 whitespace-nowrap border-b border-rv-divider bg-rv-c2 px-3 py-1.5 text-left text-[11px] font-medium text-rv-mute-700">
              #
            </th>
            {result.columns.map((c) => (
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
          {result.rows.map((row, i) => (
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
                    {renderCell(v)}
                    {j === numericColumnIndex && isNumber && (
                      <span
                        className="ml-2 inline-block h-1 rounded bg-rv-accent-500/35 align-middle"
                        style={{
                          width: `${(Number(v) / maxBarValue) * 80}px`,
                        }}
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

function renderCell(v: unknown) {
  if (typeof v === "number") return formatNumberCell(v);
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

function ResultsChart({
  result,
  loading,
  error,
  numericColumnIndex,
  maxBarValue,
}: {
  result: QueryExecuteResponse | null;
  loading: boolean;
  error: string | null;
  numericColumnIndex: number | null;
  maxBarValue: number;
}) {
  const { t } = useTranslation();
  if (!result || result.rows.length === 0) {
    return <ResultsEmpty loading={loading} error={error} />;
  }
  if (numericColumnIndex === null || numericColumnIndex < 0) {
    return (
      <div className="px-4 py-12 text-center font-rv-mono text-[12px] text-rv-mute-500">
        {t("queries.results.chart.noNumericColumn")}
      </div>
    );
  }
  const labelIndex = 0;
  return (
    <div className="p-4.5">
      <div className="mb-3 flex flex-wrap items-baseline gap-2.5">
        <h4 className="text-[13px] font-medium">
          {result.columns[numericColumnIndex]?.name ?? "value"}
        </h4>
        <span className="text-[11px] text-rv-mute-500">
          {t("queries.results.chart.subtitle", { count: result.rowCount })}
        </span>
        <div className="ml-auto flex flex-wrap gap-1.5">
          <Button variant="light" className="h-6 text-[11px]">
            <BarChart3 size={11} />
            {t("queries.results.chart.bar")}
          </Button>
        </div>
      </div>
      <div className="grid items-center gap-x-3 gap-y-1.5 font-rv-mono text-[11.5px] [grid-template-columns:120px_1fr_90px]">
        {result.rows.map((row, i) => {
          const value = Number(row[numericColumnIndex] ?? 0);
          const label = row[labelIndex];
          return (
            <div key={i} className="contents">
              <span className="truncate text-rv-mute-700">
                {typeof label === "number" ? formatNumberCell(label) : String(label ?? "—")}
              </span>
              <div className="h-3 overflow-hidden rounded bg-rv-c2">
                <div
                  className="h-full bg-gradient-to-r from-rv-accent-600 to-rv-accent-400"
                  style={{ width: `${(value / maxBarValue) * 100}%` }}
                />
              </div>
              <span className="text-right text-rv-mute-700">
                {formatNumberCell(value)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
