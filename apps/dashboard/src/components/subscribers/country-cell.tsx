import { cn } from "../../lib/cn";
import { COUNTRIES } from "./mock-data";
import type { CountryCode } from "./types";

type Props = {
  country: CountryCode;
  /** Adds the country name next to the flag (used in detail panel). */
  showName?: boolean;
  className?: string;
};

/**
 * Converts a 2-letter ISO-3166 country code to its flag emoji by mapping
 * each letter to its Regional Indicator Symbol. Renders accurate flags
 * without shipping an image set or crude CSS gradients.
 */
export function flagEmoji(code: string): string {
  if (!/^[A-Za-z]{2}$/.test(code)) return "🏳️";
  const OFFSET = 0x1f1e6 - "A".charCodeAt(0);
  const upper = code.toUpperCase();
  return String.fromCodePoint(
    upper.charCodeAt(0) + OFFSET,
    upper.charCodeAt(1) + OFFSET,
  );
}

/** Compact flag + ISO code cell. */
export function CountryCell({ country, showName, className }: Props) {
  const meta = COUNTRIES[country];
  return (
    <div className={cn("flex items-center gap-1.5 text-[12px] text-rv-mute-700", className)}>
      <span aria-hidden="true" className="text-[14px] leading-none">
        {flagEmoji(country)}
      </span>
      <span>{showName ? meta.name : country}</span>
    </div>
  );
}
