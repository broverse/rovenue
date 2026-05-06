import type { ComponentType, ReactNode } from "react";
import { Card } from "../../ui/card";
import type { IconProps } from "./icons";

type Props = {
  icon: ComponentType<IconProps>;
  iconSize?: number;
  title: string;
  description: ReactNode;
  actions?: ReactNode;
  /** Extra height/padding for the chart-sized empty state. */
  large?: boolean;
  className?: string;
};

/**
 * Centered empty-state for cards that don't have data yet.
 */
export function EmptyStateCard({ icon: Icon, iconSize = 18, title, description, actions, large, className = "" }: Props) {
  return (
    <Card className={`flex h-full ${large ? "min-h-[360px]" : "min-h-[320px]"} ${className}`}>
      <div className={`flex flex-1 flex-col items-center justify-center px-5 text-center ${large ? "py-20" : "py-12"}`}>
        <div className="mb-3 flex size-10 items-center justify-center rounded-lg border border-rv-divider bg-rv-c2 text-rv-mute-500">
          <Icon size={iconSize} />
        </div>
        <h3 className="mb-1 text-[13px] font-semibold">{title}</h3>
        <p className="mb-3 max-w-[280px] text-[12px] text-rv-mute-500">{description}</p>
        {actions && <div className="flex gap-2">{actions}</div>}
      </div>
    </Card>
  );
}
