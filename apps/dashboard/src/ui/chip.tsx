import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "../lib/cn";

export const chipVariants = cva(
  "inline-flex h-[22px] items-center gap-1 rounded-full px-2 font-rv-mono text-[11px] font-medium tabular-nums",
  {
    variants: {
      tone: {
        success: "bg-rv-success/15 text-rv-success",
        danger: "bg-rv-danger/15 text-rv-danger",
        warning: "bg-rv-warning/15 text-rv-warning",
        default: "bg-rv-c4 text-rv-mute-600",
        primary: "bg-rv-accent-500/15 text-rv-accent-500",
      },
    },
    defaultVariants: {
      tone: "default",
    },
  },
);

export type ChipProps = HTMLAttributes<HTMLSpanElement> & VariantProps<typeof chipVariants>;

/**
 * Pill-style status indicator — used for KPI deltas, chart legend tags,
 * and inline list badges.
 */
export const Chip = forwardRef<HTMLSpanElement, ChipProps>(function Chip(
  { tone, className, ...rest },
  ref,
) {
  return <span ref={ref} className={cn(chipVariants({ tone }), className)} {...rest} />;
});
