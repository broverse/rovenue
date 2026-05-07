import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/cn";

export const productGroupIconVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center rounded-lg font-rv-mono font-semibold uppercase text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.18)]",
  {
    variants: {
      size: {
        sm: "size-8 text-[11px]",
        md: "size-10 text-[12px]",
        lg: "size-11 text-[13px]",
      },
    },
    defaultVariants: { size: "sm" },
  },
);

export type ProductGroupIconProps = VariantProps<typeof productGroupIconVariants> & {
  initials: string;
  /** CSS gradient (or any background value) applied to the tile. */
  tint: string;
  className?: string;
};

/**
 * Gradient-tinted initials avatar used in the product-groups list, header
 * and matrix rows. Pure presentation — `tint` is forwarded to inline style
 * so each group keeps its bespoke palette.
 */
export function ProductGroupIcon({ initials, tint, size, className }: ProductGroupIconProps) {
  return (
    <span
      aria-hidden="true"
      className={cn(productGroupIconVariants({ size }), className)}
      style={{ background: tint }}
    >
      {initials}
    </span>
  );
}
