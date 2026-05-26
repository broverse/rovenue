import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { StoreBreakdown, type StoreBreakdownRow } from "./store-breakdown";
import { VolumeGraph } from "./volume-graph";
import type { VolumeBar } from "./types";

export type RevenueFlowTotals = {
  /** Pre-formatted gross USD (e.g. "$248,192"). */
  gross?: string;
  /** Pre-formatted estimated store fees total. */
  fees?: string;
  /** Pre-formatted refunds total. */
  refunds?: string;
  /** Pre-formatted net (gross − fees − refunds). */
  net?: string;
  /** Total event count across the window. */
  eventCount?: number;
  /** Mix-weighted estimated fee rate, 0–100. */
  estimatedFeePct?: number;
  /** Refunds as a percentage of gross, 0–100. */
  refundsPct?: number;
  /** Delta vs the same-length previous window, in percentage points. */
  deltaPct?: number | null;
  /** When the underlying query was last refreshed (epoch ms). */
  lastSyncMs?: number;
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
  tone?: "default" | "primary" | "danger" | "warning" | "muted";
  detailTone?: "default" | "success" | "danger";
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
        tone === "muted" && "border-rv-divider",
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
          tone === "muted" && "text-rv-mute-500",
          tone === "default" && "text-foreground",
        )}
      >
        {value}
      </div>
      <div
        className={cn(
          "mt-0.5 font-rv-mono text-[10px]",
          detailTone === "success" && "text-rv-success",
          detailTone === "danger" && "text-rv-danger",
          detailTone === "default" && "text-rv-mute-500",
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

const RELATIVE_FORMAT = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

function formatRelative(ms: number, nowMs: number): string {
  const diff = ms - nowMs;
  const absSec = Math.abs(diff) / 1000;
  if (absSec < 60) return RELATIVE_FORMAT.format(Math.round(diff / 1000), "second");
  if (absSec < 3600) return RELATIVE_FORMAT.format(Math.round(diff / 60_000), "minute");
  if (absSec < 86_400) return RELATIVE_FORMAT.format(Math.round(diff / 3_600_000), "hour");
  return RELATIVE_FORMAT.format(Math.round(diff / 86_400_000), "day");
}

const PCT_ONE = new Intl.NumberFormat("en-US", { maximumFractionDigits: 1 });

export function RevenueFlow({ totals, volume, storeRows }: RevenueFlowProps = {}) {
  const { t } = useTranslation();
  const hasData = Boolean(totals?.gross);

  const grossValue = totals?.gross ?? "—";
  const feesValue = totals?.fees ?? "—";
  const refundsValue = totals?.refunds ?? "—";
  const netValue = totals?.net ?? "—";

  const grossDetail = hasData
    ? t("transactions.flow.grossDetail", {
        count: (totals?.eventCount ?? 0).toLocaleString(),
      })
    : t("transactions.flow.awaiting");
  const feesDetail = hasData
    ? t("transactions.flow.feesDetail", {
        percent: PCT_ONE.format(totals?.estimatedFeePct ?? 0),
      })
    : t("transactions.flow.awaiting");
  const refundsDetail = hasData
    ? t("transactions.flow.refundsDetail", {
        percent: PCT_ONE.format(totals?.refundsPct ?? 0),
      })
    : t("transactions.flow.awaiting");
  const netDetail =
    hasData && totals?.deltaPct !== null && totals?.deltaPct !== undefined
      ? totals.deltaPct >= 0
        ? t("transactions.flow.netDetailUp", {
            percent: PCT_ONE.format(totals.deltaPct),
          })
        : t("transactions.flow.netDetailDown", {
            percent: PCT_ONE.format(Math.abs(totals.deltaPct)),
          })
      : t("transactions.flow.netDetailFlat");
  const netTone: "default" | "success" | "danger" =
    hasData && typeof totals?.deltaPct === "number"
      ? totals.deltaPct >= 0
        ? "success"
        : "danger"
      : "default";

  const lastSync =
    typeof totals?.lastSyncMs === "number"
      ? t("transactions.flow.lastSync", {
          when: formatRelative(totals.lastSyncMs, Date.now()),
        })
      : t("transactions.flow.lastSyncUnknown");

  return (
    <section className="mb-4 rounded-lg border border-rv-divider bg-rv-c1 px-5 py-4">
      <header className="mb-3.5 flex items-baseline justify-between">
        <div>
          <h3 className="m-0 text-[14px] font-semibold">{t("transactions.flow.title")}</h3>
          <div className="text-[12px] text-rv-mute-500">{t("transactions.flow.subtitle")}</div>
        </div>
        <span className="font-rv-mono text-[11px] text-rv-mute-500">{lastSync}</span>
      </header>

      <div className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)] items-stretch gap-3">
        <FlowNode
          label={t("transactions.flow.gross")}
          value={grossValue}
          detail={grossDetail}
          tone={hasData ? "default" : "muted"}
        />
        <FlowOp>−</FlowOp>
        <FlowNode
          label={t("transactions.flow.fees")}
          value={feesValue}
          detail={feesDetail}
          tone={hasData ? "danger" : "muted"}
        />
        <FlowOp>−</FlowOp>
        <FlowNode
          label={t("transactions.flow.refunds")}
          value={refundsValue}
          detail={refundsDetail}
          tone={hasData ? "warning" : "muted"}
        />
        <FlowOp>=</FlowOp>
        <FlowNode
          label={t("transactions.flow.net")}
          value={netValue}
          detail={netDetail}
          tone={hasData ? "primary" : "muted"}
          detailTone={netTone}
        />
      </div>

      <VolumeGraph series={volume} />
      <StoreBreakdown rows={storeRows} />
    </section>
  );
}
