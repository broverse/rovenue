import { useTranslation } from "react-i18next";
import type { VolumeBar } from "./types";

type VolumeGraphProps = {
  /** Daily stacked bars. When omitted/empty an awaiting-data strip renders. */
  series?: ReadonlyArray<VolumeBar>;
  /** Optional override for the max-bar scaling denominator. */
  max?: number;
};

/**
 * 28-bar stacked timeline showing purchases · renewals · refunds. Each
 * bar is a column with three flex segments sized in proportion to its
 * category total. The rightmost bar uses the lighter accent shade to
 * signal "today".
 */
export function VolumeGraph({ series, max }: VolumeGraphProps = {}) {
  const { t } = useTranslation();
  const bars = series ?? [];
  const hasData = bars.length > 0 && bars.some((b) => b.purchases + b.renewals + b.refunds > 0);

  if (!hasData) {
    return (
      <div className="mt-3.5 flex h-24 items-center justify-center rounded-md border border-dashed border-rv-divider bg-rv-c2 text-[12px] text-rv-mute-500">
        {t("transactions.flow.awaiting")}
      </div>
    );
  }

  const denom =
    max ?? Math.max(1, ...bars.map((b) => b.purchases + b.renewals + b.refunds));

  return (
    <>
      <div
        className="mt-3.5 grid h-24 items-end gap-px"
        style={{ gridTemplateColumns: `repeat(${bars.length}, 1fr)` }}
      >
        {bars.map((bar, i) => {
          const total = bar.purchases + bar.renewals + bar.refunds;
          const height = Math.max(6, (total / denom) * 100);
          const tooltip = bar.today
            ? t("transactions.volume.tooltipToday")
            : t("transactions.volume.tooltipDayAgo", { day: bars.length - i });
          return (
            <div
              key={i}
              className="group relative flex cursor-pointer flex-col justify-end gap-px rounded-t-sm"
              style={{ height: `${height}%` }}
            >
              <div className="pointer-events-none absolute bottom-[calc(100%+6px)] left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded border border-rv-divider bg-rv-c4 px-2 py-1 font-rv-mono text-[10px] text-rv-mute-700 opacity-0 transition group-hover:opacity-100">
                {t("transactions.volume.tooltip", { total: total.toFixed(0), when: tooltip })}
              </div>
              <div className="w-full rounded-sm bg-rv-danger/80" style={{ flex: bar.refunds }} />
              <div className="w-full rounded-sm bg-rv-success" style={{ flex: bar.renewals }} />
              <div
                className="w-full rounded-sm"
                style={{
                  flex: bar.purchases,
                  background: bar.today
                    ? "var(--color-rv-accent-400)"
                    : "var(--color-rv-accent-500)",
                }}
              />
            </div>
          );
        })}
      </div>

      <div className="mt-2 flex items-center justify-between font-rv-mono text-[10px] text-rv-mute-500">
        <span>{t("transactions.volume.rangeStart")}</span>
        <span className="flex gap-3.5">
          <LegendDot color="var(--color-rv-accent-500)" label={t("transactions.volume.purchases")} />
          <LegendDot color="var(--color-rv-success)" label={t("transactions.volume.renewals")} />
          <LegendDot color="var(--color-rv-danger)" label={t("transactions.volume.refunds")} />
        </span>
        <span className="text-rv-accent-400">{t("transactions.volume.today")}</span>
      </div>
    </>
  );
}

function LegendDot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="inline-block size-2 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  );
}
