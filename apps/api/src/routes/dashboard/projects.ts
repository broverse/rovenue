import { randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { Environment, MemberRole, drizzle } from "@rovenue/db";
import {
  API_KEY_KIND,
  API_KEY_PREFIX,
  WEBHOOK_EVENT_CATEGORIES,
  type CreateApiKeyResponse,
  type CreateProjectResponse,
  type ProjectApiKey,
  type ProjectDetail,
  type ProjectSummary,
  type RotateWebhookSecretResponse,
  type WebhookEventCategory,
} from "@rovenue/shared";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { audit, extractRequestContext, redactCredentials } from "../../lib/audit";
import { ok } from "../../lib/response";
import { createFreeSubscription } from "../../services/billing/create-free-subscription";

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
// Create-project semantics: inside one `drizzle.db.transaction`
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
 * Build the ProjectDetail wire payload from a project row plus
 * the already-loaded (or freshly-created) active ApiKey rows and counts.
 * Shared between GET /:id and POST / so the response shape stays in
 * lockstep; the POST handler passes zeroed counts for the freshly-created
 * project since nothing has had a chance to reference it yet.
 */
type ProjectRow = {
  id: string;
  name: string;
  description: string | null;
  webhookUrl: string | null;
  webhookSecret: string | null;
  webhookEventCategories: unknown;
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
    description: project.description,
    webhookUrl: project.webhookUrl,
    hasWebhookSecret: Boolean(project.webhookSecret),
    webhookEventCategories: Array.isArray(project.webhookEventCategories)
      ? (project.webhookEventCategories as WebhookEventCategory[])
      : [],
    settings: sanitizeSettings(project.settings),
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString(),
    counts: { ...counts, activeApiKeys: apiKeys.length },
    apiKeys: apiKeyPayload,
  };
}

const reportingSettingsSchema = z
  .object({
    reportingCurrency: z.string().trim().length(3).optional(),
    fxSource: z.literal("ecb").optional(),
    timezone: z.string().trim().min(1).optional(),
    weekStart: z.enum(["monday", "sunday", "saturday"]).optional(),
    fiscalMonth: z
      .enum([
        "jan",
        "feb",
        "mar",
        "apr",
        "may",
        "jun",
        "jul",
        "aug",
        "sep",
        "oct",
        "nov",
        "dec",
      ])
      .optional(),
  })
  .strict();

// Description trims to "" but the column stores NULL. The dashboard
// description field is optional, multi-line, and capped at 400 chars
// (matches the wizard's basics step counter at projects.basics.descriptionHint).
const descriptionSchema = z
  .string()
  .max(400)
  .nullable()
  .transform((v) => {
    if (v === null) return null;
    const trimmed = v.trim();
    return trimmed.length === 0 ? null : trimmed;
  });

export const createProjectBodySchema = z.object({
  name: z.string().trim().min(2).max(80),
  description: descriptionSchema.optional(),
  reporting: reportingSettingsSchema.optional(),
});

