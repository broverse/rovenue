// =============================================================
// Leaderboard cadence boundary arithmetic
// =============================================================
//
// Season boundaries are LOCAL: a weekly leaderboard for a Turkish app
// rolls at Monday 00:00 Istanbul time, not at UTC midnight, which would
// cut Sunday evening in half. All arithmetic happens on the local
// calendar and is converted back to a UTC instant for storage.
//
// No luxon, no date-fns: Node's Intl ships the full IANA database and
// this repo already does timezone work this way (services/notifications/tz.ts).

// The cadence union comes from the pgEnum (Task 1), never redeclared here.
import type { LeaderboardCadence } from "@rovenue/db";

export interface SeasonWindow {
  startsAt: Date;
  /** Exclusive. */
  endsAt: Date;
}

export const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MONDAY_WEEKDAY = 1;
const FIRST_DAY_OF_MONTH = 1;
const MONTHS_PER_YEAR = 12;
const MIDNIGHT = { hour: 0, minute: 0, second: 0 };
const MAX_FIXPOINT_PASSES = 2;

interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number;
  minute: number;
  second: number;
  weekday: number; // 1 = Monday .. 7 = Sunday
}

// Intl reports weekdays as English short names; map them to ISO weekday
// numbers (1 = Monday .. 7 = Sunday) so calendar math never depends on
// locale string comparisons.
const WEEKDAY_BY_SHORT_NAME: Record<string, number> = {
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
  Sun: 7,
};

const localPartsFormatterCache = new Map<string, Intl.DateTimeFormat>();

function getLocalPartsFormatter(timezone: string): Intl.DateTimeFormat {
  let fmt = localPartsFormatterCache.get(timezone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
      weekday: "short",
      hour12: false,
    });
    localPartsFormatterCache.set(timezone, fmt);
  }
  return fmt;
}

/** Reads the local calendar wall-clock parts of `instant` in `timezone`. */
function localPartsIn(instant: Date, timezone: string): LocalParts {
  const parts = getLocalPartsFormatter(timezone).formatToParts(instant);
  const byType: Record<string, string> = {};
  for (const part of parts) {
    byType[part.type] = part.value;
  }

  const weekday = WEEKDAY_BY_SHORT_NAME[byType.weekday ?? ""];
  if (weekday === undefined) {
    throw new Error(
      `localPartsIn: unrecognised weekday "${byType.weekday}" for timezone "${timezone}"`,
    );
  }

  // `hour12: false` with en-US emits 0..23, but some ICU builds emit
  // "24" for midnight (see services/notifications/tz.ts). Normalise.
  const rawHour = Number(byType.hour);
  const hour = rawHour === 24 ? 0 : rawHour;

  return {
    year: Number(byType.year),
    month: Number(byType.month),
    day: Number(byType.day),
    hour,
    minute: Number(byType.minute),
    second: Number(byType.second),
    weekday,
  };
}

/**
 * Converts local calendar parts (in `timezone`) to the UTC instant they
 * represent.
 *
 * `Intl` has no direct local->UTC inverse, so this uses the standard
 * two-pass fixpoint: guess the instant as if the local parts were UTC,
 * read the zone's offset at that guess, subtract it to get a corrected
 * instant, then re-read the offset at the corrected instant. Two passes
 * suffice for every real IANA zone, including DST edges, because the
 * offset only ever changes once between the initial guess and the
 * corrected instant (there is no zone with two transitions within one
 * offset's magnitude of each other). If the second pass disagrees with
 * the first correction, the fixpoint hasn't settled — throw rather than
 * return a silently wrong instant, since every season boundary for that
 * zone would be corrupted downstream.
 */
