import { useTranslation } from "react-i18next";
import { Layers } from "lucide-react";
import { Button } from "../../ui/button";
import { Sparkline } from "../dashboard/sparkline";
import { OfferingActionsMenu } from "./offering-actions-menu";
import { OfferingIcon } from "./offering-icon";
import type { Offering } from "./types";

type Props = {
  projectId: string;
  offering: Offering;
  onLinkProduct: () => void;
  onEdit: () => void;
  onDelete: () => void;
};

/**
 * Top header card for a selected offering. Renders the gradient
 * identity, description, primary actions, and a 4-cell KPI strip ending
 * with an inline 28-day MRR sparkline.
 */
export function OfferingHeader({
  projectId,
  offering,
  onLinkProduct,
  onEdit,
  onDelete,
}: Props) {
  const { t } = useTranslation();
  const archived = offering.products.filter((p) => p.status === "archived").length;
  const draft = offering.products.filter((p) => p.status === "draft").length;

  return (
    <div className="rounded-lg border border-rv-divider bg-rv-c1 p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <OfferingIcon initials={offering.initials} tint={offering.tint} size="lg" />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h2 className="text-[22px] font-semibold leading-7 tracking-tight">
                  {offering.name}
                </h2>
                {offering.isDefault && (
                  <span className="rounded-full border border-rv-accent-500/30 bg-rv-accent-500/10 px-2 py-0.5 font-rv-mono text-[10px] uppercase tracking-wider text-rv-accent-500">
                    {t("offerings.header.default", "Default")}
                  </span>
                )}
              </div>
              <div className="mt-0.5 font-rv-mono text-[12px] text-rv-mute-500">
                {offering.key}
              </div>
            </div>
          </div>
          {offering.description && (
            <p className="mt-2 max-w-[600px] text-[13px] text-rv-mute-600">
              {offering.description}
            </p>
          )}
        </div>

        <div className="flex flex-wrap gap-1.5">
          <Button variant="flat" size="sm" onClick={onLinkProduct}>
            <Layers size={13} />
            {t("offerings.actions.linkProduct")}
          </Button>
          <OfferingActionsMenu
            projectId={projectId}
            offering={offering}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        </div>
      </div>

      <div className="mt-4 grid grid-cols-2 gap-y-4 border-t border-rv-divider pt-4 sm:grid-cols-2 lg:grid-cols-4">
        <KpiCell
          label={t("offerings.kpi.mrr")}
          value={`$${offering.mrr.toLocaleString()}`}
          delta={t("offerings.kpi.deltaMrr")}
          deltaTone="success"
          first
        />
        <KpiCell
          label={t("offerings.kpi.activeSubs")}
          value={offering.subs == null ? "—" : offering.subs.toLocaleString()}
          delta={t("offerings.kpi.deltaSubs")}
          deltaTone="success"
        />
        <KpiCell
          label={t("offerings.kpi.products")}
          value={offering.products.length.toString()}
          delta={t("offerings.kpi.productsBreakdown", { archived, draft })}
        />
        <KpiCell label={t("offerings.kpi.mrr28d")} last>
          <div className="mt-0.5">
            <Sparkline data={offering.spark} color="var(--color-rv-accent-500)" height={38} />
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
