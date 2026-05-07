import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../lib/cn";

export const statCardVariants = cva(
  "rounded-lg border border-rv-divider bg-rv-c1 transition",
  {
    variants: {
      density: {
        compact: "px-4 py-3.5",
        comfortable: "px-5 py-4",
      },
    },
    defaultVariants: { density: "compact" },
  },
);

export const statValueToneVariants = cva("mt-1 font-rv-mono text-[20px] font-medium tabular-nums", {
  variants: {
    tone: {
      default: "text-foreground",
      muted: "text-rv-mute-700",
    },
  },
  defaultVariants: { tone: "default" },
});

export const statDescriptionToneVariants = cva("mt-0.5 font-rv-mono text-[11px]", {
  variants: {
    tone: {
      default: "text-rv-mute-500",
      success: "text-rv-success",
      danger: "text-rv-danger",
      warning: "text-rv-warning",
    },
  },
  defaultVariants: { tone: "default" },
});

type DescriptionTone = NonNullable<VariantProps<typeof statDescriptionToneVariants>["tone"]>;

export type StatCardProps = HTMLAttributes<HTMLDivElement> &
  VariantProps<typeof statCardVariants> & {
    label: ReactNode;
    value: ReactNode;
    description?: ReactNode;
    descriptionTone?: DescriptionTone;
  };

/**
 * Compact metric tile — uppercase label, tabular-num value, single line of
 * detail underneath. Used in page-header KPI rows. For the bigger
 * sparkline-driven dashboard tile use `KpiCard` instead.
 */
export function StatCard({
  label,
  value,
  description,
  descriptionTone,
  density,
  className,
  ...rest
}: StatCardProps) {
  return (
    <div className={cn(statCardVariants({ density }), className)} {...rest}>
      <div className="text-[10px] font-medium uppercase tracking-wider text-rv-mute-500">
        {label}
      </div>
      <div className={statValueToneVariants({ tone: "default" })}>{value}</div>
      {description && (
        <div className={statDescriptionToneVariants({ tone: descriptionTone })}>{description}</div>
      )}
    </div>
  );
}
