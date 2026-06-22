import { Hono } from "hono";
import { drizzle, currentYearMonth } from "@rovenue/db";
import { requireDashboardAuth } from "../../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../../lib/project-access";
import { ok } from "../../../lib/response";
import { TIER_LIMITS } from "@rovenue/shared";
import { env } from "../../../lib/env";
import { resolveTier } from "../../../services/copilot/quota";
import { quotasUnlimited } from "../../../lib/host-mode";

export const copilotUsageRoute = new Hono()
  .use("*", requireDashboardAuth)
  .get("/", async (c) => {
    const projectId = c.req.param("projectId")!;
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id);

    const project = await drizzle.projectRepo.findProjectById(
      drizzle.db,
      projectId,
    );
    const { tier, unlimited } = resolveTier({
      project: { metadata: project?.settings as Record<string, unknown> | null },
      env,
      unlimited: quotasUnlimited(),
    });
    const ym = currentYearMonth();
    const row =
      (await drizzle.copilotUsageRepo.getUsage(drizzle.db, projectId, ym)) ?? {
        messages: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
    const limits = TIER_LIMITS[tier];
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    const end = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1),
    );
    const daysLeft = Math.max(
      0,
      Math.ceil((end.getTime() - now.getTime()) / 86_400_000),
    );

    return c.json(
      ok({
        tier,
        unlimited,
        period: {
          start: start.toISOString(),
          end: end.toISOString(),
          daysLeft,
        },
        messages: {
          used: row.messages,
          limit: Number.isFinite(limits.messages) ? limits.messages : null,
          percent: Number.isFinite(limits.messages)
            ? Math.round((row.messages / limits.messages) * 100)
            : 0,
        },
        tokens: {
          input: {
            used: row.inputTokens,
            limit: Number.isFinite(limits.inputTokens)
              ? limits.inputTokens
              : null,
          },
          output: {
            used: row.outputTokens,
            limit: Number.isFinite(limits.outputTokens)
              ? limits.outputTokens
              : null,
          },
        },
        resetAt: end.toISOString(),
      }),
    );
  });
