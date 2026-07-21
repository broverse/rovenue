import type { MiddlewareHandler } from "hono";
import { drizzle } from "@rovenue/db";

// =============================================================
// Usage-lock guard (Plausible model)
// =============================================================
// Blocks dashboard feature routes for projects whose hard caps were
// exceeded two consecutive billing periods (projects.usage_locked_at
// set by the usage-cap sweeper). Billing routes stay reachable so the
// customer can upgrade; SDK /v1 and webhooks are untouched by design
// (data collection never stops).

export const usageLockGuard: MiddlewareHandler = async (c, next) => {
  const projectId = c.req.param("projectId");
  if (!projectId) return next();
  if (c.req.path.includes(`/projects/${projectId}/billing`)) return next();

  const project = await drizzle.projectRepo.findProjectById(drizzle.db, projectId);
  if (project?.usageLockedAt) {
    return c.json(
      {
        error: {
          code: "usage_limit_exceeded",
          message:
            "Usage limits were exceeded for two consecutive billing periods. Upgrade your plan to restore dashboard access.",
        },
      },
      403,
    );
  }
  return next();
};
