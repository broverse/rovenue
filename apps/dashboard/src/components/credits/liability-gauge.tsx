import { Trans, useTranslation } from "react-i18next";
import type { CreditsLiability } from "@rovenue/shared";

const RADIUS = 40;
const CIRC = 2 * Math.PI * RADIUS;
const ARC_FRAC = 0.75;
const ARC_TOTAL = CIRC * ARC_FRAC;

const USD_FMT = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

function formatUsd(decimalString: string): string {
  const n = Number(decimalString);
  if (!Number.isFinite(n)) return "$—";
  return USD_FMT.format(n);
}

function formatDeltaPct(pct: number | null): string | null {
  if (pct == null) return null;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

/**
 * Outstanding liability card — 3/4 circular gauge tracking the share
 * of paid (revenue-backed) credits in the wallet, plus a stacked
 * breakdown and a reserve callout sourced from the rollup payload.
 */
export function LiabilityGauge({ liability }: { liability?: CreditsLiability }) {
  const { t } = useTranslation();

  const paidShare = liability?.paidShare ?? 0;
  const fillArc = ARC_TOTAL * paidShare;
  const offset = ARC_TOTAL * 0.125;
  const pctLabel = `${Math.round(paidShare * 100)}%`;

  const paidValue = liability ? formatUsd(liability.paidReserveUsd) : "—";
  const promoValue = liability
    ? `${Math.round(liability.promoShare * 100)}% non-cash`
    : "—";
  const avgAge =
    liability?.averageAgeDays != null
      ? t("credits.liability.avgAgeDays", { days: liability.averageAgeDays.toFixed(1) })
      : t("credits.liability.avgAgeUnknown");

  const deltaLabel = formatDeltaPct(liability?.reserveDeltaPct ?? null);

  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4">
      <header className="mb-3.5 flex items-center justify-between text-[13px] font-semibold">
        <span>{t("credits.liability.title")}</span>
        <span className="font-rv-mono text-[11px] font-normal text-rv-mute-500">
          {t("credits.liability.sub")}
        </span>
      </header>
      <div className="flex items-center gap-3.5">
        <svg width={100} height={100} viewBox="0 0 100 100" aria-hidden className="shrink-0">
          <circle
            cx={50}
            cy={50}
            r={RADIUS}
            fill="none"
            stroke="var(--color-rv-c3)"
            strokeWidth={10}
            strokeDasharray={`${ARC_TOTAL} ${CIRC}`}
            strokeDashoffset={offset}
            transform="rotate(-90 50 50)"
            strokeLinecap="round"
          />
          <circle
            cx={50}
            cy={50}
            r={RADIUS}
            fill="none"
            stroke="var(--color-rv-accent-500)"
            strokeWidth={10}
            strokeDasharray={`${fillArc} ${CIRC}`}
            strokeDashoffset={offset}
            transform="rotate(-90 50 50)"
            strokeLinecap="round"
          />
          <text
            x={50}
            y={48}
            textAnchor="middle"
            fontSize={16}
            fontWeight={600}
            fill="var(--color-foreground, #fff)"
            fontFamily="var(--font-rv-mono, monospace)"
          >
            {pctLabel}
          </text>
          <text
            x={50}
            y={62}
            textAnchor="middle"
            fontSize={9}
            fill="var(--color-rv-mute-500)"
            fontFamily="var(--font-rv-mono, monospace)"
          >
            {t("credits.liability.gaugeCaption")}
          </text>
        </svg>
        <div className="flex-1">
          <Row label={t("credits.liability.paidLabel")} value={paidValue} />
          <Row label={t("credits.liability.promoLabel")} value={promoValue} valueMuted />
          <Row label={t("credits.liability.avgAge")} value={avgAge} />
          <div className="mt-2.5 rounded border-l-2 border-rv-warning bg-rv-c2 px-2.5 py-2 text-[11px] text-rv-mute-600">
            <span className="font-medium text-rv-warning">
              {t("credits.liability.reserveLabel")}
            </span>{" "}
            {deltaLabel ? (
              <Trans
                i18nKey="credits.liability.reserveBody"
                values={{ delta: deltaLabel, amount: paidValue }}
                components={{ 0: <span className="font-rv-mono" />, 1: <span className="font-rv-mono" /> }}
              />
            ) : (
              <Trans
                i18nKey="credits.liability.reserveBodyFlat"
                values={{ amount: paidValue }}
                components={{ 0: <span className="font-rv-mono" /> }}
              />
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function Row({
  label,
  value,
  valueMuted,
}: {
  label: string;
  value: string;
  valueMuted?: boolean;
}) {
  return (
    <div className="mb-1.5 flex items-center justify-between text-[12px] last:mb-0">
      <span className="text-rv-mute-600">{label}</span>
      <span className={`font-rv-mono ${valueMuted ? "text-rv-mute-500" : ""}`}>{value}</span>
    </div>
  );
}
