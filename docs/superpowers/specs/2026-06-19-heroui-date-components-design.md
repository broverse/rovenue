# HeroUI Date Components under `ui/`

Date: 2026-06-19
Status: Approved (scoped theme bridge)

## Goal

Add a reusable set of date components to the dashboard's `ui/` library, wrapping
HeroUI v3's date suite, and migrate the subscribers date-range filter (currently
native `type="date"` inputs) to use them.

## Context

- Dashboard already depends on `@heroui/react` `^3.0.3` and imports
  `@heroui/styles` globally (`src/index.css`). `I18nProvider` is mounted in
  `main.tsx`; dark mode via `next-themes` (`attribute="class"`).
- HeroUI v3 ships a full date suite: `Calendar`, `RangeCalendar`, `DateField`,
  `DatePicker`, `DateRangePicker`, `TimeField`, `CalendarYearPicker`. They are
  compound components (`.Root` / `.Trigger` / `.Popover`) built on
  react-aria-components (RAC) + `@internationalized/date`.
- Component values are RAC `DateValue` / `RangeValue<DateValue>`.
- No dayjs/date-fns/luxon in the dashboard. App date code uses native `Date` +
  ISO `"YYYY-MM-DD"` strings. `@internationalized/date` is installed (transitive
  via HeroUI) and is the natural string<->DateValue bridge.
- Existing `ui/` wrappers are hand-built on base-ui + rv-* tokens and currently
  contain NO date component. HeroUI's theme tokens are not bridged to rv-*.

## Value API decision

Wrappers expose **ISO `"YYYY-MM-DD"` strings** (and `null` for unset) at their
boundary. `@internationalized/date` (`parseDate`, `CalendarDate.toString()`) is
used ONLY inside the wrappers. Feature code never imports
`@internationalized/date`. This makes the wrappers drop-in for existing state,
including the subscribers filter's `DateRangeValue { from, to }`.

## Components (new files in `apps/dashboard/src/ui/`)

- `date-field.tsx` — `DateField`: segmented keyboard input, no popover.
  Props: `value: string | null`, `onChange(next: string | null)`, `label?`,
  `min?`, `max?`, `isInvalid?`, `className?`.
- `date-picker.tsx` — `DatePicker`: trigger + calendar popover, single date.
  Same ISO-string API as DateField.
- `date-range-picker.tsx` — `DateRangePicker`: trigger + range calendar.
  Props: `value: { from: string | null; to: string | null }`,
  `onChange(next)`, `min?`, `max?`, `className?`. Value shape matches the
  existing `DateRangeValue` so it is drop-in.
- `calendar.tsx` — `Calendar` + `RangeCalendar`: always-visible grid, no trigger.
- All re-exported from `ui/index.ts` following the existing barrel convention
  (`export { Component, type ComponentProps } from "./file"`).

Internal helpers (shared, colocated or in a small `date-value.ts`):
`toCalendarDate(iso: string | null): DateValue | null` and
`toIso(value: DateValue | null): string | null`.

## Theming — scoped rv-* bridge

HeroUI v3 styles are token-driven (`--accent`, `--foreground`, `--muted`,
`--default`, `--focus`, `--radius`, surfaces…). Add a **scoped** token-bridge
class in `index.css` mapping these to rv values
(`--accent: var(--color-rv-accent-500)`, surfaces → `--color-rv-c2/c3`,
dividers → `--color-rv-divider`, radius → existing). Apply the class on the date
components' root/popover wrappers only.

Scoped — NOT global — so existing HeroUI usages (color-swatch popover, OAuth
buttons) are untouched and there is no app-wide visual regression. Dark mode is
already handled by the `.dark` class.

## Migration

Replace the two native `type="date"` inputs in
`apps/dashboard/src/components/subscribers/date-range-popover.tsx` (the custom
range section) with two `ui/DateField`s — **not** `DateRangePicker`. That section
lives inside a base-ui `Popover`, so nesting HeroUI's calendar-popover
components there risks outside-click / portal conflicts. `DateField` (segmented,
no nested popover) is the faithful swap: it preserves the existing independent,
optional from/to sides and their cross-bounds (`from.max = to`, `to.min = from`).
Presets, clear, apply, and the `DateRangeValue` ISO contract stay identical.
The calendar-bearing pickers remain exported from `ui/` for use elsewhere.

## Testing / verification

- `tsc` typecheck of the dashboard passes.
- Render check: components mount, calendar opens, range selection emits correct
  ISO strings, `min`/`max` clamp, and the migrated subscribers filter round-trips
  a range end-to-end.

## Out of scope (YAGNI)

`TimeField`, `CalendarYearPicker`, new presets, global HeroUI re-theming.
