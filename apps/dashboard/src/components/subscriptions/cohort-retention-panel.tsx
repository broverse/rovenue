import { useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { COHORT_HEADERS, COHORT_MATRIX } from "./mock-data";

type Period = "monthly" | "yearly";

/**
 * Maps a retention percent to a primary-tinted heatmap cell. Uses
 * `color-mix` so the swatch picks up the active accent hue.
 */
function cellStyle(value: number | null): {
  background: string;
  color: string;
  border: string;
} {
  if (value == null) {
    return {
      background: "transparent",
      color: "var(--color-rv-mute-500)",
      border: "1px dashed var(--color-rv-divider)",
    };
  }
  const pct =
    value >= 90 ? 80 : value >= 75 ? 55 : value >= 60 ? 30 : 15;
  const text = value >= 75 ? "white" : "var(--color-rv-mute-800)";
  return {
    background: `color-mix(in srgb, var(--color-rv-accent-500) ${pct}%, transparent)`,
    color: text,
    border: "none",
  };
}

export function CohortRetentionPanel() {
  const { t } = useTranslation();
  const [period, setPeriod] = useState<Period>("monthly");

  return (
    <section className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
      <header className="flex items-baseline justify-between border-b border-rv-divider px-4 py-3.5">
        <div>
          <h3 className="text-[14px] font-semibold">
            {t("subscriptions.cohort.title")}
          </h3>
          <p className="mt-0.5 text-[12px] text-rv-mute-500">
            {t("subscriptions.cohort.subtitle")}
          </p>
        </div>
        <div className="inline-flex gap-0.5 rounded-md border border-rv-divider bg-rv-c2 p-[3px]">
          {(["monthly", "yearly"] as Period[]).map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              className={cn(
                "h-[26px] cursor-pointer rounded px-3 text-[12px] transition",
                period === p
                  ? "bg-rv-c4 text-foreground"
                  : "text-rv-mute-600 hover:text-foreground",
              )}
            >
              {t(`subscriptions.cohort.period.${p}`)}
            </button>
          ))}
        </div>
      </header>

      <div className="px-4 py-4">
        <div className="mb-1 grid items-center gap-[3px] grid-cols-[120px_repeat(6,minmax(0,1fr))]">
          <span className="pr-2 text-[11px] text-rv-mute-600">
            {t("subscriptions.cohort.cohortLabel")}
          </span>
          {COHORT_HEADERS.map((m) => (
            <span
              key={m}
              className="text-center font-rv-mono text-[10px] text-rv-mute-500"
            >
              {m}
            </span>
          ))}
        </div>

        {COHORT_MATRIX.map((row) => (
          <div
            key={row.label}
            className="mb-0.5 grid items-center gap-[3px] grid-cols-[120px_repeat(6,minmax(0,1fr))] font-rv-mono"
          >
            <span className="pr-2 text-[11px] text-rv-mute-600">
              {row.label}
            </span>
            {row.values.map((v, idx) => {
              const style = cellStyle(v);
              return (
                <span
                  key={idx}
                  className="flex h-7 items-center justify-center rounded-[3px] text-[10px] tabular-nums"
                  style={style}
                >
                  {v == null ? "—" : `${v}%`}
                </span>
              );
            })}
          </div>
        ))}

        <p className="mt-3.5 font-rv-mono text-[11px] text-rv-mute-500">
          {t("subscriptions.cohort.footer.m1Median")}
          <span className="text-foreground">86%</span>
          {" · "}
          {t("subscriptions.cohort.footer.m6Median")}
          <span className="text-foreground">58%</span>
          {" · "}
          {t("subscriptions.cohort.footer.trending")}
          <span className="text-rv-success"> ↑ +2.1pp</span>{" "}
          {t("subscriptions.cohort.footer.vsPriorQtr")}
        </p>
      </div>
    </section>
  );
}
