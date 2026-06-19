/**
 * Transparent per-subscriber churn-risk heuristic (0–100).
 *
 * Intentionally simple and explainable — every point is attributable to a
 * concrete signal we already store, not a black-box model. The score maps to
 * the dashboard RiskMeter thresholds: <40 green, 40–69 amber, >=70 red.
 *
 * Signals (all cheaply available in the subscriber-list query):
 *  - lost access after paying  → already churned (strongest)
 *  - in grace period           → billing actively failing / retry limbo
 *  - auto-renew off (still active) → explicit cancellation intent
 *  - days since last activity  → engagement decay (graduated)
 *
 * A subscriber who never purchased has nothing to churn from, so their score
 * is 0 — they are an unconverted lead, not a churn risk.
 */
export interface ChurnRiskInput {
  /** Total purchases ever made by the subscriber. 0 ⇒ never a paying customer. */
  purchaseCount: number;
  /** Holds at least one currently-active entitlement. */
  hasActiveAccess: boolean;
  /** Has a purchase currently in GRACE_PERIOD (billing retry window). */
  inGracePeriod: boolean;
  /** Has an active purchase with auto-renew explicitly turned off. */
  autoRenewOff: boolean;
  /** Timestamp the subscriber was last seen. */
  lastSeenAt: Date;
  /** Override "now" for deterministic tests; defaults to the current time. */
  now?: Date;
}

const DAY_MS = 86_400_000;

export function churnRiskScore(input: ChurnRiskInput): number {
  const { purchaseCount, hasActiveAccess, inGracePeriod, autoRenewOff, lastSeenAt } = input;

  // Never a paying customer → nothing to churn from.
  if (purchaseCount <= 0) return 0;

  let score = 0;

  // Subscription health — mutually exclusive, strongest first.
  if (!hasActiveAccess) {
    score += 55; // lost access after paying → already churned
  } else if (inGracePeriod) {
    score += 45; // billing actively failing
  } else if (autoRenewOff) {
    score += 35; // active but will not renew
  }

  // Engagement decay — graduated by days since last activity.
  const now = input.now ?? new Date();
  const days = Math.floor((now.getTime() - lastSeenAt.getTime()) / DAY_MS);
  if (days >= 30) {
    score += 30;
  } else if (days >= 14) {
    score += 20;
  } else if (days >= 7) {
    score += 10;
  }

  return Math.max(0, Math.min(100, score));
}
