import type { ReactNode } from "react";
import { Switch } from "../../ui/switch";
import { cn } from "../../lib/cn";

type ToggleRowProps = {
  title: ReactNode;
  description?: ReactNode;
  /** When omitted the row renders the supplied `right` control instead of a switch. */
  checked?: boolean;
  onChange?: (next: boolean) => void;
  right?: ReactNode;
  className?: string;
};

/**
 * Stacked row used inside `SectionCard` bodies. Title + description on the
 * left, a `Switch` (or any control via `right`) on the right. Subtle
 * separator between siblings; no separator on the last row.
 */
export function AccountToggleRow({
  title,
  description,
  checked,
  onChange,
  right,
  className,
}: ToggleRowProps) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-3.5 border-b border-white/5 py-3.5 last:border-b-0 last:pb-0 first:pt-0",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 text-[13px] font-medium text-foreground">
          {title}
        </div>
        {description ? (
          <div className="mt-0.5 text-[11px] leading-relaxed text-rv-mute-500">
            {description}
          </div>
        ) : null}
      </div>
      <div className="mt-0.5 shrink-0">
        {right
          ? right
          : typeof checked === "boolean" && onChange ? (
              <Switch checked={checked} onChange={onChange} />
            ) : null}
      </div>
    </div>
  );
}
