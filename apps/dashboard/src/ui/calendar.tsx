import {
  Calendar as HCalendar,
  RangeCalendar as HRangeCalendar,
} from "@heroui/react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "../lib/cn";
import { dateValueToIso, isoToDateValue } from "./date-value";

/**
 * `rv-date` is the scoped HeroUI token bridge declared in `index.css`: it
 * repoints HeroUI's `--accent` family at the rv accent so selected days match
 * the rest of the app, without re-theming HeroUI globally. Every popover /
 * inline calendar surface in this file carries it.
 */
export const RV_DATE_SCOPE = "rv-date";

const navButtonClass =
  "grid h-7 w-7 place-items-center rounded-md text-rv-mute-600 transition hover:bg-rv-c4 hover:text-foreground";
const cellBaseClass =
  "grid h-8 w-8 cursor-pointer place-items-center rounded-md text-[12px] text-rv-mute-700 outline-none transition data-[disabled]:cursor-default data-[disabled]:text-rv-mute-400 data-[hovered]:bg-rv-c4 data-[hovered]:text-foreground data-[outside-month]:text-rv-mute-400";

/**
 * Month grid *contents* (header + day grid) — must be rendered inside an
 * `<HCalendar>` root that supplies the calendar state. Header is prev /
 * month-year heading / next; the year-picker affordance is intentionally
 * skipped to keep the surface small and predictable.
 */
export function CalendarChrome() {
  return (
    <>
      <HCalendar.Header className="mb-1 flex items-center justify-between px-1">
        <HCalendar.NavButton slot="previous" className={navButtonClass}>
          <ChevronLeft size={15} />
        </HCalendar.NavButton>
        <HCalendar.Heading className="whitespace-nowrap text-[13px] font-medium text-foreground" />
        <HCalendar.NavButton slot="next" className={navButtonClass}>
          <ChevronRight size={15} />
        </HCalendar.NavButton>
      </HCalendar.Header>
      <HCalendar.Grid>
        <HCalendar.GridHeader>
          {(day) => (
            <HCalendar.HeaderCell className="pb-1 text-[11px] font-normal text-rv-mute-500">
              {day}
            </HCalendar.HeaderCell>
          )}
        </HCalendar.GridHeader>
        <HCalendar.GridBody>
          {(date) => (
            <HCalendar.Cell
              date={date}
              className={cn(
                cellBaseClass,
                "data-[selected]:bg-rv-accent-500 data-[selected]:text-white",
              )}
            />
          )}
        </HCalendar.GridBody>
      </HCalendar.Grid>
    </>
  );
}

/** Range variant of {@link CalendarChrome} (separate compound namespace). */
export function RangeCalendarChrome() {
  return (
    <>
      <HRangeCalendar.Header className="mb-1 flex items-center justify-between px-1">
        <HRangeCalendar.NavButton slot="previous" className={navButtonClass}>
          <ChevronLeft size={15} />
        </HRangeCalendar.NavButton>
        <HRangeCalendar.Heading className="whitespace-nowrap text-[13px] font-medium text-foreground" />
        <HRangeCalendar.NavButton slot="next" className={navButtonClass}>
          <ChevronRight size={15} />
        </HRangeCalendar.NavButton>
      </HRangeCalendar.Header>
      <HRangeCalendar.Grid>
        <HRangeCalendar.GridHeader>
          {(day) => (
            <HRangeCalendar.HeaderCell className="pb-1 text-[11px] font-normal text-rv-mute-500">
              {day}
            </HRangeCalendar.HeaderCell>
          )}
        </HRangeCalendar.GridHeader>
        <HRangeCalendar.GridBody>
          {(date) => (
            <HRangeCalendar.Cell
              date={date}
              className={cn(
                cellBaseClass,
                "data-[selected]:bg-rv-accent-500/25 data-[selected]:text-foreground data-[selection-start]:bg-rv-accent-500 data-[selection-start]:text-white data-[selection-end]:bg-rv-accent-500 data-[selection-end]:text-white",
              )}
            />
          )}
        </HRangeCalendar.GridBody>
      </HRangeCalendar.Grid>
    </>
  );
}

/**
 * A self-contained calendar root for use inside `DatePicker.Popover`. It owns
 * no value of its own — react-aria wires it to the surrounding picker's state.
 */
export function CalendarBody() {
  return (
    <HCalendar aria-label="Calendar" className="w-full">
      <CalendarChrome />
    </HCalendar>
  );
}

/** Range calendar root for use inside `DateRangePicker.Popover`. */
export function RangeCalendarBody() {
  return (
    <HRangeCalendar aria-label="Date range calendar" className="w-full">
      <RangeCalendarChrome />
    </HRangeCalendar>
  );
}

export type CalendarProps = {
  /** Selected day as ISO `YYYY-MM-DD`, or `null` when unset. */
  value: string | null;
  onChange: (next: string | null) => void;
  /** Inclusive ISO bounds for selectable days. */
  min?: string;
  max?: string;
  isDisabled?: boolean;
  className?: string;
};

/** Always-visible single-date calendar grid. String-in / string-out. */
export function Calendar({
  value,
  onChange,
  min,
  max,
  isDisabled,
  className,
}: CalendarProps) {
  return (
    <HCalendar
      aria-label="Calendar"
      value={isoToDateValue(value)}
      onChange={(v) => onChange(dateValueToIso(v))}
      minValue={isoToDateValue(min) ?? undefined}
      maxValue={isoToDateValue(max) ?? undefined}
      isDisabled={isDisabled}
      className={cn(RV_DATE_SCOPE, "w-80", className)}
    >
      <CalendarChrome />
    </HCalendar>
  );
}

export type RangeCalendarValue = { from: string | null; to: string | null };

export type RangeCalendarProps = {
  value: RangeCalendarValue;
  onChange: (next: RangeCalendarValue) => void;
  min?: string;
  max?: string;
  isDisabled?: boolean;
  className?: string;
};

/** Always-visible range calendar grid. String-in / string-out. */
export function RangeCalendar({
  value,
  onChange,
  min,
  max,
  isDisabled,
  className,
}: RangeCalendarProps) {
  const start = isoToDateValue(value.from);
  const end = isoToDateValue(value.to);
  return (
    <HRangeCalendar
      aria-label="Date range calendar"
      value={start && end ? { start, end } : null}
      onChange={(v) =>
        onChange({ from: dateValueToIso(v?.start), to: dateValueToIso(v?.end) })
      }
      minValue={isoToDateValue(min) ?? undefined}
      maxValue={isoToDateValue(max) ?? undefined}
      isDisabled={isDisabled}
      className={cn(RV_DATE_SCOPE, "w-80", className)}
    >
      <RangeCalendarChrome />
    </HRangeCalendar>
  );
}
