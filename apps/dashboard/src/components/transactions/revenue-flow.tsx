import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { StoreBreakdown, type StoreBreakdownRow } from "./store-breakdown";
import { VolumeGraph } from "./volume-graph";
import type { VolumeBar } from "./types";

export type RevenueFlowTotals = {
  /** Pre-formatted gross USD (e.g. "$248,192"). */
  gross?: string;
  /** Pre-formatted refunds total. */
  refunds?: string;
  /** Pre-formatted net (gross − refunds when fees aren't known). */
  net?: string;
};

type RevenueFlowProps = {
  totals?: RevenueFlowTotals;
  volume?: ReadonlyArray<VolumeBar>;
  storeRows?: ReadonlyArray<StoreBreakdownRow>;
};

type FlowNodeProps = {
  label: string;
  value: string;
  detail: string;
  tone?: "default" | "primary" | "danger" | "warning";
  detailTone?: "default" | "success";
};

function FlowNode({ label, value, detail, tone = "default", detailTone = "default" }: FlowNodeProps) {
  return (
    <div
      className={cn(
        "min-w-0 rounded-md border bg-rv-c2 px-3.5 py-3",
        tone === "default" && "border-rv-divider",
        tone === "primary" && "border-rv-accent-500/35 bg-rv-accent-500/[0.12]",
        tone === "danger" && "border-rv-divider",
        tone === "warning" && "border-rv-divider",
      )}
    >
      <div className="text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
        {label}
      </div>
      <div
        className={cn(
          "mt-1 font-rv-mono text-[18px] font-medium tabular-nums",
          tone === "primary" && "text-[color-mix(in_srgb,var(--color-rv-accent-400)_80%,white)]",
          tone === "danger" && "text-rv-danger",
          tone === "warning" && "text-rv-warning",
          tone === "default" && "text-foreground",
        )}
      >
        {value}
      </div>
      <div
        className={cn(
          "mt-0.5 font-rv-mono text-[10px]",
          detailTone === "success" ? "text-rv-success" : "text-rv-mute-500",
        )}
      >
        {detail}
      </div>
    </div>
  );
}

function FlowOp({ children }: { children: string }) {
  return (
    <div className="flex items-center justify-center font-rv-mono text-[16px] font-medium text-rv-mute-500">
      {children}
    </div>
  );
}

/**
 * Revenue flow card — displays "gross − fees − refunds = net" as a
 * row of value boxes joined by mathematical operators, then the 28-day
 * stacked volume graph and the per-store breakdown underneath.
 */
export function RevenueFlow({ totals, volume, storeRows }: RevenueFlowProps = {}) {
  const { t } = useTranslation();
  return (
    <section className="mb-4 rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4">
      <header className="mb-3.5 flex items-baseline justify-between">
        <div>
          <h3 className="m-0 text-[14px] font-semibold">{t("transactions.flow.title")}</h3>
          <div className="text-[12px] text-rv-mute-500">{t("transactions.flow.subtitle")}</div>
        </div>
        <span className="font-rv-mono text-[11px] text-rv-mute-500">
          {t("transactions.flow.lastSync")}
        </span>
      </header>

      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)] items-stretch gap-3">
        <FlowNode
          label={t("transactions.flow.gross")}
          value={totals?.gross ?? "$248,192"}
          detail={t("transactions.flow.grossDetail")}
        />
        <FlowOp>−</FlowOp>
        <FlowNode
          label={t("transactions.flow.fees")}
          value="$37,229"
          detail={t("transactions.flow.feesDetail")}
          tone="danger"
        />
        <FlowOp>−</FlowOp>
        <FlowNode
          label={t("transactions.flow.refunds")}
          value={totals?.refunds ?? "$24,823"}
          detail={t("transactions.flow.refundsDetail")}
          tone="warning"
        />
        <FlowOp>=</FlowOp>
        <FlowNode
          label={t("transactions.flow.net")}
          value={totals?.net ?? "$186,140"}
          detail={t("transactions.flow.netDetail")}
          tone="primary"
          detailTone="success"
        />
      </div>

      <VolumeGraph series={volume} />
      <StoreBreakdown rows={storeRows} />
    </section>
  );
}
