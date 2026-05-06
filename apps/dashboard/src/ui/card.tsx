import { cva, type VariantProps } from "class-variance-authority";
import { forwardRef, type HTMLAttributes, type ReactNode } from "react";
import { cn } from "../lib/cn";

export const cardVariants = cva("rounded-lg border border-rv-divider bg-rv-c1", {
  variants: {
    interactive: {
      true: "transition hover:border-rv-divider-strong cursor-pointer",
    },
    padded: {
      true: "p-5",
    },
  },
});

export type CardProps = HTMLAttributes<HTMLDivElement> & VariantProps<typeof cardVariants>;

/**
 * Surface used for every dashboard panel. Background, divider border, fixed
 * radius. Compose with `<CardHeader>` for the title row.
 */
export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { interactive, padded, className, ...rest },
  ref,
) {
  return (
    <div
      ref={ref}
      className={cn(cardVariants({ interactive, padded }), className)}
      {...rest}
    />
  );
});

type HeaderProps = {
  title: ReactNode;
  subtitle?: ReactNode;
  right?: ReactNode;
  className?: string;
};

export function CardHeader({ title, subtitle, right, className }: HeaderProps) {
  return (
    <div className={cn("flex items-start justify-between px-5 pt-4 pb-2", className)}>
      <div>
        <div className="text-[14px] font-semibold">{title}</div>
        {subtitle && <div className="mt-0.5 text-[12px] text-rv-mute-500">{subtitle}</div>}
      </div>
      {right && <div className="shrink-0">{right}</div>}
    </div>
  );
}

export function CardFooter({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("border-t border-rv-divider px-5 py-2.5", className)}>{children}</div>
  );
}
