import { redis } from "./redis";
import { logger } from "./logger";

const log = logger.child("config-invalidation");

/**
 * Redis pub/sub channel the SSE `/v1/config/stream` listens on. Publishing a
 * `{ projectId }` message tells every connected stream for that project to
 * re-evaluate and push fresh `{ flags, experiments }` to its subscriber.
 */
export const CONFIG_INVALIDATE_CHANNEL = "rovenue:experiments:invalidate";

/**
 * Notify connected config streams that a project's flag / experiment /
 * audience config changed. Best-effort: a publish failure just means streamed
 * clients pick up the change on their next reconnect / cache miss. Uses the
 * shared (non-subscriber) redis client — publishing is a normal command and
 * does not put the connection into subscribe mode.
 */
export async function publishConfigInvalidation(
  projectId: string,
): Promise<void> {
  try {
    await redis.publish(
      CONFIG_INVALIDATE_CHANNEL,
      JSON.stringify({ projectId }),
    );
  } catch (err) {
    log.warn("config invalidation publish failed", {
      projectId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * A config-invalidation message.
 *
 * `subscriberIds` absent means project-wide — that is what every
 * config-CRUD publisher sends, and what an older replica writes during a
 * rolling deploy. Present means only those subscribers' streams need to
 * re-evaluate.
 *
 * The widening is safe in both deploy directions: an old replica reads
 * only `projectId` and treats a targeted message as project-wide, which
 * over-invalidates exactly as it does today. Nothing here can ever cause
 * a stream to be woken LESS often than before.
 */
export interface ConfigInvalidationMessage {
  projectId: string;
  subscriberIds?: string[];
}

/**
 * Notify only the named subscribers' open config streams. Best-effort,
 * like its project-wide sibling: a publish failure means the device picks
 * the change up on its next poll or reconnect.
 */
export async function publishSubscriberInvalidation(
  projectId: string,
  subscriberIds: string[],
): Promise<void> {
  if (subscriberIds.length === 0) return;
  try {
    await redis.publish(
      CONFIG_INVALIDATE_CHANNEL,
      JSON.stringify({ projectId, subscriberIds }),
    );
  } catch (err) {
    log.warn("subscriber invalidation publish failed", {
      projectId,
      count: subscriberIds.length,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

export function parseConfigInvalidation(
  payload: string,
): ConfigInvalidationMessage | null {
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;

  const obj = raw as Record<string, unknown>;
  const projectId = obj.projectId;
  if (typeof projectId !== "string" || projectId.length === 0) return null;

  const ids = obj.subscriberIds;
  // Anything that is not a clean string array degrades to project-wide.
  if (
    Array.isArray(ids) &&
    ids.length > 0 &&
    ids.every((id) => typeof id === "string")
  ) {
    return { projectId, subscriberIds: ids as string[] };
  }
  return { projectId };
}
