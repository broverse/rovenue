import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

type PlanCardProps = {
  eyebrow: ReactNode;
  name: ReactNode;
  description?: ReactNode;
  stats?: Array<{ label: ReactNode; value: ReactNode; mono?: boolean }>;
  actions?: ReactNode;
  className?: string;
};

/**
 * Highlight card that introduces the current billing plan. Soft accent
 * gradient + grid layout that collapses to a single column on narrow widths.
 */
export function PlanCard({
  eyebrow,
  name,
  description,
  stats,
  actions,
  className,
}: PlanCardProps) {
  return (
    <div
      className={cn(
        "mb-4 grid grid-cols-1 items-center gap-5 rounded-lg border border-rv-accent-500/35 bg-gradient-to-br from-rv-accent-500/20 to-rv-c1 p-4 sm:p-6 md:grid-cols-[1fr_auto]",
        className,
      )}
    >
      <div>
        <div className="font-rv-mono text-[11px] uppercase tracking-wider text-rv-accent-400">
          {eyebrow}
        </div>
        <div className="mt-1 text-[22px] font-semibold leading-7">{name}</div>
        {description ? (
          <div className="mt-1.5 max-w-xl text-[12px] leading-relaxed text-rv-mute-600">
            {description}
          </div>
        ) : null}
        {stats ? (
          <div className="mt-3.5 flex flex-wrap gap-4">
            {stats.map((s, i) => (
              <div key={i}>
                <div className="text-[10px] uppercase tracking-wider text-rv-mute-500">
                  {s.label}
                </div>
                <div
                  className={cn(
                    "mt-1 text-[13px]",
                    s.mono ? "font-rv-mono" : "font-rv-mono text-[18px] font-medium",
                  )}
                >
                  {s.value}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>
      {actions ? <div className="flex flex-col gap-2">{actions}</div> : null}
    </div>
  );
}
