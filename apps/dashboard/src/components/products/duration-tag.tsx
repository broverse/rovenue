import { cva, type VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export const durationTagVariants = cva(
  "inline-flex h-5 items-center gap-1 rounded-[4px] border px-1.5 font-rv-mono text-[10px]",
  {
    variants: {
      tone: {
        default: "border-rv-divider bg-rv-c4 text-rv-mute-600",
        trial: "border-rv-warning/25 bg-rv-warning/10 text-rv-warning",
      },
    },
    defaultVariants: { tone: "default" },
  },
);

export type DurationTagProps = VariantProps<typeof durationTagVariants> & {
  children: ReactNode;
  className?: string;
};

/** Pill used in tables to show duration / trial period in mono type. */
export function DurationTag({ tone, children, className }: DurationTagProps) {
  return <span className={cn(durationTagVariants({ tone }), className)}>{children}</span>;
}
