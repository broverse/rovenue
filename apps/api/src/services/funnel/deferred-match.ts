/**
 * IP-only deferred-claim match decision. The backend recovers an iOS funnel
 * token only when exactly ONE unclaimed deferred-claim row exists for the
 * request IP within the window. Zero means no match; two or more means a
 * shared IP (NAT/CGNAT) where granting could leak one user's purchase to
 * another — so we deliberately decline rather than guess.
 */
export function selectUniqueCandidate<T>(candidates: T[]): T | null {
  return candidates.length === 1 ? candidates[0] : null;
}
