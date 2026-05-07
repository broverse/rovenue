import { useTranslation } from "react-i18next";
import { Button } from "../../ui/button";
import { Key, Layers, MoreHorizontal, Tag } from "lucide-react";
import { Sparkline } from "../dashboard/sparkline";
import { ProductGroupIcon } from "./product-group-icon";
import type { ProductGroup } from "./types";

type Props = {
  group: ProductGroup;
};

/**
 * Top header card for a selected product group. Renders the gradient
 * identity, description, primary actions, and a 5-cell KPI strip ending
 * with an inline 28-day MRR sparkline.
 */
export function ProductGroupHeader({ group }: Props) {
  const { t } = useTranslation();
  const archived = group.products.filter((p) => p.status === "archived").length;
  const draft = group.products.filter((p) => p.status === "draft").length;
  const defaults = group.offerings.filter((o) => o.isDefault).length;

  return (
    <div className="rounded-lg border border-rv-divider bg-rv-c1 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <ProductGroupIcon initials={group.initials} tint={group.tint} size="lg" />
            <div className="min-w-0">
              <h2 className="text-[22px] font-semibold leading-7 tracking-tight">
                {group.name}
              </h2>
              <div className="mt-0.5 font-rv-mono text-[12px] text-rv-mute-500">
                {group.key}
              </div>
            </div>
          </div>
          <p className="mt-2 max-w-[600px] text-[13px] text-rv-mute-600">{group.description}</p>
        </div>

        <div className="flex flex-wrap gap-1.5">
          <Button variant="flat" size="sm">
            <Layers size={13} />
            {t("productGroups.actions.linkProduct")}
          </Button>
          <Button variant="flat" size="sm">
            <Key size={13} />
            {t("productGroups.actions.addEntitlement")}
          </Button>
          <Button variant="flat" size="sm">
            <Tag size={13} />
            {t("productGroups.actions.newOffering")}
          </Button>
          <Button variant="light" size="icon" aria-label={t("productGroups.actions.more")}>
            <MoreHorizontal size={14} />
          </Button>
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-y-4 border-t border-rv-divider pt-4 sm:grid-cols-3 lg:grid-cols-5">
        <KpiCell
          label={t("productGroups.kpi.mrr")}
          value={`$${group.mrr.toLocaleString()}`}
          delta={t("productGroups.kpi.deltaMrr")}
          deltaTone="success"
          first
        />
        <KpiCell
          label={t("productGroups.kpi.activeSubs")}
          value={group.subs == null ? "—" : group.subs.toLocaleString()}
          delta={t("productGroups.kpi.deltaSubs")}
          deltaTone="success"
        />
        <KpiCell
          label={t("productGroups.kpi.products")}
          value={group.products.length.toString()}
          delta={t("productGroups.kpi.productsBreakdown", { archived, draft })}
        />
        <KpiCell
          label={t("productGroups.kpi.offerings")}
          value={group.offerings.length.toString()}
          delta={t("productGroups.kpi.offeringsDefault", { count: defaults })}
        />
        <KpiCell label={t("productGroups.kpi.mrr28d")} last>
          <div className="mt-0.5">
            <Sparkline data={group.spark} color="var(--color-rv-accent-500)" height={38} />
          </div>
        </KpiCell>
      </div>
    </div>
  );
}

type KpiProps = {
  label: string;
  value?: string;
  delta?: string;
  deltaTone?: "success" | "muted";
  first?: boolean;
  last?: boolean;
  children?: React.ReactNode;
};

function KpiCell({ label, value, delta, deltaTone = "muted", first, last, children }: KpiProps) {
  return (
    <div
      className={[
        "px-4",
        first ? "pl-0" : "",
        last ? "pr-0" : "",
        !last ? "border-r border-rv-divider" : "",
        "max-sm:!border-r-0 max-sm:!pl-0 max-sm:!pr-0",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
        {label}
      </div>
      {value && (
        <div className="mt-1 font-rv-mono text-[22px] font-medium tabular-nums">{value}</div>
      )}
      {children}
      {delta && (
        <div
          className={[
            "mt-0.5 font-rv-mono text-[11px]",
            deltaTone === "success" ? "text-rv-success" : "text-rv-mute-500",
          ].join(" ")}
        >
          {delta}
        </div>
      )}
    </div>
  );
}
