import { useTranslation } from "react-i18next";
import { formatCompact } from "./format";
import { VOLUME_DAY_COUNT, VOLUME_SERIES } from "./mock-data";

const VW = 760;
const VH = 200;
const PAD_L = 50;
const PAD_R = 14;
const PAD_T = 10;
const PAD_B = 28;
const INNER_W = VW - PAD_L - PAD_R;
const INNER_H = VH - PAD_T - PAD_B;

/**
 * 28-day issuance vs burn chart. Issued is a filled area + line in
 * success green, burned is a line in violet, net (issued − burned) is
 * a thin accent bar so days where liability grew read at a glance.
 */
export function VolumeChart() {
  const { t } = useTranslation();
  const maxV = Math.max(
    ...VOLUME_SERIES.flatMap((p) => [p.issued, p.burned]),
  );
  const x = (i: number) => PAD_L + (i / (VOLUME_DAY_COUNT - 1)) * INNER_W;
  const y = (v: number) => PAD_T + (1 - v / maxV) * INNER_H;
  const yZero = PAD_T + INNER_H;

  const issuedPath = VOLUME_SERIES.map(
    (p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.issued).toFixed(1)}`,
  ).join(" ");
  const burnedPath = VOLUME_SERIES.map(
    (p, i) => `${i === 0 ? "M" : "L"}${x(i).toFixed(1)},${y(p.burned).toFixed(1)}`,
  ).join(" ");
  const issuedArea = `${issuedPath} L ${x(VOLUME_DAY_COUNT - 1)},${yZero} L ${PAD_L},${yZero} Z`;

  return (
    <section className="mb-4 rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4">
      <header className="mb-3.5 flex flex-wrap items-start justify-between gap-2.5">
        <div>
          <h3 className="text-[14px] font-semibold">{t("credits.volume.title")}</h3>
          <p className="mt-1 text-[11px] text-rv-mute-500">{t("credits.volume.subtitle")}</p>
        </div>
        <div className="flex flex-wrap gap-3.5 text-[11px] text-rv-mute-600">
          <Legend color="var(--color-rv-success)" label={t("credits.volume.issued")} />
          <Legend color="var(--color-rv-violet)" label={t("credits.volume.burned")} />
          <Legend color="var(--color-rv-accent-500)" label={t("credits.volume.net")} />
        </div>
      </header>

      <svg
        viewBox={`0 0 ${VW} ${VH}`}
        preserveAspectRatio="none"
        className="block h-[220px] w-full"
        aria-label={t("credits.volume.title")}
      >
        {[0.25, 0.5, 0.75, 1].map((g) => {
          const gy = PAD_T + g * INNER_H;
          return (
            <line
              key={g}
              x1={PAD_L}
              x2={VW - PAD_R}
              y1={gy}
              y2={gy}
              stroke="var(--color-rv-divider)"
              strokeDasharray="3 3"
            />
          );
        })}
        {[0, 0.25, 0.5, 0.75, 1].map((tick) => {
          const v = (1 - tick) * maxV;
          return (
            <text
              key={tick}
              x={PAD_L - 8}
              y={PAD_T + tick * INNER_H + 3}
              fontSize={9}
              fill="var(--color-rv-mute-500)"
              textAnchor="end"
              fontFamily="var(--font-rv-mono, monospace)"
            >
              {formatCompact(Math.round(v))}
            </text>
          );
        })}
        {[0, 7, 14, 21, 27].map((tick) => (
          <text
            key={tick}
            x={x(tick)}
            y={VH - 10}
            fontSize={9}
            fill="var(--color-rv-mute-500)"
            textAnchor="middle"
            fontFamily="var(--font-rv-mono, monospace)"
          >
            d{tick}
          </text>
        ))}
        <path d={issuedArea} fill="var(--color-rv-success)" opacity={0.1} />
        <path d={issuedPath} fill="none" stroke="var(--color-rv-success)" strokeWidth={2} />
        <path d={burnedPath} fill="none" stroke="var(--color-rv-violet)" strokeWidth={2} />
        {VOLUME_SERIES.map((p, i) => {
          const yz = PAD_T + (1 - p.net / maxV) * INNER_H;
          return (
            <rect
              key={i}
              x={x(i) - 1.5}
              y={Math.min(yz, yZero)}
              width={3}
              height={Math.abs(yz - yZero)}
              fill="var(--color-rv-accent-500)"
              opacity={0.5}
            />
          );
        })}
      </svg>
    </section>
  );
}

function Legend({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 font-rv-mono">
      <span className="inline-block size-2 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  );
}
