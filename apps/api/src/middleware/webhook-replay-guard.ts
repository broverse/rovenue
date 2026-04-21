import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { redis } from "../lib/redis";
import { logger } from "../lib/logger";
import { env } from "../lib/env";

const log = logger.child("webhook-replay-guard");

type WebhookSource = "apple" | "google" | "stripe";

export interface ReplayGuardOptions {
  source: WebhookSource;
  // Accepted window (seconds) between the store's timestamp and our
  // clock. Defaults to env.WEBHOOK_REPLAY_TOLERANCE_SECONDS.
  toleranceSeconds?: number;
}

export function webhookReplayGuard(
  opts: ReplayGuardOptions,
): MiddlewareHandler {
  const tolerance =
    opts.toleranceSeconds ?? env.WEBHOOK_REPLAY_TOLERANCE_SECONDS;

  return async (c, next) => {
    const eventId = c.get("webhookEventId");
    const eventTs = c.get("webhookEventTimestamp");

    if (!eventId || typeof eventTs !== "number") {
      throw new HTTPException(500, {
        message:
          "webhookReplayGuard: webhookEventId/Timestamp not set by verifier",
      });
    }

    const now = Math.floor(Date.now() / 1000);
    const skew = Math.abs(now - eventTs);
    if (skew > tolerance) {
      log.warn("webhook outside replay tolerance", {
        source: opts.source,
        eventId,
        skew,
        tolerance,
      });
      throw new HTTPException(400, {
        message: `Webhook timestamp outside tolerance (${skew}s > ${tolerance}s)`,
      });
    }

    const key = `webhook:seen:${opts.source}:${eventId}`;

    let added: "OK" | null = null;
    try {
      added = await redis.set(key, "1", "EX", tolerance * 2, "NX");
    } catch (err) {
      // Redis is the backstop, not the gate. Idempotency middleware
      // downstream still prevents DB double-writes for retry-critical
      // endpoints. Log + fail open so a Redis outage doesn't drop
      // live webhook deliveries.
      log.warn("redis SET NX failed, failing open", {
        source: opts.source,
        eventId,
        err: err instanceof Error ? err.message : String(err),
      });
      await next();
      return;
    }

    if (added !== "OK") {
      return c.json(
        { data: { status: "duplicate", source: opts.source } },
        200,
      );
    }

    await next();
  };
}
