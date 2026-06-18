import { forwardRef, type SelectHTMLAttributes } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "../lib/cn";

export type NativeSelectProps = SelectHTMLAttributes<HTMLSelectElement>;

export const NativeSelect = forwardRef<HTMLSelectElement, NativeSelectProps>(function NativeSelect(
  { className, children, ...rest },
  ref,
) {
  return (
    <div className="relative">
      <select
        ref={ref}
        className={cn(
          "w-full appearance-none rounded-md border border-rv-divider bg-rv-c2 px-3 py-2 pr-9 text-[13px] text-foreground transition focus:border-rv-accent-500 focus:outline-none focus:ring-2 focus:ring-rv-accent-500/30 disabled:cursor-not-allowed disabled:opacity-60",
          className,
        )}
        {...rest}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-2.5 top-1/2 size-4 -translate-y-1/2 text-rv-mute-500"
        aria-hidden="true"
      />
    </div>
  );
});
