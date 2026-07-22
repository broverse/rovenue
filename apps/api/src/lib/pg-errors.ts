// =============================================================
// Reading Postgres errors through Drizzle's wrapper
// =============================================================
//
// Drizzle (0.45.2) does not rethrow the driver's error. Every pg-core
// query failure is re-thrown as `new DrizzleQueryError(query, params, e)`
// (node_modules/drizzle-orm/pg-core/session.js), which hangs the real
// `pg` error off `.cause`. Neither `code` nor `constraint` is therefore
// present on the object a caller catches, so the obvious
//
//     if ((err as { code?: string })?.code === "23505") { ... }
//
// silently never matches: the branch it guards becomes dead code and
// every real unique violation escapes as a 500. `db.transaction()`
// rethrows the callback's error unchanged, so the wrapper survives a
// transaction boundary too — the chain just has to be walked.
//
// These helpers fail CLOSED on purpose. An unrecognised shape — a bare
// string, a null cause, a chain deeper than the bound — answers "no
// match", which makes the caller rethrow rather than swallow an error it
// did not actually identify.

/** Postgres `unique_violation`. */
export const UNIQUE_VIOLATION = "23505";

/**
 * How far down `.cause` to look. In practice the driver error sits at
 * depth 1, directly under the `DrizzleQueryError`. The bound exists so a
 * self-referential or pathologically deep chain terminates instead of
 * spinning.
 */
const MAX_CAUSE_DEPTH = 5;

/** The fields we care about, on whatever link of the chain carries them. */
type ErrorLink = { code?: unknown; constraint?: unknown; cause?: unknown };

/**
 * Walk `err` and its `.cause` chain, calling `match` on each link.
 *
 * Property reads on a non-object (a thrown string or number) yield
 * `undefined` rather than throwing, so those simply fail to match; the
 * `e != null` bound is what keeps a null/undefined cause from being
 * dereferenced.
 */
function someCause(err: unknown, match: (link: ErrorLink) => boolean): boolean {
  for (let e = err, depth = 0; e != null && depth < MAX_CAUSE_DEPTH; depth += 1) {
    const link = e as ErrorLink;
    if (match(link)) return true;
    e = link.cause;
  }
  return false;
}

/**
 * Is this — at any level of the cause chain — a Postgres unique violation?
 *
 * Prefer {@link isUniqueViolationOf} wherever the caller knows which
 * constraint it means. A bare code check treats every unique index on the
 * table as the same event, which is only ever correct when the statement
 * can violate exactly one of them.
 */
export function isUniqueViolation(err: unknown): boolean {
  return someCause(err, (link) => link.code === UNIQUE_VIOLATION);
}

/**
 * Is this a unique violation of the *named* constraint or unique index?
 *
 * `code` and `constraint` must both come from the SAME link — a code on
 * the wrapper and a constraint on some other link is not evidence of
 * anything. Postgres reports the index name in `constraint` for unique
 * index violations, partial indexes included, so the name to pass is
 * whatever the migration's `CREATE UNIQUE INDEX` / `ADD CONSTRAINT`
 * declared.
 */
export function isUniqueViolationOf(err: unknown, constraint: string): boolean {
  return someCause(
    err,
    (link) => link.code === UNIQUE_VIOLATION && link.constraint === constraint,
  );
}
