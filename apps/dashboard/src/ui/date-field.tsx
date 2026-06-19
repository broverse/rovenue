import { DateField as HDateField, Label } from "@heroui/react";
import { cn } from "../lib/cn";
import { dateValueToIso, isoToDateValue, todayDateValue } from "./date-value";
import { RV_DATE_SCOPE } from "./calendar";

export type DateFieldSize = "sm" | "md";

/** Shared field-shell styling so DateField / DatePicker / DateRangePicker
 * line up with the rest of the rv form controls (cf. `ui/input.tsx`).
 * `min-w-0` lets the field shrink inside flex rows (e.g. two side-by-side in
 * a narrow filter popover) instead of overflowing. */
export function dateFieldGroupClass(size: DateFieldSize = "md") {
  return cn(
    "flex w-full min-w-0 items-center rounded-md border border-rv-divider bg-rv-c2 text-foreground transition focus-within:border-rv-accent-500 data-[invalid]:border-rv-danger",
    size === "sm" ? "h-8 px-2 text-[12px]" : "h-9 px-2.5 text-[13px]",
  );
}

/** Per-segment styling: muted placeholder, accent selection, danger when
 * the surrounding field is invalid. Tight padding so the full `mm/dd/yyyy`
 * fits in cramped rows. */
export const dateSegmentClass =
  "rounded px-px tabular-nums outline-none data-[placeholder]:text-rv-mute-500 data-[focused]:bg-rv-accent-500/20 data-[focused]:text-foreground";

export type DateFieldProps = {
  /** Selected day as ISO `YYYY-MM-DD`, or `null` when unset. */
  value: string | null;
  onChange: (next: string | null) => void;
  label?: string;
  /** Inclusive ISO bounds for selectable days. */
  min?: string;
  max?: string;
  isInvalid?: boolean;
  isDisabled?: boolean;
  size?: DateFieldSize;
  className?: string;
};

/**
 * Segmented, keyboard-first date input (no calendar popover) — the themed
 * counterpart to a native `type="date"`. String-in / string-out.
 */
export function DateField({
  value,
  onChange,
  label,
  min,
  max,
  isInvalid,
  isDisabled,
  size = "md",
  className,
}: DateFieldProps) {
  return (
    <HDateField
      // A visible <Label> is auto-associated; fall back to aria-label only
      // when no label is rendered so the field always has an accessible name.
      aria-label={label ? undefined : "Date"}
      value={isoToDateValue(value)}
      onChange={(v) => onChange(dateValueToIso(v))}
      placeholderValue={todayDateValue()}
      minValue={isoToDateValue(min)}
      maxValue={isoToDateValue(max)}
      isInvalid={isInvalid}
      isDisabled={isDisabled}
      className={cn(RV_DATE_SCOPE, "flex flex-col gap-1", className)}
    >
      {label ? (
        <Label className="text-[11px] uppercase tracking-wider text-rv-mute-500">
          {label}
        </Label>
      ) : null}
      <HDateField.Group className={dateFieldGroupClass(size)}>
        <HDateField.Input>
          {(segment) => (
            <HDateField.Segment segment={segment} className={dateSegmentClass} />
          )}
        </HDateField.Input>
      </HDateField.Group>
    </HDateField>
  );
}
