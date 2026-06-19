import { DatePicker as HDatePicker, DateField, Label } from "@heroui/react";
import { Calendar as CalendarIcon } from "lucide-react";
import { cn } from "../lib/cn";
import { CalendarBody, RV_DATE_SCOPE } from "./calendar";
import {
  dateFieldGroupClass,
  dateSegmentClass,
  type DateFieldSize,
} from "./date-field";
import { dateValueToIso, isoToDateValue, todayDateValue } from "./date-value";

/** Popover surface shared by DatePicker / DateRangePicker. Fixed 320px wide
 * so the 7-column calendar grid has room to lay out full-width. */
export const datePopoverClass =
  "z-50 w-80 rounded-lg border border-rv-divider-strong bg-rv-c3 p-3 shadow-[0_10px_30px_rgba(0,0,0,0.5)] focus:outline-none";

export type DatePickerProps = {
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
 * Single-date picker: a segmented field with a calendar-popover trigger.
 * String-in / string-out — callers never touch `@internationalized/date`.
 */
export function DatePicker({
  value,
  onChange,
  label,
  min,
  max,
  isInvalid,
  isDisabled,
  size = "md",
  className,
}: DatePickerProps) {
  return (
    <HDatePicker
      aria-label={label ? undefined : "Date"}
      value={isoToDateValue(value)}
      onChange={(v) => onChange(dateValueToIso(v))}
      placeholderValue={todayDateValue()}
      minValue={isoToDateValue(min) ?? undefined}
      maxValue={isoToDateValue(max) ?? undefined}
      isInvalid={isInvalid}
      isDisabled={isDisabled}
      className={cn(RV_DATE_SCOPE, "flex flex-col gap-1", className)}
    >
      {label ? (
        <Label className="text-[11px] uppercase tracking-wider text-rv-mute-500">
          {label}
        </Label>
      ) : null}
      <DateField.Group className={dateFieldGroupClass(size)}>
        <DateField.Input className="flex min-w-0 flex-1 items-center">
          {(segment) => (
            <DateField.Segment segment={segment} className={dateSegmentClass} />
          )}
        </DateField.Input>
        <DateField.Suffix>
          <HDatePicker.Trigger className="ml-0.5 grid h-6 w-6 shrink-0 place-items-center rounded text-rv-mute-600 transition hover:bg-rv-c4 hover:text-foreground">
            <HDatePicker.TriggerIndicator>
              <CalendarIcon size={14} />
            </HDatePicker.TriggerIndicator>
          </HDatePicker.Trigger>
        </DateField.Suffix>
      </DateField.Group>
      <HDatePicker.Popover className={cn(RV_DATE_SCOPE, datePopoverClass)}>
        <CalendarBody />
      </HDatePicker.Popover>
    </HDatePicker>
  );
}