export const updateProjectBodySchema = z
  .object({
    name: z.string().trim().min(2).max(80).optional(),
    description: descriptionSchema.optional(),
    webhookUrl: z.string().url().nullable().optional(),
    webhookEventCategories: z.array(z.enum(WEBHOOK_EVENT_CATEGORIES)).optional(),
    settings: z.record(z.unknown()).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, {
    message: "At least one field required",
  });

const createApiKeyBodySchema = z.object({
  label: z.string().trim().min(1).max(60),
});

export const projectsRoute = new Hono()
  .use("*", requireDashboardAuth)
  .get("/", async (c) => {
  const user = c.get("user");
  const memberships = await drizzle.projectRepo.findMembershipsForUser(
    drizzle.db,
    user.id,
  );
  const projects: ProjectSummary[] = memberships.map((m) => ({
    id: m.project.id,
    name: m.project.name,
    role: m.role,
    createdAt: m.project.createdAt.toISOString(),
  }));
    return c.json(ok({ projects }));
  })
  .get("/:id", async (c) => {
  const id = c.req.param("id");
  const user = c.get("user");
  await assertProjectAccess(id, user.id, MemberRole.CUSTOMER_SUPPORT);

  const [project, apiKeys, subscribers, experiments, featureFlags] = await Promise.all([
    drizzle.projectRepo.findProjectById(drizzle.db, id),
    drizzle.apiKeyRepo.listActiveApiKeys(drizzle.db, id),
    drizzle.subscriberRepo.countActiveSubscribers(drizzle.db, id),
    drizzle.experimentRepo.countExperiments(drizzle.db, id),
    drizzle.dashboardFeatureFlagRepo.countFeatureFlags(drizzle.db, id),
  ]);

  if (!project) throw new HTTPException(404, { message: "Project not found" });

  const payload = toProjectDetail(project, apiKeys, {
    subscribers,
    experiments,
    featureFlags,
  });
    return c.json(ok({ project: payload }));
  })
  .post("/", zValidator("json", createProjectBodySchema), async (c) => {
    const user = c.get("user");
    const body = c.req.valid("json");

    // Mint the api-key material up front so both the row and the
  // plaintext we return can share the same id. See newApiKeyId().
  const apiKeyId = newApiKeyId();
  const keyPublic = `${API_KEY_PREFIX[API_KEY_KIND.PUBLIC]}${urlSafeRandom(24)}`;

  const { project, apiKey, secretKey } = await drizzle.db.transaction(async (tx) => {
    // Reporting defaults captured by the dashboard wizard land in
    // `projects.settings`; the schema stays opaque so future fields
    // can ride along without a migration.
    const settings = body.reporting ? { reporting: body.reporting } : {};
    const createdProject = await drizzle.projectRepo.createProject(tx, {
      name: body.name,
      description: body.description ?? null,
      settings,
    });

    await drizzle.projectRepo.createProjectMember(tx, {
      projectId: createdProject.id,
      userId: user.id,
      role: MemberRole.OWNER,
    });

    await createFreeSubscription(tx, createdProject.id);

    await drizzle.audienceRepo.createAudience(tx, {
      projectId: createdProject.id,
      name: DEFAULT_AUDIENCE_NAME,
      description: DEFAULT_AUDIENCE_DESCRIPTION,
      rules: {},
      isDefault: true,
    });

    // Secret token layout: `rov_sec_<apiKeyId>_<random>`. The auth
    // middleware (`apps/api/src/middleware/api-key-auth.ts`) parses
    // the id prefix for an indexed lookup before bcrypt compare, so
    // the id baked into the plaintext must match the stored row.
    const secretPlaintext = `${API_KEY_PREFIX[API_KEY_KIND.SECRET]}${apiKeyId}_${urlSafeRandom(32)}`;
    const keySecretHash = await bcrypt.hash(secretPlaintext, BCRYPT_ROUNDS);

    const createdApiKey = await drizzle.apiKeyRepo.createApiKey(tx, {
      id: apiKeyId,
      projectId: createdProject.id,
      label: DEFAULT_API_KEY_LABEL,
      keyPublic,
      keySecretHash,
      environment: Environment.PRODUCTION,
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
  })
  // PATCH /:id — partial update, ADMIN+. Reads the before-snapshot so
  // the audit row captures both sides; only fields present in the body
  // are forwarded to `update`.
  .patch("/:id", zValidator("json", updateProjectBodySchema), async (c) => {
    const id = c.req.param("id");
    const user = c.get("user");
    await assertProjectAccess(id, user.id, MemberRole.ADMIN);

    // Check existence first so callers hitting a missing resource get a
    // crisp 404 regardless of whether their body would have been valid.
    const before = await drizzle.projectRepo.findProjectById(drizzle.db, id);
    if (!before) throw new HTTPException(404, { message: "Project not found" });

    const body = c.req.valid("json");

    if (body.settings !== undefined) assertSettingsSafe(body.settings);

    // A webhook URL must not be configured without a signing secret —
    // otherwise outgoing webhooks are delivered unsigned and a receiver can't
    // distinguish a legitimate payload from a forged one. The secret is set
    // via the rotate-secret endpoint; require it first.
    if (
      body.webhookUrl != null &&
      body.webhookUrl.length > 0 &&
      !before.webhookSecret
    ) {
      throw new HTTPException(400, {
        message:
          "Configure a webhook signing secret (rotate the secret) before setting a webhook URL",
      });
    }

  // Atomic: a crash between update and audit would otherwise produce
  // a silent mutation. Running both in one $transaction means the
  // audit row is a guaranteed side-effect of the project change.
  const project = await drizzle.db.transaction(async (tx) => {
    const updated = await drizzle.projectRepo.updateProject(tx, id, {
      ...(body.name !== undefined && { name: body.name }),
      ...(body.description !== undefined && { description: body.description }),
      ...(body.webhookUrl !== undefined && { webhookUrl: body.webhookUrl }),
      ...(body.webhookEventCategories !== undefined && {
        webhookEventCategories: body.webhookEventCategories,
      }),
      ...(body.settings !== undefined && { settings: body.settings }),
    });
    if (!updated) {
      throw new HTTPException(404, { message: "Project not found" });
    }
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
    drizzle.apiKeyRepo.listActiveApiKeys(drizzle.db, id),
    drizzle.subscriberRepo.countActiveSubscribers(drizzle.db, id),
    drizzle.experimentRepo.countExperiments(drizzle.db, id),
    drizzle.dashboardFeatureFlagRepo.countFeatureFlags(drizzle.db, id),
  ]);

  const payload = toProjectDetail(project, apiKeys, {
    subscribers,
    experiments,
    featureFlags,
  });
    return c.json(ok({ project: payload }));
  })
  // POST /:id/webhook-secret/rotate — OWNER only. Mints a fresh
  // plaintext `whsec_<base64url-32>` secret and returns it exactly
  // once. The audit row MUST use redacted snapshots — audit() rejects
  // credential entries whose before/after leak the raw secret.
  .post("/:id/webhook-secret/rotate", async (c) => {
    const id = c.req.param("id");
    const user = c.get("user");
    await assertProjectAccess(id, user.id, MemberRole.OWNER);

    const webhookSecret = `whsec_${randomBytes(32).toString("base64url")}`;
    // Atomic update + audit. Without the transaction, a 5xx between
    // the two writes would leave the caller thinking rotation failed
    // while the new secret is already live and the old one is gone.
    await drizzle.db.transaction(async (tx) => {
      await drizzle.projectRepo.updateProjectWebhookSecret(tx, id, webhookSecret);
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
  })
  // POST /:id/api-keys — ADMIN+. Mints a Production publishable+secret
  // pair (same material layout as project-create) and returns the
  // secret plaintext exactly once. The audit payload carries only the
  // publishable id — never the secret.
  .post("/:id/api-keys", zValidator("json", createApiKeyBodySchema), async (c) => {
    const id = c.req.param("id");
    const user = c.get("user");
    await assertProjectAccess(id, user.id, MemberRole.ADMIN);
    const { label } = c.req.valid("json");

    const apiKeyId = newApiKeyId();
    const keyPublic = `${API_KEY_PREFIX[API_KEY_KIND.PUBLIC]}${urlSafeRandom(24)}`;

    const { apiKey, secretKey } = await drizzle.db.transaction(async (tx) => {
      const secretPlaintext = `${API_KEY_PREFIX[API_KEY_KIND.SECRET]}${apiKeyId}_${urlSafeRandom(32)}`;
      const keySecretHash = await bcrypt.hash(secretPlaintext, BCRYPT_ROUNDS);

      const createdApiKey = await drizzle.apiKeyRepo.createApiKey(tx, {
        id: apiKeyId,
        projectId: id,
        label,
        keyPublic,
        keySecretHash,
        environment: Environment.PRODUCTION,
      });

      await audit(
        {
          projectId: id,
          userId: user.id,
          action: "api_key.created",
          resource: "api_key",
          resourceId: apiKeyId,
          after: {
            id: apiKeyId,
            label,
            publicKey: keyPublic,
            environment: Environment.PRODUCTION,
          },
          ...extractRequestContext(c),
        },
        tx,
      );

      return { apiKey: createdApiKey, secretKey: secretPlaintext };
    });

    const payload: CreateApiKeyResponse = {
      apiKey: {
        id: apiKey.id,
        label: apiKey.label,
        publicKey: apiKey.keyPublic,
        environment: apiKey.environment,
        createdAt: apiKey.createdAt.toISOString(),
      },
      secretKey,
    };
    return c.json(ok(payload));
  })
  // DELETE /:id/api-keys/:keyId — ADMIN+. Revokes a single key
  // (sets revokedAt). Scoped to the project in the repo so a foreign
  // key id 404s. 404 when nothing active matched.
  .delete("/:id/api-keys/:keyId", async (c) => {
    const id = c.req.param("id");
    const keyId = c.req.param("keyId");
    const user = c.get("user");
    await assertProjectAccess(id, user.id, MemberRole.ADMIN);

    await drizzle.db.transaction(async (tx) => {
      const revoked = await drizzle.apiKeyRepo.revokeApiKey(tx, id, keyId);
      if (!revoked) {
        throw new HTTPException(404, { message: "API key not found" });
      }
      await audit(
        {
          projectId: id,
          userId: user.id,
          action: "api_key.revoked",
          resource: "api_key",
          resourceId: keyId,
          before: {
            id: revoked.id,
            label: revoked.label,
            publicKey: revoked.keyPublic,
          },
          ...extractRequestContext(c),
        },
        tx,
      );
    });

    return c.json(ok({ id: keyId }));
  })
  // DELETE /:id — OWNER only. The audit row records who deleted the
  // project; it survives the delete because the FK is ON DELETE SET
  // NULL (audit_logs.projectId becomes null after the cascade, but
  // resourceId still holds the original project id).
  .delete("/:id", async (c) => {
    const id = c.req.param("id");
    const user = c.get("user");
    await assertProjectAccess(id, user.id, MemberRole.OWNER);

    await drizzle.db.transaction(async (tx) => {
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
      await drizzle.projectRepo.deleteProject(tx, id);
    });

    return c.json(ok({ id }));
  });
