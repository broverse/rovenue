// =============================================================
// Subscription status — one table, every meaning
// =============================================================
//
// The set of statuses AND what each one means used to be spelled out
// independently in nine places: the Postgres enum (packages/db
// enums.ts), the TS const object (packages/db index.ts), the state
// machine's mirror (api subscription-state.ts), the access engine's
// granting set, the expiry sweeper's set, two metrics lists, and two
// raw-SQL IN(...) literals. None of them failed to compile when the
// enum grew, so adding a status meant remembering nine edits.
//
// This module is the source. `packages/db` derives its enum from
// SUBSCRIPTION_STATUSES; every consumer derives its list from
// SUBSCRIPTION_STATUS_SEMANTICS. Adding a status is one edit here plus
// a tsc error at this file until the new row is filled in.

/**
 * Every subscription status, in enum order. `packages/db`'s pgEnum and
 * its TS const object are both built from this tuple, so the Postgres
 * type and the TypeScript type cannot drift apart.
 */
export const SUBSCRIPTION_STATUSES = [
  "TRIAL",
  "ACTIVE",
  "EXPIRED",
  "REFUNDED",
  "REVOKED",
  "PAUSED",
  "GRACE_PERIOD",
  // Appended last, and every future status must be too: this tuple is
  // the Postgres enum's label order, and the enum is append-only.
  "BILLING_ISSUE",
] as const;

export type SubscriptionStatus = (typeof SUBSCRIPTION_STATUSES)[number];

export interface StatusSemantics {
  /** Produces a `subscriber_access` row (the access engine's union). */
  grantsAccess: boolean;
  /** Counts as an active subscription in dashboard/metrics rollups. */
  isLive: boolean;
  /** Absorbing: the state machine permits no outgoing edge. */
  isTerminal: boolean;
  /** The expiry sweeper may move this row when its period lapses. */
  sweepable: boolean;
  /** Store-reconciliation sweeps should keep re-polling this row. */
  reconcilable: boolean;
  /** Signals involuntary churn (payment failure) rather than a user choice. */
  involuntary: boolean;
}

/**
 * `Record`, not `Partial<Record>`: a new member of SUBSCRIPTION_STATUSES
 * is a compile error here until its meaning is declared. The §6
 * store-lifecycle batch shipped a silently-dropped provider event
 * because a `Partial<Record>` let a missing key compile — this is the
 * same hazard with the same fix.
 */
export const SUBSCRIPTION_STATUS_SEMANTICS: Record<
  SubscriptionStatus,
  StatusSemantics
> = {
  TRIAL: {
    grantsAccess: true,
    isLive: true,
    isTerminal: false,
    sweepable: true,
    reconcilable: true,
    involuntary: false,
  },
  ACTIVE: {
    grantsAccess: true,
    isLive: true,
    isTerminal: false,
    sweepable: true,
    reconcilable: true,
    involuntary: false,
  },
  GRACE_PERIOD: {
    grantsAccess: true,
    isLive: true,
    isTerminal: false,
    sweepable: true,
    reconcilable: true,
    involuntary: true,
  },
  // Voluntary pause (Google's PAUSED, Stripe's paused). No access, but
  // the subscription is expected back, so it stays live for rollups and
  // sweepable so a lapsed pause still reaches EXPIRED.
  PAUSED: {
    grantsAccess: false,
    isLive: true,
    isTerminal: false,
    sweepable: true,
    reconcilable: true,
    involuntary: false,
  },
  // Involuntary suspension for a payment failure the store has stopped
  // covering: Google account hold, Apple billing retry with no grace
  // period configured, Stripe `unpaid`/`incomplete`. Distinct from
  // GRACE_PERIOD (retry WITH access) and from PAUSED (the user's own
  // choice). Not sweepable — an account-hold row's expiresDate is
  // ALREADY past when the hold arrives, so the expiry sweeper would move
  // it straight to EXPIRED and erase the dunning signal the moment it
  // appeared. Retiring a stale hold is therefore a separate ageing pass
  // in expiry-checker.ts, landing with the store routing that first
  // writes this status; until then nothing produces a BILLING_ISSUE row.
  BILLING_ISSUE: {
    grantsAccess: false,
    isLive: true,
    isTerminal: false,
    sweepable: false,
    reconcilable: true,
    involuntary: true,
  },
  EXPIRED: {
    grantsAccess: false,
    isLive: false,
    isTerminal: false,
    sweepable: false,
    reconcilable: false,
    involuntary: false,
  },
  REFUNDED: {
    grantsAccess: false,
    isLive: false,
    isTerminal: true,
    sweepable: false,
    reconcilable: false,
    involuntary: false,
  },
  REVOKED: {
    grantsAccess: false,
    isLive: false,
    isTerminal: true,
    sweepable: false,
    reconcilable: false,
    involuntary: false,
  },
};

