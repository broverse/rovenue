import type { MiddlewareHandler } from "hono";
import { env } from "../lib/env";
import { httpRequestsTotal, httpRequestDuration } from "../lib/metrics";

/**
 * RED metrics (rate/errors/duration) for every request reaching this
 * middleware. Uses the MATCHED route pattern (e.g. /v1/subscribers/:id)
 * — never the raw path — to keep Prometheus series count bounded.
 * No-op when METRICS_ENABLED is false.
 */
export const metricsMiddleware: MiddlewareHandler = async (c, next) => {
  if (!env.METRICS_ENABLED) {
    return next();
  }

  const start = performance.now();
  try {
    await next();
  } finally {
    const seconds = (performance.now() - start) / 1000;
    const labels = {
      method: c.req.method,
      route: c.req.routePath || "unmatched",
      status: String(c.res?.status ?? 500),
    };
    httpRequestsTotal.inc(labels);
    httpRequestDuration.observe(labels, seconds);
  }
};