function utcInstantForLocal(
  parts: Pick<LocalParts, "year" | "month" | "day" | "hour" | "minute" | "second">,
  timezone: string,
): Date {
  const naiveUtcMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );

  let candidateMs = naiveUtcMs;
  let previousOffsetMs: number | null = null;

  for (let pass = 0; pass < MAX_FIXPOINT_PASSES; pass += 1) {
    const offsetMs = offsetAt(new Date(candidateMs), timezone);
    const correctedMs = naiveUtcMs - offsetMs;

    if (previousOffsetMs !== null && offsetMs === previousOffsetMs) {
      return new Date(correctedMs);
    }

    previousOffsetMs = offsetMs;
    candidateMs = correctedMs;
  }

  // One more read to see whether the last correction actually stabilised.
  const finalOffsetMs = offsetAt(new Date(candidateMs), timezone);
  if (finalOffsetMs !== previousOffsetMs) {
    throw new Error(
      `utcInstantForLocal: offset for timezone "${timezone}" did not stabilise ` +
        `after ${MAX_FIXPOINT_PASSES} passes (local ${JSON.stringify(parts)})`,
    );
  }

  return new Date(candidateMs);
}

/**
 * Returns the UTC offset (in ms) that `timezone` observes at `instant`,
 * defined so that `local wall-clock time = instant + offset` (e.g. +3h
 * for Istanbul, which is always ahead of UTC).
 */
function offsetAt(instant: Date, timezone: string): number {
  const parts = localPartsIn(instant, timezone);
  const partsAsUtcMs = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  );
  return partsAsUtcMs - instant.getTime();
}

function toUtc(
  year: number,
  month: number,
  day: number,
  timezone: string,
): Date {
  return utcInstantForLocal(
    { year, month, day, ...MIDNIGHT },
    timezone,
  );
}

/** Adds `deltaMonths` to a (year, month) pair, carrying the year. */
function addMonths(
  year: number,
  month: number,
  deltaMonths: number,
): { year: number; month: number } {
  const zeroBasedMonth = month - 1 + deltaMonths;
  const carriedYear = year + Math.floor(zeroBasedMonth / MONTHS_PER_YEAR);
  const normalizedMonth =
    ((zeroBasedMonth % MONTHS_PER_YEAR) + MONTHS_PER_YEAR) % MONTHS_PER_YEAR;
  return { year: carriedYear, month: normalizedMonth + 1 };
}

/** Adds `deltaDays` local calendar days to a (year, month, day) triple. */
function addLocalDays(
  year: number,
  month: number,
  day: number,
  deltaDays: number,
): { year: number; month: number; day: number } {
  // Using UTC-based Date arithmetic on the *calendar* (not the instant)
  // is safe here: we're manipulating a wall-clock date triple, not a
  // real timezone-aware instant, so there is no DST to account for.
  const utcMs = Date.UTC(year, month - 1, day) + deltaDays * MS_PER_DAY;
  const asDate = new Date(utcMs);
  return {
    year: asDate.getUTCFullYear(),
    month: asDate.getUTCMonth() + 1,
    day: asDate.getUTCDate(),
  };
}

function weeklyWindowContaining(instant: Date, timezone: string): SeasonWindow {
  const parts = localPartsIn(instant, timezone);
  const daysSinceMonday = parts.weekday - MONDAY_WEEKDAY;
  const monday = addLocalDays(
    parts.year,
    parts.month,
    parts.day,
    -daysSinceMonday,
  );
  const nextMonday = addLocalDays(monday.year, monday.month, monday.day, 7);

  return {
    startsAt: toUtc(monday.year, monday.month, monday.day, timezone),
    endsAt: toUtc(nextMonday.year, nextMonday.month, nextMonday.day, timezone),
  };
}

function monthlyWindowContaining(instant: Date, timezone: string): SeasonWindow {
  const parts = localPartsIn(instant, timezone);
  const next = addMonths(parts.year, parts.month, 1);

  return {
    startsAt: toUtc(parts.year, parts.month, FIRST_DAY_OF_MONTH, timezone),
    endsAt: toUtc(next.year, next.month, FIRST_DAY_OF_MONTH, timezone),
  };
}

