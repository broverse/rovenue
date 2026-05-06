import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type ButtonHTMLAttributes } from "react";
import { cn } from "../lib/cn";

export const buttonVariants = cva(
  "inline-flex items-center gap-1.5 rounded-md font-medium transition cursor-pointer whitespace-nowrap border border-transparent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-rv-accent-500 focus-visible:ring-offset-2 focus-visible:ring-offset-rv-bg disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        "solid-primary": "bg-rv-accent-500 text-white hover:bg-rv-accent-600",
        flat: "bg-rv-c2 border border-rv-divider text-rv-mute-800 hover:bg-rv-c3 hover:border-rv-divider-strong",
        light: "text-rv-mute-600 hover:bg-rv-c2 hover:text-foreground",
        "icon-light": "text-rv-mute-600 hover:bg-rv-c2 hover:text-foreground",
      },
      size: {
        sm: "h-8 px-3 text-[13px]",
        md: "h-9 px-3.5 text-[13px]",
        icon: "size-8 p-0 justify-center",
      },
    },
    defaultVariants: {
      variant: "light",
      size: "sm",
    },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, className, type = "button", ...rest },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      className={cn(buttonVariants({ variant, size }), className)}
      {...rest}
    />
  );
});
