import { Fragment, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { CreditsFlow } from "@rovenue/shared";
import { cn } from "../../lib/cn";
import { formatCompact, formatDelta } from "./format";

type NodeId = "in" | "balance" | "out";

interface BreakdownRow {
  labelKey: string;
  value: string;
  tone?: "default" | "accent" | "muted";
}

interface NodeViewModel {
  id: NodeId;
  titleKey: string;
  total: string;
  breakdown: BreakdownRow[];
}

const NODE_TONE: Record<NodeId, string> = {
  in: "border-rv-success/30",
  balance:
    "border-rv-accent-500/35 bg-[linear-gradient(135deg,color-mix(in_srgb,var(--color-rv-accent-500)_12%,var(--color-rv-c2)),var(--color-rv-c2))]",
  out: "border-rv-violet/30",
};

const TOTAL_TONE: Record<NodeId, string> = {
  in: "text-rv-success",
  balance: "text-rv-accent-400",
  out: "text-rv-violet",
};

const BREAKDOWN_TONE: Record<NonNullable<BreakdownRow["tone"]>, string> = {
  default: "text-rv-mute-700",
  accent: "text-rv-accent-400",
  muted: "text-rv-mute-500",
};

function pctOf(part: number, total: number): string {
  if (total <= 0) return "0%";
  return `${Math.round((part / total) * 100)}%`;
}

function buildNodes(flow: CreditsFlow): NodeViewModel[] {
  const inflow = flow.inflowByType;
  const outflow = flow.outflowByType;
  const balance = flow.balanceByType;

  return [
    {
      id: "in",
      titleKey: "credits.flow.inflow",
      total: formatDelta(flow.inflow),
      breakdown: [
        { labelKey: "credits.flow.purchases", value: formatCompact(inflow.purchase) },
        { labelKey: "credits.flow.bonus", value: formatCompact(inflow.bonus) },
        { labelKey: "credits.flow.refund", value: formatCompact(inflow.refund) },
        {
          labelKey: "credits.flow.transferIn",
          value: formatCompact(inflow.transferIn),
          tone: "muted",
        },
      ],
    },
    {
      id: "balance",
      titleKey: "credits.flow.balance",
      total: formatCompact(flow.balance),
      breakdown: [
        {
          labelKey: "credits.flow.paidLiability",
          value: `${formatCompact(balance.paid)} · ${pctOf(balance.paid, flow.balance)}`,
          tone: "accent",
        },
        {
          labelKey: "credits.flow.bonusPromo",
          value: `${formatCompact(balance.promo)} · ${pctOf(balance.promo, flow.balance)}`,
        },
        {
          labelKey: "credits.flow.transferShare",
          value: `${formatCompact(balance.transfer)} · ${pctOf(balance.transfer, flow.balance)}`,
          tone: "muted",
        },
      ],
    },
    {
      id: "out",
      titleKey: "credits.flow.outflow",
      total: `-${formatCompact(flow.outflow)}`,
      breakdown: [
        { labelKey: "credits.flow.consumed", value: formatCompact(outflow.spend) },
        { labelKey: "credits.flow.expired", value: formatCompact(outflow.expire) },
        {
          labelKey: "credits.flow.transferOut",
          value: formatCompact(outflow.transferOut),
          tone: "muted",
        },
      ],
    },
  ];
}

/**
 * Three-card flow: Inflow → Balance → Outflow. On wide screens the
 * arrows sit between the cards; below 1100px the grid collapses to a
 * single column and the arrows rotate 90° to read top-to-bottom.
 *
 * Renders a skeleton (zeroed totals) while `flow` is undefined so
 * the layout doesn't pop when the rollup query resolves.
 */
export function CreditFlow({ flow }: { flow?: CreditsFlow }) {
  const { t } = useTranslation();
  const nodes = useMemo(
    () => (flow ? buildNodes(flow) : buildNodes(EMPTY_FLOW)),
    [flow],
  );

  return (
    <div className="mb-4 grid items-center gap-4 rounded-lg border border-rv-divider bg-rv-c1 px-6 py-5 max-[1100px]:grid-cols-1 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
      {nodes.map((node, idx) => (
        <Fragment key={node.id}>
          <div className={cn("rounded-md border bg-rv-c2 px-4 py-3.5", NODE_TONE[node.id])}>
            <h4 className="text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
              {t(node.titleKey)}
            </h4>
            <div
              className={cn(
                "mt-1 font-rv-mono text-[22px] font-medium tabular-nums",
                TOTAL_TONE[node.id],
              )}
            >
              {node.total}
            </div>
            <div className="mt-3 flex flex-col gap-1.5 border-t border-rv-divider pt-3">
              {node.breakdown.map((row) => (
                <div
                  key={row.labelKey}
                  className="grid grid-cols-[1fr_auto] items-baseline gap-2 text-[11px]"
                >
                  <span className="truncate text-rv-mute-600">{t(row.labelKey)}</span>
                  <span
                    className={cn(
                      "whitespace-nowrap font-rv-mono",
                      BREAKDOWN_TONE[row.tone ?? "default"],
                    )}
                  >
                    {row.value}
                  </span>
                </div>
              ))}
            </div>
          </div>
          {idx < nodes.length - 1 ? (
            <span
              aria-hidden
              className="text-center font-rv-mono text-[18px] text-rv-mute-400 max-[1100px]:rotate-90"
            >
              →
            </span>
          ) : null}
        </Fragment>
      ))}
    </div>
  );
}

const EMPTY_FLOW: CreditsFlow = {
  inflow: 0,
  outflow: 0,
  balance: 0,
  inflowByType: {
    purchase: 0,
    bonus: 0,
    refund: 0,
    transferIn: 0,
    spend: 0,
    expire: 0,
    transferOut: 0,
  },
  outflowByType: {
    purchase: 0,
    bonus: 0,
    refund: 0,
    transferIn: 0,
    spend: 0,
    expire: 0,
    transferOut: 0,
  },
  balanceByType: { paid: 0, promo: 0, transfer: 0 },
};
