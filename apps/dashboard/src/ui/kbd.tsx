import { cva, type VariantProps } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../lib/cn";

export const kbdVariants = cva(
  "inline-flex items-center rounded border border-rv-divider bg-rv-c4 font-rv-mono text-rv-mute-600",
  {
    variants: {
      size: {
        sm: "h-[18px] px-1.5 text-[10px]",
        md: "h-5 px-2 text-[11px]",
      },
    },
    defaultVariants: { size: "sm" },
  },
);

export type KbdProps = HTMLAttributes<HTMLElement> & VariantProps<typeof kbdVariants>;

/**
 * Inline keyboard shortcut indicator. Shared across topbar, sidebar search
 * and page-level hint strips.
 */
export function Kbd({ size, className, children, ...rest }: KbdProps) {
  return (
    <kbd className={cn(kbdVariants({ size }), className)} {...rest}>
      {children}
    </kbd>
  );
}
