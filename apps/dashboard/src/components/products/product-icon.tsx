import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../../lib/cn";
import { productInitials } from "./format";

export const productIconVariants = cva(
  "inline-flex shrink-0 items-center justify-center rounded-md border border-rv-divider bg-rv-c3 font-rv-mono font-semibold uppercase text-rv-mute-600",
  {
    variants: {
      size: {
        sm: "size-7 text-[10px]",
        md: "size-9 text-[12px]",
        lg: "size-11 text-[13px]",
      },
    },
    defaultVariants: { size: "sm" },
  },
);

export type ProductIconProps = VariantProps<typeof productIconVariants> & {
  name: string;
  className?: string;
};

/**
 * Square initials avatar — falls back to two letters from the product name.
 */
export function ProductIcon({ name, size, className }: ProductIconProps) {
  return (
    <span aria-hidden="true" className={cn(productIconVariants({ size }), className)}>
      {productInitials(name)}
    </span>
  );
}
