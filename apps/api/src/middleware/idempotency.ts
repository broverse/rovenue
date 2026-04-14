import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { logger } from "../lib/logger";
import { redis } from "../lib/redis";

// =============================================================
// Idempotency-Key middleware
// =============================================================
//
// Clients send `Idempotency-Key: <uuid>` on the retry-dangerous
// endpoints (receipts, credit spend, credit add). The first request
// through runs normally and its 2xx response is cached in Redis for
// 24h, scoped by the authenticated project. A subsequent request
// with the same key replays the cached response; a request with the
// same key but a different body is rejected with 422 so clients
// can't accidentally reuse a key for a different operation.
//
// Graceful degradation: every Redis call is wrapped in try/catch and
// fails open. If Redis is down we simply skip caching and let the
// underlying handler run — availability over dedup.

const log = logger.child("idempotency");

const HEADER_NAME = "idempotency-key";
const TTL_SECONDS = 60 * 60 * 24;
const REPLAY_HEADER = "idempotent-replay";
const KEY_MAX_LENGTH = 255;

interface StoredResponse {
  v: 1;
  status: number;
  body: string;
  requestHash: string;
  contentType: string | null;
}

function hashBody(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

async function readRawRequestBody(req: Request): Promise<string> {
  try {
    return await req.clone().text();
  } catch {
    return "";
  }
}

export const idempotency: MiddlewareHandler = async (c, next) => {
  const idempotencyKey = c.req.header(HEADER_NAME);
  if (!idempotencyKey) {
    await next();
    return;
  }
  if (idempotencyKey.length > KEY_MAX_LENGTH) {
    throw new HTTPException(400, {
      message: `Idempotency-Key must be ≤ ${KEY_MAX_LENGTH} chars`,
    });
  }

  const project = c.get("project");
  const scope = project?.id ?? "anon";
  const redisKey = `idempotency:${scope}:${idempotencyKey}`;

  const rawBody = await readRawRequestBody(c.req.raw);
  const requestHash = hashBody(rawBody);

  // --- Lookup cache (fail open) ---
  let cached: string | null = null;
  try {
    cached = await redis.get(redisKey);
  } catch (err) {
    log.warn("redis get failed, failing open", {
      err: err instanceof Error ? err.message : String(err),
    });
  }

  if (cached) {
    let stored: StoredResponse | null = null;
    try {
      const parsed = JSON.parse(cached) as StoredResponse;
      if (parsed && parsed.v === 1) stored = parsed;
    } catch {
      log.warn("cached idempotency payload corrupt, ignoring", { redisKey });
    }

    if (stored) {
      if (stored.requestHash !== requestHash) {
        throw new HTTPException(422, {
          message:
            "Idempotency-Key has been used with a different request body",
        });
      }
      const headers = new Headers();
      if (stored.contentType) headers.set("content-type", stored.contentType);
      headers.set(REPLAY_HEADER, "true");
      return new Response(stored.body, {
        status: stored.status,
        headers,
      });
    }
  }

  await next();

  // --- Capture response (only for 2xx) ---
  const res = c.res;
  if (!res || res.status < 200 || res.status >= 300) return;

  let responseBody: string;
  try {
    responseBody = await res.clone().text();
  } catch (err) {
    log.warn("failed to read response body for caching", {
      err: err instanceof Error ? err.message : String(err),
    });
    return;
  }

  const payload: StoredResponse = {
    v: 1,
    status: res.status,
    body: responseBody,
    requestHash,
    contentType: res.headers.get("content-type"),
  };

  try {
    await redis.set(redisKey, JSON.stringify(payload), "EX", TTL_SECONDS);
  } catch (err) {
    log.warn("redis set failed, not cached", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
};
