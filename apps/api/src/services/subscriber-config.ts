import { type FeatureFlagEnv, drizzle } from "@rovenue/db";
import {
  applyMutations,
  flattenAttributes,
  normalizeStored,
} from "@rovenue/shared";
import { resolveSubscriberForWrite } from "../lib/resolve-or-create-subscriber";
import { evaluateAllFlags } from "./flag-engine";
import { evaluateExperiments } from "./experiment-engine";

// =============================================================
// evaluateSubscriberConfig — shared flag + experiment evaluation
// =============================================================
//
// The single source of truth for "what config does this subscriber see".
// Used by both GET/POST /v1/config and the SSE /v1/config/stream so the two
// surfaces can never diverge (the streamed payload is the same evaluated
// `{ flags, experiments }` shape as the unary endpoint, per audit finding
// CS1). Read-then-upsert merges request attributes into the stored nested
// set and passes a flat projection to the engines.

export interface SubscriberConfig {
  flags: Awaited<ReturnType<typeof evaluateAllFlags>>;
  experiments: Awaited<ReturnType<typeof evaluateExperiments>>;
}

export async function evaluateSubscriberConfig(args: {
  projectId: string;
  appUserId: string;
  env: FeatureFlagEnv;
  requestAttributes: Record<string, string | null>;
}): Promise<SubscriberConfig> {
  const { projectId, appUserId, env, requestAttributes } = args;

  // Merge-aware: after a /v1/subscribers/transfer the device's rovenueId
  // still names the retired row, so a bare rovenueId read/upsert would fork
  // this device's attributes AND its flag/experiment assignments onto the
  // dead row forever. Resolve the live survivor first.
  const now = new Date().toISOString();
  const { subscriber, deadEnded } = await resolveSubscriberForWrite(
    projectId,
    appUserId,
    // Applied only when no row exists yet (fresh device): merge the request
    // attributes into an empty base at create time.
    applyMutations({}, requestAttributes, "sdk", now),
  );

  const currentNested = normalizeStored(subscriber.attributes);
  const hasNewAttributes = Object.keys(requestAttributes).length > 0;
  const mergedNested = applyMutations(
    currentNested,
    requestAttributes,
    "sdk",
    now,
  );
  const evalAttributes = flattenAttributes(mergedNested);

  // Never write onto a dead-ended (e.g. GDPR-erased) row — evaluation still
  // proceeds with the in-memory merge so the device keeps working.
  if (hasNewAttributes && !deadEnded) {
    await drizzle.subscriberRepo.updateSubscriberAttributesById(
      drizzle.db,
      subscriber.id,
      mergedNested,
    );
  }

  const [flags, experiments] = await Promise.all([
    evaluateAllFlags(projectId, env, subscriber.id, evalAttributes),
    evaluateExperiments(projectId, subscriber.id, evalAttributes),
  ]);

  return { flags, experiments };
}
