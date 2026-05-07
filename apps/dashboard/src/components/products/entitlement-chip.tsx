import { cva, type VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export const entitlementChipVariants = cva(
  "inline-flex h-5 items-center gap-1 rounded-[4px] border px-1.5 font-rv-mono text-[10px]",
  {
    variants: {
      tone: {
        granted:
          "border-rv-violet/25 bg-rv-violet/15 text-[color-mix(in_srgb,var(--color-rv-violet)_25%,white)]",
        none: "border-rv-divider bg-rv-c4 text-rv-mute-500",
      },
    },
    defaultVariants: { tone: "granted" },
  },
);

export type EntitlementChipProps = VariantProps<typeof entitlementChipVariants> & {
  children: ReactNode;
  className?: string;
};

export function EntitlementChip({ tone, children, className }: EntitlementChipProps) {
  return <span className={cn(entitlementChipVariants({ tone }), className)}>{children}</span>;
}

type ListProps = {
  entitlements: ReadonlyArray<string>;
  /** When the list exceeds `max`, the remainder is shown as `+N`. */
  max?: number;
};

export function EntitlementList({ entitlements, max = 2 }: ListProps) {
  if (entitlements.length === 0) {
    return (
      <div className="flex flex-wrap gap-1">
        <EntitlementChip tone="none">—</EntitlementChip>
      </div>
    );
  }
  const head = entitlements.slice(0, max);
  const overflow = entitlements.length - head.length;
  return (
    <div className="flex flex-wrap gap-1">
      {head.map((e) => (
        <EntitlementChip key={e}>{e}</EntitlementChip>
      ))}
      {overflow > 0 && <EntitlementChip tone="none">+{overflow}</EntitlementChip>}
    </div>
  );
}
