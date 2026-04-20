import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import prisma, { Environment, MemberRole, Prisma } from "@rovenue/db";
import {
  API_KEY_KIND,
  API_KEY_PREFIX,
  type CreateProjectResponse,
  type ProjectApiKey,
  type ProjectDetail,
  type ProjectSummary,
  type RotateWebhookSecretResponse,
} from "@rovenue/shared";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { audit, extractRequestContext, redactCredentials } from "../../lib/audit";
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
 *
 * The secret-key plaintext layout is `rov_sec_<id>_<random>`; the auth
 * middleware at apps/api/src/middleware/api-key-auth.ts splits on the
 * first `_` after the prefix to recover <id>. The id MUST NOT contain
 * `_` — that's why this helper emits hex, not a cuid2. Changing the id
 * alphabet here without updating `parseSecretKeyId` there will silently
 * break secret-key auth.
 */
function newApiKeyId(): string {
  return randomBytes(16).toString("hex");
}

/**
 * Build the ProjectDetail wire payload from a Prisma project row plus
 * the already-loaded (or freshly-created) active ApiKey rows and counts.
 * Shared between GET /:id and POST / so the response shape stays in
 * lockstep; the POST handler passes zeroed counts for the freshly-created
 * project since nothing has had a chance to reference it yet.
 */
type ProjectRow = {
  id: string;
  name: string;
  slug: string;
  webhookUrl: string | null;
  webhookSecret: string | null;
  settings: unknown;
  createdAt: Date;
  updatedAt: Date;
};

type ApiKeyRow = {
  id: string;
  label: string;
  keyPublic: string;
  environment: "PRODUCTION" | "SANDBOX";
  createdAt: Date;
};

type ProjectDetailCounts = {
  subscribers: number;
  experiments: number;
  featureFlags: number;
};

// Project.settings is an open Json column used for product flags
// ("defaultEnvironment", "retries.maxAttempts", ...). To prevent
// anyone colocating a real secret in there and leaking it via GET
// /:id or POST /, we strip sensitive-looking keys from BOTH read
// and write paths. PATCH rejects the same keys upfront so the
// caller notices instead of silently losing them.
const SENSITIVE_SETTINGS_KEY_RE =
  /secret|password|token|private.*key|credential|apikey|api_key/i;

function sanitizeSettings(settings: unknown): Record<string, unknown> {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    return {};
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(settings as Record<string, unknown>)) {
    if (SENSITIVE_SETTINGS_KEY_RE.test(k)) continue;
    out[k] = v;
  }
  return out;
}

function assertSettingsSafe(settings: Record<string, unknown>): void {
  for (const k of Object.keys(settings)) {
    if (SENSITIVE_SETTINGS_KEY_RE.test(k)) {
      throw new HTTPException(400, {
        message: `settings key "${k}" looks sensitive — store secrets in appleCredentials / googleCredentials / stripeCredentials instead`,
      });
    }
  }
}

function toProjectDetail(
  project: ProjectRow,
  apiKeys: ApiKeyRow[],
  counts: ProjectDetailCounts,
): ProjectDetail {
  const apiKeyPayload: ProjectApiKey[] = apiKeys.map((k) => ({
    id: k.id,
    label: k.label,
    publicKey: k.keyPublic,
    environment: k.environment,
    createdAt: k.createdAt.toISOString(),
  }));
  return {
    id: project.id,
    name: project.name,
    slug: project.slug,
    webhookUrl: project.webhookUrl,
    hasWebhookSecret: Boolean(project.webhookSecret),
    settings: sanitizeSettings(project.settings),
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    counts: { ...counts, activeApiKeys: apiKeys.length },
    apiKeys: apiKeyPayload,
  };
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

const updateProjectSchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    webhookUrl: z.string().url().nullable().optional(),
    settings: z.record(z.unknown()).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field required",
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

  const payload = toProjectDetail(project, apiKeys, {
    subscribers,
    experiments,
    featureFlags,
  });
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

  // Rebuild the ProjectDetail payload in-memory from the transaction's
  // return values: a freshly-created project has zero subscribers /
  // experiments / feature flags and exactly one api key (the one we just
  // minted). Re-querying the database here would be wasted round-trips.
  const detail = toProjectDetail(project, [apiKey], {
    subscribers: 0,
    experiments: 0,
    featureFlags: 0,
  });

  const payload: CreateProjectResponse = {
    project: detail,
    apiKey: {
      publicKey: apiKey.keyPublic,
      secretKey,
    },
  };
  return c.json(ok(payload));
});

