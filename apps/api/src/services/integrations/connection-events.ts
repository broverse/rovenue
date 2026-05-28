// =============================================================
// connection-events — integration connection lifecycle gates
// =============================================================
//
// M4.4 — pure function that gates backfill on the false→true
// enable transition.  When `wasEnabled === false` AND
// `willBeEnabled === true`, calls `deps.enqueueBackfill()`.
// All other transitions are no-ops.

import type { ProviderId } from "./types";
import type { EnqueueBackfillResult } from "./backfill";

// =============================================================
// Types
// =============================================================

export interface EnableTransitionArgs {
  connectionId: string;
  projectId: string;
  providerId: ProviderId;
  wasEnabled: boolean;
  willBeEnabled: boolean;
  windowDays?: number;
}

export interface EnableTransitionDeps {
  enqueueBackfill: (args: {
    connectionId: string;
    projectId: string;
    providerId: ProviderId;
    windowDays?: number;
  }) => Promise<EnqueueBackfillResult>;
}

// =============================================================
// Implementation
// =============================================================

/**
 * Pure function that calls `deps.enqueueBackfill` only when the
 * integration connection transitions from disabled to enabled
 * (false → true).  All other transitions are no-ops.
 *
 * Returns the backfill result when backfill was triggered,
 * or `null` when the transition is a no-op.
 */
export async function handleConnectionEnableTransition(
  args: EnableTransitionArgs,
  deps: EnableTransitionDeps,
): Promise<EnqueueBackfillResult | null> {
  const isActivating = !args.wasEnabled && args.willBeEnabled;
  if (!isActivating) {
    return null;
  }

  return deps.enqueueBackfill({
    connectionId: args.connectionId,
    projectId: args.projectId,
    providerId: args.providerId,
    windowDays: args.windowDays,
  });
}
