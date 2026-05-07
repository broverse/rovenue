import { Fragment } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../lib/cn";
import { FLOW_NODES } from "./mock-data";
import type { FlowBreakdown, FlowNode } from "./types";

const NODE_TONE: Record<FlowNode["id"], string> = {
  in: "border-rv-success/30",
  balance:
    "border-rv-accent-500/35 bg-[linear-gradient(135deg,color-mix(in_srgb,var(--color-rv-accent-500)_12%,var(--color-rv-c2)),var(--color-rv-c2))]",
  out: "border-rv-violet/30",
};

const TOTAL_TONE: Record<FlowNode["id"], string> = {
  in: "text-rv-success",
  balance: "text-rv-accent-400",
  out: "text-rv-violet",
};

const BREAKDOWN_TONE: Record<NonNullable<FlowBreakdown["tone"]>, string> = {
  default: "text-rv-mute-700",
  accent: "text-rv-accent-400",
  warning: "text-rv-warning",
  muted: "text-rv-mute-500",
};

/**
 * Three-card flow: Inflow → Balance → Outflow. On wide screens the
 * arrows sit between the cards; below 1100px the grid collapses to a
 * single column and the arrows rotate 90° to read top-to-bottom.
 */
export function CreditFlow() {
  const { t } = useTranslation();
  return (
    <div className="mb-4 grid items-center gap-4 rounded-lg border border-rv-divider bg-rv-c1 px-6 py-5 max-[1100px]:grid-cols-1 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)_auto_minmax(0,1fr)]">
      {FLOW_NODES.map((node, idx) => (
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
          {idx < FLOW_NODES.length - 1 ? (
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
