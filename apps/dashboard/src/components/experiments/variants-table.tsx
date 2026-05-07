import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { ciGeometry, variantColor } from "./format";
import { LiftPill } from "./lift-pill";
import type { Variant } from "./types";

type Props = {
  variants: ReadonlyArray<Variant>;
  metricNameKey: string;
};

/**
 * Variant comparison table — primary metric, ARPU and a 95% CI bar
 * per variant. The CI bar maps -12..+12% to a 160px track with a 0
 * marker, range pill, and centerpoint dot.
 */
export function VariantsTable({ variants, metricNameKey }: Props) {
  const { t } = useTranslation();
  return (
    <section className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
      <header className="flex items-center justify-between border-b border-rv-divider px-5 py-3.5">
        <h3 className="m-0 text-[14px] font-semibold">
          {t("experiments.variants.title")}
        </h3>
        <span className="font-rv-mono text-[11px] text-rv-mute-500">
          {t("experiments.variants.subtitle", { metric: t(metricNameKey) })}
        </span>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr>
              <Th width="30%">{t("experiments.variants.cols.variant")}</Th>
              <Th align="right">{t("experiments.variants.cols.users")}</Th>
              <Th align="right">{t("experiments.variants.cols.conversions")}</Th>
              <Th align="right">{t("experiments.variants.cols.rate")}</Th>
              <Th align="right">{t("experiments.variants.cols.arpu")}</Th>
              <Th width="200px">{t("experiments.variants.cols.lift")}</Th>
            </tr>
          </thead>
          <tbody>
            {variants.map((v) => {
              const ci = ciGeometry(v.ciLow, v.ciHigh);
              return (
                <tr key={v.id} className="border-b border-white/[0.04] last:border-b-0">
                  <td className="px-3.5 py-3.5 align-middle">
                    <div className="flex items-center gap-2.5">
                      <span
                        className="size-2.5 flex-shrink-0 rounded-[3px]"
                        style={{ background: variantColor(v.colorToken) }}
                      />
                      <div>
                        <div className="font-rv-mono text-[13px] font-medium">
                          {v.id}
                          {v.isControl && (
                            <span className="ml-1.5 font-rv-mono text-[10px] font-normal text-rv-mute-500">
                              · {t("experiments.variants.control")}
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 text-[11px] text-rv-mute-500">
                          {v.description}
                        </div>
                      </div>
                    </div>
                  </td>
                  <NumCell>{v.users.toLocaleString()}</NumCell>
                  <NumCell>{v.conversions.toLocaleString()}</NumCell>
                  <NumCell>{(v.rate * 100).toFixed(2)}%</NumCell>
                  <NumCell>${v.arpu.toFixed(2)}</NumCell>
                  <td className="px-3.5 py-3.5 align-middle">
                    {v.isControl ? (
                      <LiftPill value={0}>
                        — {t("experiments.variants.baseline")}
                      </LiftPill>
                    ) : (
                      <div className="flex items-center gap-2.5">
                        <LiftPill value={v.lift} />
                        <CiBar
                          left={ci.left}
                          width={ci.width}
                          zero={ci.zero}
                          tone={v.lift > 0 ? "up" : "down"}
                        />
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

type ThProps = {
  children: React.ReactNode;
  width?: string;
  align?: "left" | "right";
};

function Th({ children, width, align = "left" }: ThProps) {
  return (
    <th
      style={{ width }}
      className={cn(
        "border-b border-rv-divider bg-rv-c2 px-3.5 py-2.5 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500",
        align === "right" ? "text-right" : "text-left",
      )}
    >
      {children}
    </th>
  );
}

function NumCell({ children }: { children: React.ReactNode }) {
  return (
    <td className="px-3.5 py-3.5 text-right align-middle font-rv-mono tabular-nums">
      {children}
    </td>
  );
}

type CiBarProps = {
  left: number;
  width: number;
  zero: number;
  tone: "up" | "down";
};

/**
 * Confidence interval bar — 1-px axis, 1-px zero marker, a colored
 * range pill, and a 2-px center point. All offsets arrive as percent
 * so the bar scales with the table column width.
 */
function CiBar({ left, width, zero, tone }: CiBarProps) {
  return (
    <div className="relative h-7 w-40">
      <div className="absolute left-0 right-0 top-1/2 h-px bg-rv-divider" />
      <div
        className="absolute bottom-1 top-1 w-px bg-rv-mute-400"
        style={{ left: `${zero}%` }}
      />
      <div
        className={cn(
          "absolute top-1/2 -mt-1 h-2 rounded-[2px]",
          tone === "up" ? "bg-rv-success/70" : "bg-rv-danger/70",
        )}
        style={{ left: `${left}%`, width: `${width}%` }}
      />
      <div
        className="absolute top-1/2 -mt-[7px] h-3.5 w-0.5 rounded-[1px] bg-white"
        style={{ left: `${left + width / 2}%` }}
      />
    </div>
  );
}
