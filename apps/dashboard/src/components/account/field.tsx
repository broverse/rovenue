import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

type FieldProps = {
  label?: ReactNode;
  optional?: ReactNode;
  hint?: ReactNode;
  className?: string;
  children: ReactNode;
};

/**
 * Form-row wrapper. The label sits above the control, an optional caption is
 * right-aligned next to it, and the hint renders beneath. Mirrors the
 * project-setup `Field` but lives next to the rest of the account primitives
 * so settings forms own their typographic rhythm.
 */
export function Field({ label, optional, hint, className, children }: FieldProps) {
  return (
    <div className={cn("mb-4 last:mb-0", className)}>
      {label ? (
        <label className="mb-1.5 flex items-baseline justify-between text-[12px] font-medium text-rv-mute-700">
          <span>{label}</span>
          {optional ? (
            <span className="text-[11px] font-normal text-rv-mute-500">
              {optional}
            </span>
          ) : null}
        </label>
      ) : null}
      {children}
      {hint ? (
        <div className="mt-1.5 text-[11px] leading-relaxed text-rv-mute-500">
          {hint}
        </div>
      ) : null}
    </div>
  );
}

export function FieldRow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-3.5 sm:grid-cols-2",
        className,
      )}
    >
      {children}
    </div>
  );
}
