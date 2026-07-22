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
//
// The TTL is a deadline, not a guarantee, so the same token also backs an
// ownership check (`LockHandle.stillHeld`): work that outran its TTL must
// be able to find that out before it commits anything.

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
 * Redis itself was unreachable, so the lock could not be *acquired* —
 * which is a different thing from "somebody else holds it" (a `null`
 * return).
 *
 * It exists so a caller can tell a transient dependency outage apart from
 * anything its own `fn` threw, and answer with a deliberate retryable
 * status instead of letting it surface as an unexpected internal error.
 */
export class LockUnavailableError extends Error {
  readonly key: string;

  constructor(key: string, cause: unknown) {
    super(
      `could not acquire lock ${key}: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "LockUnavailableError";
    this.key = key;
    this.cause = cause;
  }
}

/**
 * Handed to `fn` so it can fence its own side effects.
 *
 * If `fn` outruns the TTL the key expires and another request acquires
 * it while this one is still running — and both then believe they are
 * serialized. Anything destructive inside `fn` should therefore ask
 * `stillHeld()` immediately before it commits, and bail if the answer is
 * no. That makes correctness independent of whether the TTL was generous
 * enough, which no fixed number can guarantee across network calls.
 */
export interface LockHandle {
  /**
   * True only if the key still carries *this* call's token. Fails closed:
   * an unanswerable question (Redis down) reads as `false`.
   */
  stillHeld(): Promise<boolean>;
}

/**
 * Run `fn` while holding `key`, or return `null` if someone else holds it.
 *
 * `null` means "not acquired" — it is never a value `fn` produced, so
 * callers should have `fn` return something non-null. If Redis is
 * unreachable this throws `LockUnavailableError` instead of returning
 * `null`, because "nobody could take the lock" and "somebody else has it"
 * deserve different answers to the client.
 *
 * NOT re-entrant. Taking the same key twice in one process — a `withLock`
 * nested inside another `withLock`'s `fn`, or two collaborating handlers
 * of one request — makes the inner call return `null`, because `SET NX`
 * cannot tell our own outer holder from a competing process. Callers that
 * compose (e.g. a confirm endpoint reusing a session's payment key) must
 * take the key once at the outermost point and pass the `LockHandle` down.
 *
 * The release runs in a `finally`: a throwing `fn` must not leave the key
 * held for the rest of its TTL, since that would wedge every subsequent
 * request for the same key.
 */
export async function withLock<T>(
  key: string,
  ttlMs: number,
  fn: (lock: LockHandle) => Promise<T>,
): Promise<T | null> {
  const token = randomUUID();
  let acquired: string | null;
  try {
    acquired = await redis.set(key, token, "PX", ttlMs, "NX");
  } catch (err) {
    throw new LockUnavailableError(key, err);
  }
  if (acquired !== "OK") return null;

  const handle: LockHandle = {
    async stillHeld() {
      try {
        return (await redis.get(key)) === token;
      } catch (err) {
        // Fails closed. Callers gate destructive work on this, and doing
        // that work unserialized is the failure the lock exists to
        // prevent — so an unanswerable "do I still hold it?" is a "no".
        log.warn("could not confirm lock ownership", {
          key,
          error: err instanceof Error ? err.message : String(err),
        });
        return false;
      }
    },
  };

  try {
    return await fn(handle);
  } finally {
    try {
      const released = await redis.eval(RELEASE_SCRIPT, 1, key, token);
      if (released !== 1) {
        // We ran past our own TTL: the key had expired — and possibly
        // been re-acquired — while we still believed we held it. There is
        // nothing to repair here, but it must not be silent. This is the
        // only place that degradation is observable, and it is the signal
        // that the TTL is too short for the work under this key.
        log.warn("lock was no longer ours at release", { key });
      }
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