function statusesWhere(
  predicate: (semantics: StatusSemantics) => boolean,
): readonly SubscriptionStatus[] {
  return SUBSCRIPTION_STATUSES.filter((status) =>
    predicate(SUBSCRIPTION_STATUS_SEMANTICS[status]),
  );
}

/** Statuses whose purchases produce `subscriber_access` rows. */
export const ACCESS_GRANTING_STATUSES = statusesWhere((s) => s.grantsAccess);

/** Statuses counted as active subscriptions in metrics. */
export const LIVE_STATUSES = statusesWhere((s) => s.isLive);

/** Statuses the expiry sweeper may move on lapse. */
export const EXPIRY_SWEEP_STATUSES = statusesWhere((s) => s.sweepable);

/** Statuses a store-reconciliation sweep should keep re-polling. */
export const RECONCILABLE_STATUSES = statusesWhere((s) => s.reconcilable);

/** Absorbing statuses — no outgoing transition. */
export const TERMINAL_STATUSES = statusesWhere((s) => s.isTerminal);

/**
 * Statuses signaling involuntary churn (a payment failure), never the
 * user's own choice. Today exactly {GRACE_PERIOD, BILLING_ISSUE} — derived
 * rather than hand-listed so a metrics query built on "involuntary payment
 * trouble" (Task 4, apps/api/src/services/metrics/subscriptions.ts) picks
 * up a future involuntary status automatically instead of silently
 * excluding it, the same hazard `Record` (not `Partial<Record>`) guards
 * against above.
 */
export const INVOLUNTARY_STATUSES = statusesWhere((s) => s.involuntary);

/**
 * A single-quoted, comma-separated list for embedding in a raw SQL
 * `IN (...)`. Status names are compile-time constants from this module —
 * never user input — so interpolation is safe here and nowhere else.
 */
export function statusSqlList(
  statuses: readonly SubscriptionStatus[],
): string {
  return statuses.map((s) => `'${s}'`).join(", ");
}

// =============================================================
// Plan change direction
// =============================================================

/**
 * The direction of a subscription plan change, when a store states one.
 *
 * Lives here — beside the status semantics — rather than in apps/api,
 * because BOTH sides need it: the api's plan-change service produces it,
 * and `packages/db`'s `purchases.pendingChangeType` column is typed by it
 * (`.$type<PlanChangeType>()`), so a read comes back already narrowed
 * instead of as a bare `string | null` every consumer re-narrows.
 *
 * Only Apple states a direction (its UPGRADE / DOWNGRADE notification
 * subtypes). Google and Stripe do not, and it is NEVER derived from
 * price: `purchases.priceAmount` is the amount the store CHARGED, and a
 * prorated upgrade charges LESS than list price, so comparing prices
 * labels upgrades as downgrades. A null direction is honest; a guessed
 * one corrupts every cohort built on it.
 */
export const PLAN_CHANGE_TYPES = ["UPGRADE", "DOWNGRADE"] as const;

export type PlanChangeType = (typeof PLAN_CHANGE_TYPES)[number];

// =============================================================
// Family Sharing ownership
// =============================================================

/**
 * Apple's `inAppOwnershipType` value for a subscription a family
 * organiser shared with a member. Lives here — not in apps/api or
 * packages/db alone — because BOTH sides must agree on the exact
 * string: the API writes it onto `purchases.ownershipType` from the
 * decoded JWS transaction, and the db repository's
 * `createRevenueEvent` reads it back to suppress a second, double-
 * counted revenue event for a member who didn't pay. A future Apple
 * code path importing a different literal would silently break the
 * suppression, so both sides derive from this one constant instead.
 */
export const APPLE_FAMILY_SHARED_OWNERSHIP_TYPE = "FAMILY_SHARED";
