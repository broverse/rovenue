import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

type FieldProps = {
  label: ReactNode;
  hint?: ReactNode;
  optional?: ReactNode;
  error?: boolean;
  children: ReactNode;
  className?: string;
};

/**
 * Wraps a form control with a top label row and a bottom hint. Optional
 * affordance is right-aligned next to the label so that "required" or
 * counters render consistently across every step of the setup wizard.
 */
export function Field({
  label,
  hint,
  optional,
  error,
  children,
  className,
}: FieldProps) {
  return (
    <div className={cn("mb-5", className)}>
      <label className="mb-1.5 flex items-baseline justify-between text-[12px] font-medium text-rv-mute-700">
        <span>{label}</span>
        {optional ? (
          <span className="text-[11px] font-normal text-rv-mute-500">
            {optional}
          </span>
        ) : null}
      </label>
      {children}
      {hint ? (
        <div
          className={cn(
            "mt-1.5 text-[11px] leading-relaxed",
            error ? "text-rv-danger" : "text-rv-mute-500",
          )}
        >
          {hint}
        </div>
      ) : null}
    </div>
  );
}
