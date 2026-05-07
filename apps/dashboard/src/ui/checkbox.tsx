import { cva, type VariantProps } from "class-variance-authority";
import type { MouseEvent } from "react";
import { Check } from "lucide-react";
import { cn } from "../lib/cn";

export const checkboxVariants = cva(
  "relative inline-flex shrink-0 cursor-pointer items-center justify-center rounded-[3px] border transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rv-accent-500 focus-visible:ring-offset-1 focus-visible:ring-offset-rv-bg",
  {
    variants: {
      size: {
        sm: "size-[14px]",
        md: "size-4",
      },
      state: {
        unchecked: "border-rv-mute-400 bg-transparent hover:border-rv-mute-500",
        checked: "border-rv-accent-500 bg-rv-accent-500",
        indeterminate: "border-rv-accent-500 bg-rv-accent-500",
      },
    },
    defaultVariants: {
      size: "sm",
      state: "unchecked",
    },
  },
);

export type CheckboxProps = Omit<VariantProps<typeof checkboxVariants>, "state"> & {
  checked: boolean;
  indeterminate?: boolean;
  onChange: () => void;
  ariaLabel?: string;
  className?: string;
};

/**
 * Tri-state checkbox (unchecked / checked / indeterminate). Click handler
 * stops propagation so it works inside row-click table cells.
 */
export function Checkbox({
  checked,
  indeterminate,
  onChange,
  ariaLabel,
  size,
  className,
}: CheckboxProps) {
  const state: "unchecked" | "checked" | "indeterminate" = indeterminate
    ? "indeterminate"
    : checked
      ? "checked"
      : "unchecked";
  const handleClick = (e: MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation();
    onChange();
  };
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={indeterminate ? "mixed" : checked}
      aria-label={ariaLabel}
      onClick={handleClick}
      className={cn(checkboxVariants({ size, state }), className)}
    >
      {state === "checked" && (
        <Check className="size-3 text-white" strokeWidth={2.4} aria-hidden="true" />
      )}
      {state === "indeterminate" && <span className="block h-[1.5px] w-[7px] bg-white" />}
    </button>
  );
}
