import { cn } from "../../lib/cn";
import { COUNTRIES } from "./mock-data";
import type { CountryCode } from "./types";

type Props = {
  country: CountryCode;
  /** Adds the country name next to the flag (used in detail panel). */
  showName?: boolean;
  className?: string;
};

/** Compact CSS-flag + ISO code cell. */
export function CountryCell({ country, showName, className }: Props) {
  const meta = COUNTRIES[country];
  return (
    <div className={cn("flex items-center gap-1.5 text-[12px] text-rv-mute-700", className)}>
      <span
        aria-hidden="true"
        className="inline-block h-2.5 w-3.5 shrink-0 rounded-[1px] border border-white/10"
        style={{ background: meta.flag }}
      />
      <span>{showName ? meta.name : country}</span>
    </div>
  );
}
