import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ChartChannelsRow } from "@rovenue/shared";
import { useChartChannels } from "../../lib/hooks/useProjectCharts";

const RADIUS = 50;
const CX = 65;
const CY = 65;
const STROKE_WIDTH = 18;
const DEFAULT_WINDOW_DAYS = 28;

// Per-store palette + display label. `store` on the wire comes
// from the raw_revenue_events.store column — APP_STORE / PLAY_STORE
// / STRIPE etc. Unknown stores get a neutral muted color so the
// donut stays readable when a new store appears.
const STORE_STYLE: Record<string, { color: string; labelKey: string }> = {
  APP_STORE: {
    color: "var(--color-rv-accent-500)",
    labelKey: "charts.channels.stores.apple",
  },
  PLAY_STORE: {
    color: "var(--color-rv-success)",
    labelKey: "charts.channels.stores.google",
  },
  STRIPE: {
    color: "var(--color-rv-violet)",
    labelKey: "charts.channels.stores.stripe",
  },
  MANUAL: {
    color: "var(--color-rv-warning)",
    labelKey: "charts.channels.stores.manual",
  },
};

const FALLBACK_COLORS = [
  "var(--color-rv-accent-500)",
  "var(--color-rv-violet)",
  "var(--color-rv-success)",
  "var(--color-rv-warning)",
  "var(--color-rv-cyan)",
  "var(--color-rv-mute-500)",
];

interface DonutEntry {
  id: string;
  label: string;
  value: number;
  share: number;
  color: string;
}

type Props = {
  projectId: string;
};

export function ChannelDonut({ projectId }: Props) {
  const { t } = useTranslation();
  const { data, isLoading } = useChartChannels({
    projectId,
    windowDays: DEFAULT_WINDOW_DAYS,
  });

  const circumference = 2 * Math.PI * RADIUS;

  const entries: DonutEntry[] = useMemo(() => {
    const rows = data?.rows ?? [];
    return rows.map((row: ChartChannelsRow, i) => {
      const style = STORE_STYLE[row.store];
      return {
        id: row.store,
        label: style ? t(style.labelKey, row.store) : row.store,
        value: Number(row.grossUsd),
        share: row.pct,
        color: style?.color ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length]!,
      };
    });
  }, [data, t]);

  const isEmpty = entries.length === 0;

  const segments = useMemo(() => {
    let offset = 0;
    return entries.map((e) => {
      const len = (e.share / 100) * circumference;
      const seg = {
        ...e,
        dasharray: `${len} ${Math.max(circumference - len, 0)}`,
        offset: -offset,
      };
      offset += len + 1;
      return seg;
    });
  }, [entries, circumference]);

  const total = useMemo(
    () =>
      data ? Number(data.totalUsd) : entries.reduce((s, e) => s + e.value, 0),
    [data, entries],
  );

  return (
    <div className="rounded-lg border border-rv-divider bg-rv-c1 px-4 py-3.5">
      <h4 className="mb-3 flex items-baseline justify-between gap-2.5 truncate text-[13px] font-semibold">
        <span className="truncate">{t("charts.channels.title")}</span>
        <span className="shrink-0 font-rv-mono text-[11px] font-normal text-rv-mute-500">
          {t("charts.channels.subtitle", {
            days: data?.windowDays ?? DEFAULT_WINDOW_DAYS,
          })}
        </span>
      </h4>
      <div className="flex items-center gap-4">
        <svg width="130" height="130" viewBox="0 0 130 130" className="shrink-0">
          {isEmpty ? (
            <circle
              cx={CX}
              cy={CY}
              r={RADIUS}
              fill="none"
              stroke="var(--color-rv-divider-strong)"
              strokeWidth={STROKE_WIDTH}
            />
          ) : (
            segments.map((s) => (
              <circle
                key={s.id}
                cx={CX}
                cy={CY}
                r={RADIUS}
                fill="none"
                stroke={s.color}
                strokeWidth={STROKE_WIDTH}
                strokeDasharray={s.dasharray}
                strokeDashoffset={s.offset}
                transform={`rotate(-90 ${CX} ${CY})`}
              />
            ))
          )}
          <text
            x={CX}
            y={CY - 4}
            textAnchor="middle"
            fontSize="10"
            fill="var(--color-rv-mute-500)"
            fontFamily="var(--font-rv-mono)"
          >
            {t("charts.channels.total")}
          </text>
          <text
            x={CX}
            y={CY + 12}
            textAnchor="middle"
            fontSize="14"
            fill="var(--color-rv-mute-800)"
            fontWeight="600"
            fontFamily="var(--font-rv-mono)"
          >
            ${(total / 1000).toFixed(1)}k
          </text>
        </svg>
        <div className="flex-1 min-w-0">
          {entries.map((e) => (
            <div
              key={e.id}
              className="flex items-center gap-2 py-1 font-rv-mono text-[11px]"
            >
              <span
                className="size-2 shrink-0 rounded-sm"
                style={{ background: e.color }}
              />
              <span className="flex-1 truncate text-rv-mute-700">
                {e.label}
              </span>
              <span className="text-rv-mute-500">{e.share}%</span>
              <span className="w-12 text-right tabular-nums">
                ${(e.value / 1000).toFixed(1)}k
              </span>
            </div>
          ))}
          {isEmpty && (
            <div className="py-2 text-center text-[11px] text-rv-mute-500">
              {isLoading
                ? t("charts.channels.loading", "Loading…")
                : t("charts.channels.empty", "No revenue in this window")}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
