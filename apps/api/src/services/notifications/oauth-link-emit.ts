// =============================================================
// security.oauth.account_linked emitter
// =============================================================
//
// Fires when a user links a NEW OAuth provider to an existing
// account. Detection is: after the auth callback, the user has
// more than one `account` row AND the newest one was created in
// the last 10 seconds (i.e. by the request we're handling).
//
// First-time OAuth sign-up is excluded because the user has
// exactly one account at that point — security.signin.new_device
// covers the "someone signed in" angle, and account_linked is
// reserved for the explicit "another auth method was added"
// security signal.

import { eq, desc } from "drizzle-orm";
import { drizzle, type Db } from "@rovenue/db";
import { logger } from "../../lib/logger";
import { captureNotifierError } from "../../lib/sentry-notifications";
import { emitNotification } from "./emit";

const log = logger.child("notifier.oauth-link-emit");

/** Account considered "fresh" if it was created within this window. */
export const FRESH_ACCOUNT_WINDOW_MS = 10_000;

export type OAuthProvider = "github" | "google";

const KNOWN_PROVIDERS = new Set<string>(["github", "google"]);

function isKnownProvider(p: string): p is OAuthProvider {
  return KNOWN_PROVIDERS.has(p);
}

export interface OAuthLinkEmitInput {
  userId: string;
  /** Optional clock seam for tests. */
  now?: Date;
}

/**
 * Fire-and-forget. Returns the linked provider when a notification
 * was emitted; null otherwise (no link detected, or unknown
 * provider, or error).
 */
export async function maybeEmitOAuthLink(
  db: Db,
  input: OAuthLinkEmitInput,
): Promise<{ provider: OAuthProvider } | null> {
  try {
    const now = input.now ?? new Date();
    const accounts = await db
      .select({
        providerId: drizzle.schema.account.providerId,
        createdAt: drizzle.schema.account.createdAt,
      })
      .from(drizzle.schema.account)
      .where(eq(drizzle.schema.account.userId, input.userId))
      .orderBy(desc(drizzle.schema.account.createdAt));

    // First-time sign-up: skip (covered by signin.new_device).
    if (accounts.length < 2) return null;

    const newest = accounts[0];
    if (!newest) return null;
    if (now.getTime() - newest.createdAt.getTime() > FRESH_ACCOUNT_WINDOW_MS) {
      // Older link operation already accounted for — skip.
      return null;
    }
    if (!isKnownProvider(newest.providerId)) return null;

    await db.transaction(async (tx) => {
      await emitNotification(tx, {
        eventKey: "security.oauth.account_linked",
        // Per (userId, provider, dayBucket) so multiple link/unlink
        // ping-pongs within a day surface a single notification.
        eventId: `oauth.account_linked:${input.userId}:${newest.providerId}:${now
          .toISOString()
          .slice(0, 10)}`,
        recipients: [input.userId],
        context: {
          provider: newest.providerId,
          whenIso: now.toISOString(),
        },
      });
    });
    return { provider: newest.providerId };
  } catch (err) {
    log.warn("emit_skipped", {
      userId: input.userId,
      err: err instanceof Error ? err.message : String(err),
    });
    captureNotifierError(err, {
      component: "notifier",
      eventKey: "security.oauth.account_linked",
      userId: input.userId,
      reason: "emit_failed",
    });
    return null;
  }
}
