import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { variantColor } from "./format";
import type { ResultVariantRow } from "./types";

type Props = {
  variants: ReadonlyArray<ResultVariantRow>;
  /**
   * Shows the precisely-attributed conversions + derived-rate columns —
   * only meaningful for PAYWALL-type experiments (see
   * `isPaywallExperimentGroup`). Other experiment types have no
   * per-variant conversion signal in the live payload at all, so the
   * columns are hidden rather than shown empty.
   */
  showAttributed: boolean;
};

/**
 * Live variant comparison table — exposures, exposed users, and (when
 * gated) precisely-attributed conversions + the rate derived from
 * them. Every number here comes straight off `ExperimentResultsResponse`;
 * there's no per-variant ARPU/lift/CI in that payload, so those columns
 * from the old mock table are gone rather than fabricated.
 */
export function VariantsTable({ variants, showAttributed }: Props) {
  const { t } = useTranslation();
  return (
    <section className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
      <header className="flex items-center justify-between border-b border-rv-divider px-5 py-3.5">
        <h3 className="m-0 text-[14px] font-semibold">
          {t("experiments.variants.title")}
        </h3>
      </header>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[12px]">
          <thead>
            <tr>
              <Th width="30%">{t("experiments.variants.cols.variant")}</Th>
              <Th align="right">{t("experiments.variants.cols.exposures")}</Th>
              <Th align="right">{t("experiments.variants.cols.users")}</Th>
              {showAttributed && (
                <Th align="right">
                  {t("experiments.variants.cols.attributed")}
                </Th>
              )}
              {showAttributed && (
                <Th align="right">{t("experiments.variants.cols.rate")}</Th>
              )}
            </tr>
          </thead>
          <tbody>
            {variants.map((v) => {
              const rate =
                showAttributed &&
                v.attributedConversions !== null &&
                v.uniqueUsers > 0
                  ? (v.attributedConversions / v.uniqueUsers) * 100
                  : null;
              return (
                <tr
                  key={v.variantId}
                  className="border-b border-white/[0.04] last:border-b-0"
                >
                  <td className="px-3.5 py-3.5 align-middle">
                    <div className="flex items-center gap-2.5">
                      <span
                        className="size-2.5 flex-shrink-0 rounded-[3px]"
                        style={{ background: variantColor(v.colorToken) }}
                      />
                      <div className="font-rv-mono text-[13px] font-medium">
                        {v.variantId}
                        {v.isControl && (
                          <span className="ml-1.5 font-rv-mono text-[10px] font-normal text-rv-mute-500">
                            · {t("experiments.variants.control")}
                          </span>
                        )}
                      </div>
                    </div>
                  </td>
                  <NumCell>{v.exposures.toLocaleString()}</NumCell>
                  <NumCell>{v.uniqueUsers.toLocaleString()}</NumCell>
                  {showAttributed && (
                    <NumCell>
                      {(v.attributedConversions ?? 0).toLocaleString()}
                    </NumCell>
                  )}
                  {showAttributed && (
                    <NumCell>{rate === null ? "—" : `${rate.toFixed(2)}%`}</NumCell>
                  )}
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
