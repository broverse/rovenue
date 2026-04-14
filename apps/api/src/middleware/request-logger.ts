import type { MiddlewareHandler } from "hono";
import { pinoLogger, requestContext } from "../lib/logger";

/**
 * Log request start + completion (or failure) with duration. Runs the
 * downstream chain inside an AsyncLocalStorage scope so every log line
 * emitted during the request — from middleware, handlers, and nested
 * services — automatically picks up `requestId` and any other fields
 * we stash on the context.
 */
export const requestLoggerMiddleware: MiddlewareHandler = async (c, next) => {
  const requestId = c.get("requestId");
  const method = c.req.method;
  const path = c.req.path;
  const start = Date.now();

  await requestContext.run({ requestId }, async () => {
    pinoLogger.info(
      { method, path, action: "request.start" },
      `→ ${method} ${path}`,
    );

    try {
      await next();
      const durationMs = Date.now() - start;
      const project = c.get("project");
      const store = requestContext.getStore();
      pinoLogger.info(
        {
          method,
          path,
          statusCode: c.res.status,
          durationMs,
          projectId: project?.id ?? store?.projectId,
          subscriberId: store?.subscriberId,
          action: "request.end",
        },
        `← ${method} ${path} ${c.res.status} (${durationMs}ms)`,
      );
    } catch (err) {
      const durationMs = Date.now() - start;
      pinoLogger.error(
        {
          method,
          path,
          durationMs,
          err: err instanceof Error ? err.message : String(err),
          stack: err instanceof Error ? err.stack : undefined,
          action: "request.error",
        },
        `× ${method} ${path} failed after ${durationMs}ms`,
      );
      throw err;
    }
  });
};
