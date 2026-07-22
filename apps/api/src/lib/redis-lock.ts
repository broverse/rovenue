import { randomUUID } from "node:crypto";
import { redis } from "./redis";
import { logger } from "./logger";

// =============================================================
// Single-holder Redis lock
// =============================================================
//
// For read-then-write sequences that span network calls: two concurrent
// requests both read the same "before" state, both act on it, and both
// write — last write wins and the loser's side effects are stranded.
// `SET key <token> NX PX <ttl>` makes the read-then-write mutually
// exclusive for `ttlMs`.
//
// The token is what makes release safe. A blind `DEL` would, if our own
// work outran the TTL, delete a lock a *different* request had since
// acquired — which is worse than holding no lock at all, because the
// caller believes it is serialized when it is not. Release therefore
// compares before deleting, and does so in a Lua script so the
// compare-and-delete is one atomic server-side step; a JS-side
// get/compare/delete has a window between the GET and the DEL in which
// the lock can expire and be re-acquired by someone else, which is the
// exact bug the token exists to prevent.

const log = logger.child("redis-lock");

/**
 * Delete the key only if it still holds our token.
 * Returns 1 when we released our own lock, 0 when it was already gone or
 * belongs to a later holder.
 */
const RELEASE_SCRIPT = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end
`;

/**
 * Run `fn` while holding `key`, or return `null` if someone else holds it.
 *
 * `null` means "not acquired" — it is never a value `fn` produced, so
 * callers should have `fn` return something non-null.
 *
 * The release runs in a `finally`: a throwing `fn` must not leave the key
 * held for the rest of its TTL, since that would wedge every subsequent
 * request for the same key.
 */
export async function withLock<T>(
  key: string,
  ttlMs: number,
  fn: () => Promise<T>,
): Promise<T | null> {
  const token = randomUUID();
  const acquired = await redis.set(key, token, "PX", ttlMs, "NX");
  if (acquired !== "OK") return null;

  try {
    return await fn();
  } finally {
    try {
      await redis.eval(RELEASE_SCRIPT, 1, key, token);
    } catch (err) {
      // The lock still expires on its own, so a failed release costs at
      // most one TTL of contention on this key — not a failed request.
      log.warn("failed to release lock", {
        key,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}
