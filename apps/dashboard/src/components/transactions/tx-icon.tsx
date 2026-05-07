import { cva, type VariantProps } from "class-variance-authority";
import {
  Clock,
  CornerUpLeft,
  Plus,
  RotateCw,
  Sparkles,
  TriangleAlert,
  type LucideIcon,
} from "lucide-react";
import { cn } from "../../lib/cn";
import type { TxType } from "./types";

export const txIconVariants = cva(
  "inline-flex shrink-0 items-center justify-center rounded-[5px] border",
  {
    variants: {
      size: {
        sm: "size-6",
        md: "size-8",
      },
      type: {
        purchase:
          "border-rv-accent-500/30 bg-rv-accent-500/15 text-rv-accent-400",
        renewal:
          "border-rv-success/30 bg-rv-success/15 text-rv-success",
        refund:
          "border-rv-danger/30 bg-rv-danger/15 text-rv-danger",
        trial:
          "border-rv-warning/30 bg-rv-warning/15 text-rv-warning",
        chargeback:
          "border-rv-danger bg-rv-danger/25 text-white",
        credit:
          "border-rv-violet/30 bg-rv-violet/15 text-rv-violet",
      },
    },
    defaultVariants: { size: "sm", type: "purchase" },
  },
);

const TYPE_TO_ICON: Record<TxType, LucideIcon> = {
  purchase: Plus,
  renewal: RotateCw,
  refund: CornerUpLeft,
  trial: Clock,
  chargeback: TriangleAlert,
  credit: Sparkles,
};

type Props = Pick<VariantProps<typeof txIconVariants>, "size"> & {
  type: TxType;
  className?: string;
};

/** Square colored badge with a lucide glyph for each transaction type. */
export function TxIcon({ type, size, className }: Props) {
  const Icon = TYPE_TO_ICON[type];
  const px = size === "md" ? 14 : 12;
  return (
    <span className={cn(txIconVariants({ size, type }), className)}>
      <Icon size={px} strokeWidth={2.4} />
    </span>
  );
}
