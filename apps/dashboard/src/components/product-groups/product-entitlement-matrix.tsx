import { useTranslation } from "react-i18next";
import { DurationTag } from "../products/duration-tag";
import { ProductIcon } from "../products/product-icon";
import { StatusChip } from "../products/status-chip";
import { IconCheck, IconX } from "../dashboard/icons";
import { cn } from "../../lib/cn";
import type { ProductGroup } from "./types";

type Props = {
  group: ProductGroup;
};

/**
 * Product × entitlement grid for the selected group. Entitlement headers
 * render vertically so the matrix stays readable when a group grants
 * several keys. Hides the entitlement axis entirely when the group has
 * none (consumable-only groups still show the price/subs columns).
 */
export function ProductEntitlementMatrix({ group }: Props) {
  const { t } = useTranslation();
  const hasEntitlements = group.entitlements.length > 0;

  return (
    <section className="overflow-hidden rounded-lg border border-rv-divider bg-rv-c1">
      <header className="flex items-center justify-between border-b border-rv-divider px-5 py-3.5">
        <div>
          <h3 className="text-[14px] font-semibold">{t("productGroups.matrix.heading")}</h3>
          <p className="mt-0.5 text-[12px] text-rv-mute-500">
            {t("productGroups.matrix.subtitle")}
          </p>
        </div>
        {hasEntitlements && (
          <span className="inline-flex items-center gap-2 text-[11px] text-rv-mute-600">
            <span
              aria-hidden="true"
              className="inline-block size-2 rounded-sm bg-[color-mix(in_srgb,var(--color-rv-violet)_60%,white)]"
            />
            {t("productGroups.matrix.legend")}
          </span>
        )}
      </header>

      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <Th>{t("productGroups.matrix.cols.product")}</Th>
              <Th>{t("productGroups.matrix.cols.duration")}</Th>
              <Th align="right">{t("productGroups.matrix.cols.price")}</Th>
              <Th align="right">{t("productGroups.matrix.cols.subs")}</Th>
              <Th align="right">{t("productGroups.matrix.cols.mrr")}</Th>
              {group.entitlements.map((e) => (
                <th
                  key={e.key}
                  scope="col"
                  className="h-[120px] border-b border-rv-divider px-1.5 py-3 text-center font-rv-mono text-[11px] font-normal text-rv-mute-700 [writing-mode:vertical-rl] [transform:rotate(180deg)]"
                >
                  {e.key}
                </th>
              ))}
              <Th width={88}>{t("productGroups.matrix.cols.status")}</Th>
            </tr>
          </thead>
          <tbody>
            {group.products.map((p) => (
              <tr key={p.sku} className="transition hover:bg-rv-c2">
                <td className="border-b border-white/5 px-3.5 py-2.5">
                  <div className="flex min-w-0 items-center gap-2.5">
                    <ProductIcon name={p.sku.replace(/_/g, " ")} size="sm" />
                    <div className="min-w-0">
                      <div className="text-[13px] font-medium">{p.sku.replace(/_/g, " ")}</div>
                      <div className="font-rv-mono text-[11px] text-rv-mute-500">{p.sku}</div>
                    </div>
                  </div>
                </td>
                <td className="border-b border-white/5 px-3.5 py-2.5">
                  <DurationTag>{t(`productGroups.duration.${p.duration}`)}</DurationTag>
                </td>
                <td className="border-b border-white/5 px-3.5 py-2.5 text-right font-rv-mono tabular-nums">
                  {p.price}
                </td>
                <td className="border-b border-white/5 px-3.5 py-2.5 text-right font-rv-mono tabular-nums">
                  {p.subs == null ? "—" : p.subs.toLocaleString()}
                </td>
                <td className="border-b border-white/5 px-3.5 py-2.5 text-right font-rv-mono tabular-nums">
                  {p.mrr === 0 ? "—" : `$${p.mrr.toLocaleString()}`}
                </td>
                {group.entitlements.map((e) => {
                  const granted = p.grants.includes(e.key) && p.status !== "archived";
                  return (
                    <td
                      key={e.key}
                      className="border-b border-white/5 px-1.5 py-2.5 text-center"
                    >
                      <span
                        className={cn(
                          "inline-flex size-[18px] items-center justify-center rounded-md",
                          granted
                            ? "bg-rv-violet/20 text-[color-mix(in_srgb,var(--color-rv-violet)_25%,white)]"
                            : "text-rv-mute-400",
                        )}
                      >
                        {granted ? <IconCheck size={11} /> : <IconX size={10} />}
                      </span>
                    </td>
                  );
                })}
                <td className="border-b border-white/5 px-3.5 py-2.5">
                  <StatusChip status={p.status} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

type ThProps = {
  children: React.ReactNode;
  align?: "right";
  width?: number;
};

function Th({ children, align, width }: ThProps) {
  return (
    <th
      scope="col"
      style={width ? { width } : undefined}
      className={cn(
        "whitespace-nowrap border-b border-rv-divider px-3.5 py-2.5 text-[10px] font-medium uppercase tracking-wider text-rv-mute-500",
        align === "right" ? "text-right" : "text-left",
      )}
    >
      {children}
    </th>
  );
}
