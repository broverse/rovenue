import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { drizzle, currentYearMonth } from "@rovenue/db";
import { env } from "../lib/env";
import { evaluateQuota, resolveTier } from "../services/copilot/quota";

export function roviQuotaGuard(): MiddlewareHandler {
  return async (c, next) => {
    const projectId = c.req.param("projectId");
    if (!projectId) throw new HTTPException(400, { message: "projectId required" });

    const project = await drizzle.projectRepo.findProjectById(
      drizzle.db,
      projectId,
    );
    if (!project) throw new HTTPException(404, { message: "Project not found" });

    const { tier, unlimited } = resolveTier({
      project: { metadata: project.settings as Record<string, unknown> | null },
      env,
    });
    const ym = currentYearMonth();
    const usage =
      (await drizzle.copilotUsageRepo.getUsage(drizzle.db, projectId, ym)) ?? {
        messages: 0,
        inputTokens: 0,
        outputTokens: 0,
      };

    const verdict = evaluateQuota({
      tier,
      unlimited,
      usage: {
        messages: usage.messages,
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      },
    });

    if (!verdict.allowed) {
      const resetAt = new Date(
        Date.UTC(
          new Date().getUTCFullYear(),
          new Date().getUTCMonth() + 1,
          1,
        ),
      ).toISOString();
      return c.json(
        {
          error: {
            code: "ROVI_QUOTA_EXCEEDED",
            message: `Monthly ${verdict.exceeded} limit reached`,
            tier,
            exceeded: verdict.exceeded,
            resetAt,
          },
        },
        429,
      );
    }

    await next();
  };
}
