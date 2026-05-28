import { cva, type VariantProps } from "class-variance-authority";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

export const accessChipVariants = cva(
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

export type AccessChipProps = VariantProps<typeof accessChipVariants> & {
  children: ReactNode;
  className?: string;
  title?: string;
};

export function AccessChip({ tone, children, className, title }: AccessChipProps) {
  return (
    <span className={cn(accessChipVariants({ tone }), className)} title={title}>
      {children}
    </span>
  );
}

/** One human-readable access entry — `identifier` is the slug,
 *  `displayName` is what the UI shows. */
export interface AccessChipEntry {
  id: string;
  identifier: string;
  displayName: string;
}

interface ListProps {
  access: ReadonlyArray<AccessChipEntry>;
  /** When the list exceeds `max`, the remainder is shown as `+N`. */
  max?: number;
}

export function AccessList({ access, max = 2 }: ListProps) {
  if (access.length === 0) {
    return (
      <div className="flex flex-wrap gap-1">
        <AccessChip tone="none">—</AccessChip>
      </div>
    );
  }
  const head = access.slice(0, max);
  const overflow = access.length - head.length;
  return (
    <div className="flex flex-wrap gap-1">
      {head.map((a) => (
        <AccessChip key={a.id} title={a.identifier}>
          {a.displayName}
        </AccessChip>
      ))}
      {overflow > 0 && <AccessChip tone="none">+{overflow}</AccessChip>}
    </div>
  );
}
