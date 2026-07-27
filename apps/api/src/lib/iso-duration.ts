const DAYS_PER_WEEK = 7;
const DAYS_PER_MONTH = 30;
const DAYS_PER_YEAR = 365;

/**
 * Parses an ISO-8601 duration of the form `P<n>D|W|M|Y` (a single
 * designator — the only shapes the App Store Connect and Google Play
 * APIs emit for billing periods, offer phases and trial durations)
 * into a day count. Returns null when unparseable.
 */
export function isoDurationToDays(iso: string): number | null {
  const match = /^P(\d+)([DWMY])$/.exec(iso);
  if (!match) return null;
  const n = Number(match[1]);
  switch (match[2]) {
    case "D":
      return n;
    case "W":
      return n * DAYS_PER_WEEK;
    case "M":
      return n * DAYS_PER_MONTH;
    case "Y":
      return n * DAYS_PER_YEAR;
    default:
      return null;
  }
}