// PATCH /:id — partial update, ADMIN+. Reads the before-snapshot so the
// audit row captures both sides; only fields present in the body are
// forwarded to `update`.
projectsRoute.patch("/:id", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  await assertProjectAccess(id, user.id, MemberRole.ADMIN);

  // Check existence first so callers hitting a missing resource get a
  // crisp 404 regardless of whether their body would have been valid.
  const before = await prisma.project.findUnique({
    where: { id },
    select: { name: true, webhookUrl: true, settings: true },
  });
  if (!before) throw new HTTPException(404, { message: "Project not found" });

  let body: z.infer<typeof updateProjectSchema>;
  try {
    body = updateProjectSchema.parse(await c.req.json());
  } catch (err) {
    throw new HTTPException(400, {
      message:
        err instanceof z.ZodError ? err.errors[0]?.message ?? "Invalid input" : "Invalid JSON body",
    });
  }

  if (body.settings !== undefined) assertSettingsSafe(body.settings);

  // Atomic: a crash between update and audit would otherwise produce
  // a silent mutation. Running both in one $transaction means the
  // audit row is a guaranteed side-effect of the project change.
  const project = await prisma.$transaction(async (tx) => {
    const updated = await tx.project.update({
      where: { id },
      data: {
        ...(body.name !== undefined && { name: body.name }),
        ...(body.webhookUrl !== undefined && { webhookUrl: body.webhookUrl }),
        ...(body.settings !== undefined && {
          settings: body.settings as Prisma.InputJsonValue,
        }),
      },
    });
    await audit(
      {
        projectId: id,
        userId: user.id,
        action: "project.updated",
        resource: "project",
        resourceId: id,
        before: before as Record<string, unknown>,
        after: { ...before, ...body } as Record<string, unknown>,
        ...extractRequestContext(c),
      },
      tx,
    );
    return updated;
  });

  // Mirror GET /:id's response shape so the dashboard client can refresh
  // its cache from the PATCH response without a follow-up re-fetch.
  const [apiKeys, subscribers, experiments, featureFlags] = await Promise.all([
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

  const payload = toProjectDetail(project, apiKeys, {
    subscribers,
    experiments,
    featureFlags,
  });
  return c.json(ok({ project: payload }));
});

// POST /:id/webhook-secret/rotate — OWNER only. Mints a fresh plaintext
// `whsec_<base64url-32>` secret and returns it exactly once. The audit
// row MUST use redacted snapshots — audit() rejects credential entries
// whose before/after leak the raw secret.
projectsRoute.post("/:id/webhook-secret/rotate", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  await assertProjectAccess(id, user.id, MemberRole.OWNER);

  const webhookSecret = `whsec_${randomBytes(32).toString("base64url")}`;
  // Atomic update + audit. Without the transaction, a 5xx between the
  // two writes would leave the caller thinking rotation failed while
  // the new secret is already live and the old one is gone.
  await prisma.$transaction(async (tx) => {
    await tx.project.update({
      where: { id },
      data: { webhookSecret },
    });
    await audit(
      {
        projectId: id,
        userId: user.id,
        action: "credential.updated",
        resource: "credential",
        resourceId: id,
        before: redactCredentials({ webhookSecret: "*" }),
        after: redactCredentials({ webhookSecret: "*" }),
        ...extractRequestContext(c),
      },
      tx,
    );
  });

  const payload: RotateWebhookSecretResponse = { webhookSecret };
  return c.json(ok(payload));
});

// DELETE /:id — OWNER only. We intentionally write the audit row
// BEFORE the project row is deleted so the audit.projectId foreign key
// still resolves. Cascading delete on the project table would take the
// audit row with it if we ran these in the opposite order.
projectsRoute.delete("/:id", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  await assertProjectAccess(id, user.id, MemberRole.OWNER);

  // Atomic. Note the ordering constraint: audit FIRST so the fk
  // (audit.projectId → project.id) resolves before cascade delete
  // takes the project row out.
  await prisma.$transaction(async (tx) => {
    await audit(
      {
        projectId: id,
        userId: user.id,
        action: "project.deleted",
        resource: "project",
        resourceId: id,
        ...extractRequestContext(c),
      },
      tx,
    );
    await tx.project.delete({ where: { id } });
  });

  return c.json(ok({ id }));
});
