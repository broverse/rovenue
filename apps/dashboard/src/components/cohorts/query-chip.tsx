import { X } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

type Props = {
  attribute?: ReactNode;
  op: ReactNode;
  value: ReactNode;
  trailing?: { op: ReactNode; value: ReactNode };
  onRemove?: () => void;
};

/**
 * Mono-chip used in the cohort definition rows. Shape matches the design
 * prototype: optional `attr op val [trailing]` with a remove affordance.
 */
export function QueryChip({ attribute, op, value, trailing, onRemove }: Props) {
  return (
    <span className="inline-flex h-7 items-center gap-1.5 rounded-md border border-rv-divider bg-rv-c3 px-2.5 font-rv-mono text-[11px] transition hover:bg-rv-c4">
      {attribute && <span className="text-rv-accent-400">{attribute}</span>}
      <span className="text-rv-mute-500">{op}</span>
      <span className="text-foreground">{value}</span>
      {trailing && (
        <>
          <span className="ml-1 text-rv-mute-500">{trailing.op}</span>
          <span className="text-foreground">{trailing.value}</span>
        </>
      )}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove condition"
          className="ml-1 -mr-0.5 cursor-pointer text-rv-mute-500 transition hover:text-foreground"
        >
          <X size={11} />
        </button>
      )}
    </span>
  );
}

export function AddConditionChip({ children }: { children: ReactNode }) {
  return (
    <button
      type="button"
      className={cn(
        "inline-flex h-7 cursor-pointer items-center rounded-md border border-dashed border-rv-divider px-2.5",
        "font-rv-mono text-[11px] text-rv-mute-500 transition hover:border-rv-mute-400 hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
