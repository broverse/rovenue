import { randomBytes } from "node:crypto";
import { z } from "zod";
import { redis } from "../../lib/redis";
import type { ConnectMode } from "../../lib/stripe-platform";

// =============================================================
// Stripe OAuth `state` — CSRF token and flow context
// =============================================================
//
// The nonce is the only thing that travels through the user's browser.
// It carries no project or user information itself; the payload lives
// in Redis under a 10 minute TTL and is deleted on first read, so a
// leaked authorize URL is worthless after use or after ten minutes.

const TTL_SECONDS = 600;
const KEY_PREFIX = "stripe:oauth:";

const payloadSchema = z.object({
  projectId: z.string().min(1),
  userId: z.string().min(1),
  mode: z.enum(["live", "test"]),
});

export type OAuthStatePayload = {
  projectId: string;
  userId: string;
  mode: ConnectMode;
};

export async function createOAuthState(
  payload: OAuthStatePayload,
): Promise<string> {
  const nonce = randomBytes(32).toString("base64url");
  await redis.set(
    `${KEY_PREFIX}${nonce}`,
    JSON.stringify(payload),
    "EX",
    TTL_SECONDS,
  );
  return nonce;
}

/** Reads and deletes in one shot — replay of the same nonce yields null. */
export async function consumeOAuthState(
  nonce: string,
): Promise<OAuthStatePayload | null> {
  const raw = await redis.getdel(`${KEY_PREFIX}${nonce}`);
  if (!raw) return null;
  try {
    const parsed = payloadSchema.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}
