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
