import { type FeatureFlagEnv, drizzle } from "@rovenue/db";
import {
  applyMutations,
  flattenAttributes,
  normalizeStored,
} from "@rovenue/shared";
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

  const existing =
    await drizzle.subscriberRepo.findSubscriberAttributesByRovenueId(
      drizzle.db,
      { projectId, rovenueId: appUserId },
    );
  const currentNested = normalizeStored(existing?.attributes);
  const hasNewAttributes = Object.keys(requestAttributes).length > 0;
  const now = new Date().toISOString();
  const mergedNested = applyMutations(
    currentNested,
    requestAttributes,
    "sdk",
    now,
  );
  const evalAttributes = flattenAttributes(mergedNested);

  const subscriber = await drizzle.subscriberRepo.upsertSubscriber(drizzle.db, {
    projectId,
    rovenueId: appUserId,
    createAttributes: mergedNested,
    ...(hasNewAttributes && { updateAttributes: mergedNested }),
  });

  const [flags, experiments] = await Promise.all([
    evaluateAllFlags(projectId, env, subscriber.id, evalAttributes),
    evaluateExperiments(projectId, subscriber.id, evalAttributes),
  ]);

  return { flags, experiments };
}
