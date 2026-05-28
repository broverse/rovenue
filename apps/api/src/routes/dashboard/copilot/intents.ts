import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { drizzle, MemberRole } from "@rovenue/db";
import { requireDashboardAuth } from "../../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../../lib/project-access";
import { ok } from "../../../lib/response";
import { executeIntent } from "../../../services/copilot/intent-executor";

export const copilotIntentsRoute = new Hono()
  .use("*", requireDashboardAuth)
  .get("/:id", async (c) => {
    const projectId = c.req.param("projectId")!;
    const id = c.req.param("id")!;
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id);
    const intent = await drizzle.copilotIntentRepo.getIntent(drizzle.db, id);
    if (!intent || intent.projectId !== projectId) {
      throw new HTTPException(404, { message: "Intent not found" });
    }
    return c.json(ok({ intent }));
  })
  .post("/:id/reject", async (c) => {
    const projectId = c.req.param("projectId")!;
    const id = c.req.param("id")!;
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id);
    const intent = await drizzle.copilotIntentRepo.getIntent(drizzle.db, id);
    if (!intent || intent.projectId !== projectId) {
      throw new HTTPException(404, { message: "Intent not found" });
    }
    if (intent.status !== "pending") {
      throw new HTTPException(409, {
        message: `Cannot reject ${intent.status}`,
      });
    }
    const updated = await drizzle.copilotIntentRepo.transitionIntent(
      drizzle.db,
      id,
      { status: "rejected" },
    );
    return c.json(ok({ intent: updated }));
  })
  .post("/:id/execute", async (c) => {
    const projectId = c.req.param("projectId")!;
    const id = c.req.param("id")!;
    const user = c.get("user");

    const intent = await drizzle.copilotIntentRepo.getIntent(drizzle.db, id);
    if (!intent || intent.projectId !== projectId) {
      throw new HTTPException(404, { message: "Intent not found" });
    }
    if (intent.status !== "pending") {
      throw new HTTPException(409, {
        message: `Intent already ${intent.status}`,
      });
    }
    if (intent.expiresAt < new Date()) {
      await drizzle.copilotIntentRepo.transitionIntent(drizzle.db, id, {
        status: "expired",
      });
      throw new HTTPException(410, { message: "Intent expired" });
    }

    const membership = await assertProjectAccess(
      projectId,
      user.id,
      intent.requiresRole as MemberRole,
    );

    try {
      const result = await executeIntent({
        intent: {
          id: intent.id,
          toolName: intent.toolName,
          payload: intent.payload,
        },
        ctx: {
          projectId,
          userId: user.id,
          role: membership.role,
        },
      });
      const updated = await drizzle.copilotIntentRepo.transitionIntent(
        drizzle.db,
        id,
        {
          status: "executed",
          executedAt: new Date(),
          result,
        },
      );
      return c.json(ok({ intent: updated, result }));
    } catch (e) {
      await drizzle.copilotIntentRepo.transitionIntent(drizzle.db, id, {
        status: "failed",
        error: { message: (e as Error).message },
      });
      throw new HTTPException(500, {
        message: `Execution failed: ${(e as Error).message}`,
      });
    }
  });
