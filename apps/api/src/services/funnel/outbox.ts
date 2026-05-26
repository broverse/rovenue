// =============================================================
// Funnel outbox event emission
// =============================================================
//
// Thin wrapper around `outboxRepo.insert` that fixes the
// aggregateType to "FUNNEL" and tags every payload with a
// server-side timestamp. Call sites pass the lifecycle-specific
// payload + the kind. The outbox row commits inside whatever
// transaction the caller is currently in (the repo never opens
// its own tx), so the outbox row is guaranteed to be visible
// only if the domain change committed too — that's the
// transactional-outbox invariant.

import { drizzle, type Db } from "@rovenue/db";

export type FunnelEventKind =
  | "funnel.session.started"
  | "funnel.session.advanced"
  | "funnel.session.paid"
  | "funnel.session.completed"
  | "funnel.session.abandoned"
  | "funnel.claim_token.issued"
  | "funnel.claim_token.claimed";

export async function emitFunnelEvent(
  db: Db,
  kind: FunnelEventKind,
  sessionId: string,
  payload: Record<string, unknown>,
): Promise<void> {
  await drizzle.outboxRepo.insert(db, {
    aggregateType: "FUNNEL",
    aggregateId: sessionId,
    eventType: kind,
    payload: {
      ...payload,
      at: new Date().toISOString(),
    },
  });
}