/**
 * Whole calendar days from `from` to `to` (both local year/month/day
 * triples, no time-of-day). Pure calendar arithmetic — like
 * `addLocalDays`, this never touches a real timezone offset, so it can't
 * pick up DST drift the way a millisecond difference between two real
 * UTC instants would.
 */
function localDateDiffDays(
  from: { year: number; month: number; day: number },
  to: { year: number; month: number; day: number },
): number {
  const fromUtcMs = Date.UTC(from.year, from.month - 1, from.day);
  const toUtcMs = Date.UTC(to.year, to.month - 1, to.day);
  return Math.round((toUtcMs - fromUtcMs) / MS_PER_DAY);
}

function customWindowContaining(
  instant: Date,
  timezone: string,
  customPeriodDays: number,
  anchorAt: Date,
): SeasonWindow {
  const anchorParts = localPartsIn(anchorAt, timezone);
  const instantParts = localPartsIn(instant, timezone);

  // Elapsed periods must come from a count of whole LOCAL calendar days,
  // not a millisecond difference between two real UTC instants: once the
  // anchor and the instant sit on opposite sides of a DST transition,
  // their instants differ from their local-day distance by the DST delta,
  // which silently swallows whole periods (see the regression tests
  // below — this is the bug the reviewer caught).
  const localDaysElapsed = localDateDiffDays(anchorParts, instantParts);
  const periodsElapsed = Math.floor(localDaysElapsed / customPeriodDays);

  const start = addLocalDays(
    anchorParts.year,
    anchorParts.month,
    anchorParts.day,
    periodsElapsed * customPeriodDays,
  );
  const end = addLocalDays(start.year, start.month, start.day, customPeriodDays);

  return {
    startsAt: toUtc(start.year, start.month, start.day, timezone),
    endsAt: toUtc(end.year, end.month, end.day, timezone),
  };
}

function resolveCustomPeriodDays(customPeriodDays: number | null): number {
  const error = validateCadence("CUSTOM", customPeriodDays);
  if (error !== null) {
    throw new Error(`seasonWindowContaining: ${error}`);
  }
  // validateCadence guarantees this is a positive integer.
  return customPeriodDays as number;
}

export function seasonWindowContaining(
  instant: Date,
  cadence: LeaderboardCadence,
  timezone: string,
  customPeriodDays: number | null,
  anchorAt: Date,
): SeasonWindow {
  const validationError = validateCadence(cadence, customPeriodDays);
  if (validationError !== null) {
    throw new Error(`seasonWindowContaining: ${validationError}`);
  }

  switch (cadence) {
    case "WEEKLY":
      return weeklyWindowContaining(instant, timezone);
    case "MONTHLY":
      return monthlyWindowContaining(instant, timezone);
    case "CUSTOM":
      return customWindowContaining(
        instant,
        timezone,
        resolveCustomPeriodDays(customPeriodDays),
        anchorAt,
      );
    default: {
      const exhaustive: never = cadence;
      throw new Error(`seasonWindowContaining: unhandled cadence ${exhaustive}`);
    }
  }
}

export function nextSeasonWindow(
  previous: SeasonWindow,
  cadence: LeaderboardCadence,
  timezone: string,
  customPeriodDays: number | null,
  anchorAt: Date,
): SeasonWindow {
  // previous.endsAt is exclusive, i.e. the first instant of the next
  // local period — resolving the window containing it always lands on
  // the next boundary, never back on `previous` itself.
  return seasonWindowContaining(
    previous.endsAt,
    cadence,
    timezone,
    customPeriodDays,
    anchorAt,
  );
}

export function validateCadence(
  cadence: LeaderboardCadence,
  customPeriodDays: number | null,
): string | null {
  if (cadence === "CUSTOM") {
    if (
      customPeriodDays === null ||
      !Number.isInteger(customPeriodDays) ||
      customPeriodDays <= 0
    ) {
      return "customPeriodDays must be a positive integer when cadence is CUSTOM";
    }
    return null;
  }
  if (customPeriodDays !== null) {
    return `customPeriodDays must be null when cadence is ${cadence}`;
  }
  return null;
}
