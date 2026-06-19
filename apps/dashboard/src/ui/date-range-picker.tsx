import {
  DateRangePicker as HDateRangePicker,
  DateField,
  Label,
} from "@heroui/react";
import { Calendar as CalendarIcon } from "lucide-react";
import { cn } from "../lib/cn";
import {
  RangeCalendarBody,
  RV_DATE_SCOPE,
  type RangeCalendarValue,
} from "./calendar";
import { dateFieldGroupClass, dateSegmentClass } from "./date-field";
import { datePopoverClass } from "./date-picker";
import { dateValueToIso, isoToDateValue, todayDateValue } from "./date-value";

export type DateRangePickerValue = RangeCalendarValue;

export type DateRangePickerProps = {
  /** `{ from, to }` as ISO `YYYY-MM-DD`, `null` per side when unset. */
  value: DateRangePickerValue;
  onChange: (next: DateRangePickerValue) => void;
  label?: string;
  /** Inclusive ISO bounds for selectable days. */
  min?: string;
  max?: string;
  isInvalid?: boolean;
  isDisabled?: boolean;
  className?: string;
};

/**
 * Date range picker: two segmented fields (from / to) sharing one calendar
 * popover. The `{ from, to }` ISO shape matches the subscribers filter's
 * `DateRangeValue`, so it drops in wherever native range inputs were used.
 */
export function DateRangePicker({
  value,
  onChange,
  label,
  min,
  max,
  isInvalid,
  isDisabled,
  className,
}: DateRangePickerProps) {
  const start = isoToDateValue(value.from);
  const end = isoToDateValue(value.to);
  return (
    <HDateRangePicker
      aria-label={label ? undefined : "Date range"}
      placeholderValue={todayDateValue()}
      value={start && end ? { start, end } : null}
      onChange={(v) =>
        onChange({ from: dateValueToIso(v?.start), to: dateValueToIso(v?.end) })
      }
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
      <DateField.Group className={dateFieldGroupClass()}>
        <DateField.InputContainer className="flex flex-1 items-center gap-1">
          <DateField.Input slot="start">
            {(segment) => (
              <DateField.Segment segment={segment} className={dateSegmentClass} />
            )}
          </DateField.Input>
          <HDateRangePicker.RangeSeparator className="px-0.5 text-rv-mute-500">
            –
          </HDateRangePicker.RangeSeparator>
          <DateField.Input slot="end">
            {(segment) => (
              <DateField.Segment segment={segment} className={dateSegmentClass} />
            )}
          </DateField.Input>
        </DateField.InputContainer>
        <DateField.Suffix>
          <HDateRangePicker.Trigger className="ml-1 grid h-6 w-6 place-items-center rounded text-rv-mute-600 transition hover:bg-rv-c4 hover:text-foreground">
            <HDateRangePicker.TriggerIndicator>
              <CalendarIcon size={14} />
            </HDateRangePicker.TriggerIndicator>
          </HDateRangePicker.Trigger>
        </DateField.Suffix>
      </DateField.Group>
      <HDateRangePicker.Popover className={cn(RV_DATE_SCOPE, datePopoverClass)}>
        <RangeCalendarBody />
      </HDateRangePicker.Popover>
    </HDateRangePicker>
  );
}
