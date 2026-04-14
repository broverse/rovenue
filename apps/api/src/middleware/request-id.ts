import { randomUUID } from "node:crypto";
import type { MiddlewareHandler } from "hono";

const X_REQUEST_ID = "x-request-id";

declare module "hono" {
  interface ContextVariableMap {
    requestId: string;
  }
}

/**
 * Per-request correlation ID. Honours incoming `X-Request-Id` so
 * clients (SDKs, gateways, browsers) can stitch their own traces with
 * ours; falls back to a fresh UUID otherwise. Always echoed back in
 * the response header and stored on the Hono context for downstream
 * middleware and handlers.
 */
export const requestIdMiddleware: MiddlewareHandler = async (c, next) => {
  const incoming = c.req.header(X_REQUEST_ID);
  const id = incoming && incoming.length > 0 ? incoming : randomUUID();
  c.set("requestId", id);
  c.header(X_REQUEST_ID, id);
  await next();
};
