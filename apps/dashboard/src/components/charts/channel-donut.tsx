import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { CHANNELS } from "./mock-data";

const RADIUS = 50;
const CX = 65;
const CY = 65;
const STROKE_WIDTH = 18;

export function ChannelDonut() {
  const { t } = useTranslation();
  const circumference = 2 * Math.PI * RADIUS;

  const segments = useMemo(() => {
    let offset = 0;
    return CHANNELS.map((ch) => {
      const len = (ch.share / 100) * circumference;
      const seg = {
        ...ch,
        dasharray: `${len} ${circumference - len}`,
        offset: -offset,
      };
      offset += len + 1;
      return seg;
    });
  }, [circumference]);

  const total = useMemo(
    () => CHANNELS.reduce((sum, ch) => sum + ch.value, 0),
    [],
  );

  return (
    <div className="rounded-lg border border-rv-divider bg-rv-c1 px-4 py-3.5">
      <h4 className="mb-3 flex items-baseline justify-between gap-2.5 truncate text-[13px] font-semibold">
        <span className="truncate">{t("charts.channels.title")}</span>
        <span className="shrink-0 font-rv-mono text-[11px] font-normal text-rv-mute-500">
          {t("charts.channels.subtitle")}
        </span>
      </h4>
      <div className="flex items-center gap-4">
        <svg width="130" height="130" viewBox="0 0 130 130" className="shrink-0">
          {segments.map((s) => (
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
          ))}
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
          {CHANNELS.map((ch) => (
            <div
              key={ch.id}
              className="flex items-center gap-2 py-1 font-rv-mono text-[11px]"
            >
              <span
                className="size-2 shrink-0 rounded-sm"
                style={{ background: ch.color }}
              />
              <span className="flex-1 truncate text-rv-mute-700">
                {t(ch.labelKey)}
              </span>
              <span className="text-rv-mute-500">{ch.share}%</span>
              <span className="w-12 text-right tabular-nums">
                ${(ch.value / 1000).toFixed(1)}k
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
