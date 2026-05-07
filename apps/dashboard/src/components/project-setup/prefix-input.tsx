import type { InputHTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/cn";

type PrefixInputProps = InputHTMLAttributes<HTMLInputElement> & {
  prefix: ReactNode;
  suffix?: ReactNode;
};

/**
 * Inline prefix segment glued to a borderless input. Used for slugs and
 * other URL-prefixed identifiers.
 */
export function PrefixInput({
  prefix,
  suffix,
  className,
  ...rest
}: PrefixInputProps) {
  return (
    <div
      className={cn(
        "flex items-stretch overflow-hidden rounded-md border border-rv-divider bg-rv-c2 transition focus-within:border-rv-accent-500 focus-within:ring-2 focus-within:ring-rv-accent-500/30",
        className,
      )}
    >
      <span className="inline-flex items-center border-r border-rv-divider bg-rv-c3 px-3 py-2 font-rv-mono text-[12px] text-rv-mute-500">
        {prefix}
      </span>
      <input
        className="flex-1 bg-transparent px-3 py-2 text-[13px] text-foreground placeholder:text-rv-mute-500 focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        {...rest}
      />
      {suffix ? (
        <span className="inline-flex items-center border-l border-rv-divider px-3 font-rv-mono text-[11px] text-rv-mute-500">
          {suffix}
        </span>
      ) : null}
    </div>
  );
}
