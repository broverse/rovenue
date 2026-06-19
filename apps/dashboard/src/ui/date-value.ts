import {
  type DateValue,
  getLocalTimeZone,
  parseDate,
  today,
} from "@internationalized/date";

/**
 * Bridge between the app's ISO `YYYY-MM-DD` string convention and HeroUI's
 * `@internationalized/date` `DateValue` objects. Kept tiny and pure so the
 * date components can stay string-in / string-out and feature code never has
 * to touch `@internationalized/date`.
 */

/** ISO `YYYY-MM-DD` (or nullish) → `DateValue`. Malformed input → `null`. */
export function isoToDateValue(iso: string | null | undefined): DateValue | null {
  if (!iso) return null;
  try {
    // `parseDate` is strict: it throws on anything that isn't a valid
    // `YYYY-MM-DD` calendar date. Swallow that so a half-typed / garbage
    // value reads as "unset" rather than crashing the render.
    return parseDate(iso);
  } catch {
    return null;
  }
}

/**
 * The current local date as a `DateValue`. Used as `placeholderValue` so an
 * empty field / calendar anchors to "now" instead of react-aria's 1900-01-01
 * default (which otherwise opens the calendar on January 1900).
 */
export function todayDateValue(): DateValue {
  return today(getLocalTimeZone());
}

/** `DateValue` (or nullish) → ISO `YYYY-MM-DD`. Nullish → `null`. */
export function dateValueToIso(value: DateValue | null | undefined): string | null {
  if (!value) return null;
  // `CalendarDate.toString()` already yields `YYYY-MM-DD`; the slice guards
  // against richer `DateValue`s (e.g. `CalendarDateTime`) that append a time.
  return value.toString().slice(0, 10);
}
