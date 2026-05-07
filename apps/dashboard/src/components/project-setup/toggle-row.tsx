import type { ReactNode } from "react";
import { Switch } from "../../ui/switch";
import { cn } from "../../lib/cn";

type ToggleRowProps = {
  title: ReactNode;
  description?: ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  className?: string;
};

export function ToggleRow({
  title,
  description,
  checked,
  onChange,
  className,
}: ToggleRowProps) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-3.5 rounded-md border border-rv-divider bg-rv-c2 px-4 py-3.5",
        className,
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium text-foreground">{title}</div>
        {description ? (
          <div className="mt-1 text-[11px] leading-relaxed text-rv-mute-500">
            {description}
          </div>
        ) : null}
      </div>
      <Switch checked={checked} onChange={onChange} />
    </div>
  );
}
