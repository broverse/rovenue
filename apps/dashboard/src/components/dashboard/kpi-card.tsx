import type { ReactNode } from "react";
import { Card } from "../../ui/card";
import { Chip } from "../../ui/chip";
import { Sparkline } from "./sparkline";
import { IconArrowDown, IconArrowUp } from "./icons";

type DeltaKind = "success" | "danger" | "warning";

type Props = {
  label: string;
  value: ReactNode;
  /** Currency symbol shown in muted color before the value. */
  currency?: string;
  /** Unit shown in muted color after the value (e.g. "%"). */
  unit?: string;
  delta?: string | null;
  deltaKind?: DeltaKind;
  sparkData?: ReadonlyArray<number> | null;
  sparkColor?: string;
  onClick?: () => void;
};

/**
 * Headline metric tile with sparkline. Used in the dashboard's top row.
 */
export function KpiCard({ label, value, currency, unit, delta, deltaKind = "success", sparkData, sparkColor, onClick }: Props) {
  return (
    <Card interactive padded onClick={onClick} className="flex flex-col">
      <div className="flex items-start justify-between">
        <div>
          <div className="text-[11px] font-medium uppercase tracking-wider text-rv-mute-500">{label}</div>
          <div className="mt-1.5 flex items-baseline gap-0.5 font-rv-mono text-[28px] leading-8 font-medium tabular-nums">
            {currency && <span className="text-rv-mute-500 font-normal">{currency}</span>}
            <span>{value}</span>
            {unit && <span className="ml-0.5 text-[18px] text-rv-mute-500">{unit}</span>}
          </div>
        </div>
        {delta && (
          <Chip tone={deltaKind}>
            {deltaKind === "success" ? <IconArrowUp size={10} /> : <IconArrowDown size={10} />}
            {delta}
          </Chip>
        )}
      </div>
      <div className="mt-3">
        <Sparkline data={sparkData} color={sparkColor} />
      </div>
    </Card>
  );
}
