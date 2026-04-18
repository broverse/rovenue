import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import prisma, { MemberRole } from "@rovenue/db";
import type { ProjectApiKey, ProjectDetail, ProjectSummary } from "@rovenue/shared";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { ok } from "../../lib/response";

// =============================================================
// Dashboard: Projects (read-only handlers)
// =============================================================
//
// GET  /dashboard/projects       → list the caller's memberships
// GET  /dashboard/projects/:id   → project detail + counts + API keys
//
// Mutations (POST/PATCH/rotate/DELETE) live in sibling tasks so
// this file intentionally stays narrow.

export const projectsRoute = new Hono();
projectsRoute.use("*", requireDashboardAuth);

projectsRoute.get("/", async (c) => {
  const user = c.get("user");
  const memberships = await prisma.projectMember.findMany({
    where: { userId: user.id },
    include: { project: true },
    orderBy: { createdAt: "desc" },
  });
  const projects: ProjectSummary[] = memberships.map((m) => ({
    id: m.project.id,
    name: m.project.name,
    slug: m.project.slug,
    role: m.role,
    createdAt: m.project.createdAt.toISOString(),
  }));
  return c.json(ok({ projects }));
});

projectsRoute.get("/:id", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  await assertProjectAccess(id, user.id, MemberRole.VIEWER);

  const [project, apiKeys, subscribers, experiments, featureFlags] = await Promise.all([
    prisma.project.findUnique({ where: { id } }),
    prisma.apiKey.findMany({
      where: { projectId: id, revokedAt: null },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        label: true,
        keyPublic: true,
        environment: true,
        createdAt: true,
      },
    }),
    prisma.subscriber.count({ where: { projectId: id, deletedAt: null } }),
    prisma.experiment.count({ where: { projectId: id } }),
    prisma.featureFlag.count({ where: { projectId: id } }),
  ]);

  if (!project) throw new HTTPException(404, { message: "Project not found" });

  const apiKeyPayload: ProjectApiKey[] = apiKeys.map((k) => ({
    id: k.id,
    label: k.label,
    publicKey: k.keyPublic,
    environment: k.environment,
    createdAt: k.createdAt.toISOString(),
  }));

  const payload: ProjectDetail = {
    id: project.id,
    name: project.name,
    slug: project.slug,
    webhookUrl: project.webhookUrl,
    hasWebhookSecret: Boolean(project.webhookSecret),
    settings: (project.settings as Record<string, unknown> | null) ?? {},
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    counts: { subscribers, experiments, featureFlags, activeApiKeys: apiKeys.length },
    apiKeys: apiKeyPayload,
  };
  return c.json(ok({ project: payload }));
});
