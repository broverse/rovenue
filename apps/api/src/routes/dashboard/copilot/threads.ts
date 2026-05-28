import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { drizzle } from "@rovenue/db";
import { requireDashboardAuth } from "../../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../../lib/project-access";
import { ok } from "../../../lib/response";

const createBody = z.object({
  title: z.string().min(1).default("New chat"),
  provider: z.string().min(1),
  model: z.string().min(1),
});

export const copilotThreadsRoute = new Hono()
  .use("*", requireDashboardAuth)
  .post("/", zValidator("json", createBody), async (c) => {
    const projectId = c.req.param("projectId")!;
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id);
    const body = c.req.valid("json");
    const t = await drizzle.copilotThreadRepo.createThread(drizzle.db, {
      projectId,
      userId: user.id,
      title: body.title,
      provider: body.provider,
      model: body.model,
    });
    return c.json(ok({ thread: t }));
  })
  .get("/", async (c) => {
    const projectId = c.req.param("projectId")!;
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id);
    const threads = await drizzle.copilotThreadRepo.listThreadsForUser(
      drizzle.db,
      projectId,
      user.id,
    );
    return c.json(ok({ threads }));
  })
  .get("/:id", async (c) => {
    const projectId = c.req.param("projectId")!;
    const id = c.req.param("id")!;
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id);
    const thread = await drizzle.copilotThreadRepo.getThread(drizzle.db, id);
    if (!thread || thread.projectId !== projectId || thread.userId !== user.id) {
      throw new HTTPException(404, { message: "Thread not found" });
    }
    const messages = await drizzle.copilotMessageRepo.listMessages(
      drizzle.db,
      id,
    );
    return c.json(ok({ thread, messages }));
  })
  .delete("/:id", async (c) => {
    const projectId = c.req.param("projectId")!;
    const id = c.req.param("id")!;
    const user = c.get("user");
    await assertProjectAccess(projectId, user.id);
    const thread = await drizzle.copilotThreadRepo.getThread(drizzle.db, id);
    if (!thread || thread.projectId !== projectId || thread.userId !== user.id) {
      throw new HTTPException(404, { message: "Thread not found" });
    }
    await drizzle.copilotThreadRepo.archiveThread(drizzle.db, id);
    return c.json(ok({ archived: true }));
  });
