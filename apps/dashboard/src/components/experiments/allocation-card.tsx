import { useTranslation } from "react-i18next";
import { variantColor } from "./format";
import type { Variant } from "./types";

type Props = {
  variants: ReadonlyArray<Variant>;
};

const PIE_R = 38;
const PIE_CENTER = 45;
const TO_RAD = (deg: number) => ((deg - 90) * Math.PI) / 180;

const arcs = (variants: ReadonlyArray<Variant>) => {
  let start = 0;
  return variants.map((v) => {
    const end = start + v.allocation * 360;
    const large = v.allocation > 0.5 ? 1 : 0;
    const x1 = PIE_CENTER + PIE_R * Math.cos(TO_RAD(start));
    const y1 = PIE_CENTER + PIE_R * Math.sin(TO_RAD(start));
    const x2 = PIE_CENTER + PIE_R * Math.cos(TO_RAD(end));
    const y2 = PIE_CENTER + PIE_R * Math.sin(TO_RAD(end));
    const d = `M ${PIE_CENTER} ${PIE_CENTER} L ${x1} ${y1} A ${PIE_R} ${PIE_R} 0 ${large} 1 ${x2} ${y2} Z`;
    start = end;
    return { d, color: variantColor(v.colorToken), id: v.id };
  });
};

/**
 * Traffic allocation pie + variant list. The "100% traffic" donut hole
 * is drawn as a separate circle so it stays crisp at small sizes.
 */
export function AllocationCard({ variants }: Props) {
  const { t } = useTranslation();
  const slices = arcs(variants);
  return (
    <section className="rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4">
      <h3 className="m-0 mb-3 text-[14px] font-semibold">
        {t("experiments.allocation.title")}
      </h3>
      <div className="flex items-center gap-5">
        <svg
          className="size-[90px] flex-shrink-0"
          viewBox="0 0 90 90"
          role="img"
          aria-label={t("experiments.allocation.title")}
        >
          {slices.map((s, i) => (
            <path key={`${s.id}-${i}`} d={s.d} fill={s.color} />
          ))}
          <circle cx={PIE_CENTER} cy={PIE_CENTER} r="22" fill="var(--color-rv-c1)" />
          <text
            x={PIE_CENTER}
            y="44"
            textAnchor="middle"
            fontSize="9"
            fill="var(--color-rv-mute-500)"
            fontFamily="var(--font-rv-mono)"
          >
            100%
          </text>
          <text
            x={PIE_CENTER}
            y="55"
            textAnchor="middle"
            fontSize="10"
            fill="var(--color-foreground)"
            fontFamily="var(--font-rv-mono)"
            fontWeight="500"
          >
            {t("experiments.allocation.traffic")}
          </text>
        </svg>
        <div className="flex-1">
          {variants.map((v) => (
            <div
              key={v.id}
              className="flex items-center justify-between border-b border-white/[0.05] py-1 text-[12px] last:border-b-0"
            >
              <div className="flex items-center gap-2">
                <span
                  className="size-2 rounded-[2px]"
                  style={{ background: variantColor(v.colorToken) }}
                />
                <span className="font-rv-mono text-[12px]">{v.id}</span>
              </div>
              <span className="font-rv-mono text-rv-mute-600">
                {(v.allocation * 100).toFixed(0)}%
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
