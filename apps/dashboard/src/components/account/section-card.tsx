import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

type SectionCardProps = {
  title: ReactNode;
  description?: ReactNode;
  right?: ReactNode;
  footer?: ReactNode;
  meta?: ReactNode;
  tone?: "default" | "danger";
  bodyClassName?: string;
  className?: string;
  children: ReactNode;
};

/**
 * Wraps a settings section with the canonical head/body/foot scaffold.
 * The danger tone subtly tints the head and border for destructive blocks.
 */
export function SectionCard({
  title,
  description,
  right,
  footer,
  meta,
  tone = "default",
  bodyClassName,
  className,
  children,
}: SectionCardProps) {
  const danger = tone === "danger";
  return (
    <section
      className={cn(
        "mb-4 rounded-lg border bg-rv-c1",
        danger ? "border-rv-danger/35" : "border-rv-divider",
        className,
      )}
    >
      <header
        className={cn(
          "flex flex-wrap items-start justify-between gap-3 border-b px-4 py-4 sm:px-5",
          danger ? "border-rv-danger/25 bg-rv-danger/5" : "border-rv-divider",
        )}
      >
        <div className="min-w-0 flex-1">
          <h3
            className={cn(
              "text-[14px] font-semibold leading-5",
              danger ? "text-rv-danger" : "text-foreground",
            )}
          >
            {title}
          </h3>
          {description ? (
            <p className="mt-1 text-[12px] leading-relaxed text-rv-mute-500">
              {description}
            </p>
          ) : null}
        </div>
        {right ? <div className="shrink-0">{right}</div> : null}
      </header>

      <div className={cn("px-4 py-4 sm:px-5", bodyClassName)}>{children}</div>

      {footer || meta ? (
        <footer className="flex flex-wrap items-center justify-end gap-2 rounded-b-lg border-t border-rv-divider bg-rv-c2 px-4 py-3 text-[12px] text-rv-mute-500 sm:px-5">
          {meta ? (
            <span className="flex-1 truncate font-rv-mono text-[11px] text-rv-mute-500">
              {meta}
            </span>
          ) : null}
          {footer}
        </footer>
      ) : null}
    </section>
  );
}
