import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type InputHTMLAttributes } from "react";
import { cn } from "../lib/cn";

export const inputVariants = cva(
  "w-full rounded-md border border-rv-divider bg-rv-c2 px-3 py-2 text-[13px] text-foreground transition placeholder:text-rv-mute-500 focus:border-rv-accent-500 focus:outline-none focus:ring-2 focus:ring-rv-accent-500/30 disabled:cursor-not-allowed disabled:opacity-60",
  {
    variants: {
      mono: {
        true: "font-rv-mono text-[12px]",
        false: "",
      },
    },
    defaultVariants: {
      mono: false,
    },
  },
);

export type InputProps = InputHTMLAttributes<HTMLInputElement> &
  VariantProps<typeof inputVariants>;

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { mono, className, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn(inputVariants({ mono }), className)}
      {...rest}
    />
  );
});
