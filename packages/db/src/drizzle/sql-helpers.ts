import { sql, type AnyColumn, type SQL } from "drizzle-orm";

// =============================================================
// TimescaleDB SQL helpers
// =============================================================
//
// Small wrappers for Timescale-specific SQL functions. Each
// interval argument is wrapped in `sql.param()` so it ships as
// a bound placeholder instead of being interpolated as raw SQL
// text — plain `${…}` inside the `sql` tag would emit the
// interval string into the query body and open an injection
// surface through the argument, even for app-supplied literals.
// Callers MUST still treat the interval as a trusted constant.

/**
 * `time_bucket(INTERVAL '<interval>', column)` — rounds a
 * timestamp column to the nearest bucket boundary. Used on the
 * read path (SELECT time_bucket(...)) and for continuous
 * aggregate queries alike.
 *
 * @param interval e.g. `"1 day"`, `"1 hour"`, `"15 minutes"`.
 */
export function timeBucket(
  interval: string,
  column: AnyColumn | SQL,
): SQL<Date> {
  return sql<Date>`time_bucket(${sql.param(interval)}::interval, ${column})`;
}

/**
 * `NOW() - INTERVAL '<offset>'` — convenient cutoff expression
 * for windowed reads (e.g. "last 30 days"). Returns a SQL
 * fragment, not a bound value, so it evaluates on the DB side.
 */
export function nowMinus(offset: string): SQL<Date> {
  return sql<Date>`(NOW() - ${sql.param(offset)}::interval)`;
}
