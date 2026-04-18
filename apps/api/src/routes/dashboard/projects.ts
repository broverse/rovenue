import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import prisma, { Environment, MemberRole } from "@rovenue/db";
import {
  API_KEY_KIND,
  API_KEY_PREFIX,
  type CreateProjectResponse,
  type ProjectApiKey,
  type ProjectDetail,
  type ProjectSummary,
} from "@rovenue/shared";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { ok } from "../../lib/response";

// =============================================================
// Dashboard: Projects
// =============================================================
//
// GET  /dashboard/projects       → list the caller's memberships
// GET  /dashboard/projects/:id   → project detail + counts + API keys
// POST /dashboard/projects       → atomic create + defaults (this task)
//
// PATCH / rotate / DELETE live in Task A5 so this file intentionally
// stays narrow for now.
//
// Create-project semantics: inside one `prisma.$transaction`
//   1. projects row
//   2. project_members row for the caller (OWNER)
//   3. default "All Users" audience (isDefault=true)
//   4. single Stripe-style api_keys row with a plaintext public id
//      and a bcrypt hash of the secret plaintext.
// The plaintext secret is returned exactly once in the response and
// is never persisted in any form other than the bcrypt hash.

const DEFAULT_AUDIENCE_NAME = "All Users";
const DEFAULT_AUDIENCE_DESCRIPTION = "Matches every subscriber";
const DEFAULT_API_KEY_LABEL = "default";
const BCRYPT_ROUNDS = 10;

function urlSafeRandom(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

/**
 * Pre-generate the ApiKey row id in JS so we can embed it inside the
 * secret plaintext and persist the matching bcrypt hash in a single
 * `apiKey.create` call. The auth middleware parses the id back out of
 * the token during Bearer auth, so the id inside the plaintext MUST
 * match the row id.
 */
function newApiKeyId(): string {
  return randomBytes(16).toString("hex");
}

const createProjectSchema = z.object({
  name: z.string().trim().min(2).max(80),
  slug: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .regex(/^[a-z0-9-]+$/, {
      message: "slug must be lowercase alphanumeric with dashes",
    }),
  environment: z
    .enum([Environment.PRODUCTION, Environment.SANDBOX])
    .default(Environment.PRODUCTION),
});

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

projectsRoute.post("/", async (c) => {
  const user = c.get("user");

  let body: z.infer<typeof createProjectSchema>;
  try {
    body = createProjectSchema.parse(await c.req.json());
  } catch (err) {
    throw new HTTPException(400, {
      message: err instanceof z.ZodError ? err.errors[0]?.message ?? "Invalid input" : "Invalid JSON body",
    });
  }

  // Mint the api-key material up front so both the row and the
  // plaintext we return can share the same id. See newApiKeyId().
  const apiKeyId = newApiKeyId();
  const keyPublic = `${API_KEY_PREFIX[API_KEY_KIND.PUBLIC]}${urlSafeRandom(24)}`;

  const { project, apiKey, secretKey } = await prisma.$transaction(async (tx) => {
    const createdProject = await tx.project.create({
      data: {
        name: body.name,
        slug: body.slug,
        settings: {},
      },
    });

    await tx.projectMember.create({
      data: {
        projectId: createdProject.id,
        userId: user.id,
        role: MemberRole.OWNER,
      },
    });

    await tx.audience.create({
      data: {
        projectId: createdProject.id,
        name: DEFAULT_AUDIENCE_NAME,
        description: DEFAULT_AUDIENCE_DESCRIPTION,
        rules: {},
        isDefault: true,
      },
    });

    // Secret token layout: `rov_sec_<apiKeyId>_<random>`. The auth
    // middleware (`apps/api/src/middleware/api-key-auth.ts`) parses
    // the id prefix for an indexed lookup before bcrypt compare, so
    // the id baked into the plaintext must match the stored row.
    const secretPlaintext = `${API_KEY_PREFIX[API_KEY_KIND.SECRET]}${apiKeyId}_${urlSafeRandom(32)}`;
    const keySecretHash = await bcrypt.hash(secretPlaintext, BCRYPT_ROUNDS);

    const createdApiKey = await tx.apiKey.create({
      data: {
        id: apiKeyId,
        projectId: createdProject.id,
        label: DEFAULT_API_KEY_LABEL,
        keyPublic,
        keySecretHash,
        environment: body.environment,
      },
    });

    return { project: createdProject, apiKey: createdApiKey, secretKey: secretPlaintext };
  });

  // Re-read aggregates the same way GET /:id does so the caller gets a
  // consistent ProjectDetail shape back (counts start at 0 for a fresh
  // project; the single new api key shows up in apiKeys).
  const [apiKeys, subscribers, experiments, featureFlags] = await Promise.all([
    prisma.apiKey.findMany({
      where: { projectId: project.id, revokedAt: null },
      orderBy: { createdAt: "asc" },
      select: {
        id: true,
        label: true,
        keyPublic: true,
        environment: true,
        createdAt: true,
      },
    }),
    prisma.subscriber.count({ where: { projectId: project.id, deletedAt: null } }),
    prisma.experiment.count({ where: { projectId: project.id } }),
    prisma.featureFlag.count({ where: { projectId: project.id } }),
  ]);

  const apiKeyPayload: ProjectApiKey[] = apiKeys.map((k) => ({
    id: k.id,
    label: k.label,
    publicKey: k.keyPublic,
    environment: k.environment,
    createdAt: k.createdAt.toISOString(),
  }));

  const detail: ProjectDetail = {
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

  const payload: CreateProjectResponse = {
    project: detail,
    apiKey: {
      publicKey: apiKey.keyPublic,
      secretKey,
    },
  };
  return c.json(ok(payload));
});
