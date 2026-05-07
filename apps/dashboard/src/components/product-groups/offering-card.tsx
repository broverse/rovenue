import { useTranslation } from "react-i18next";
import { Chip } from "../../ui/chip";
import { IconTag } from "../dashboard/icons";
import { cn } from "../../lib/cn";
import type { Offering } from "./types";

type Props = {
  offering: Offering;
};

/**
 * Single offering tile rendered inside the offerings grid. Highlights the
 * default offering with an accent border + glow and surfaces the SKUs it
 * references plus mock paywall analytics.
 */
export function OfferingCard({ offering }: Props) {
  const { t } = useTranslation();
  const goodConv = offering.conv > 8;
  return (
    <div
      className={cn(
        "rounded-lg border border-rv-divider bg-rv-c1 p-3.5 transition hover:border-rv-divider-strong",
        offering.isDefault &&
          "border-rv-accent-500/40 shadow-[0_0_0_1px_color-mix(in_srgb,var(--color-rv-accent-500)_25%,transparent)]",
      )}
    >
      <div className="flex items-center justify-between">
        <div className="flex min-w-0 items-center gap-2">
          <IconTag size={13} className="text-rv-accent-500" />
          <span className="font-rv-mono text-[11px] text-rv-mute-500">{offering.name}</span>
        </div>
        {offering.isDefault && <Chip tone="primary">{t("productGroups.offerings.default")}</Chip>}
      </div>

      <div className="mt-2.5 flex flex-wrap gap-1">
        {offering.products.map((sku) => (
          <span
            key={sku}
            className="inline-flex h-[22px] items-center gap-1 rounded-[4px] border border-rv-divider bg-rv-c3 px-2 font-rv-mono text-[10px] text-rv-mute-700"
          >
            <span className="text-rv-mute-500">◇</span>
            {sku}
          </span>
        ))}
      </div>

      <div className="mt-2.5 flex justify-between border-t border-rv-divider pt-2.5 font-rv-mono text-[11px] text-rv-mute-500">
        <span>
          {t("productGroups.offerings.views")}{" "}
          <span className="text-foreground">{offering.views.toLocaleString()}</span>
        </span>
        <span>
          {t("productGroups.offerings.conv")}{" "}
          <span className={goodConv ? "text-rv-success" : "text-foreground"}>
            {offering.conv}%
          </span>
        </span>
      </div>
    </div>
  );
}
