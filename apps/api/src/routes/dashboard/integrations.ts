import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { createId } from "@paralleldrive/cuid2";
import { MemberRole, drizzle, getDb } from "@rovenue/db";
import { encrypt, decrypt } from "@rovenue/shared/crypto";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { endpointRateLimit, clientIp } from "../../middleware/rate-limit";
import { assertProjectAccess } from "../../lib/project-access";
import { ok } from "../../lib/response";
import { audit } from "../../lib/audit";
import { env } from "../../lib/env";
import { attachRedisErrorLogger } from "../../lib/redis";
import { getProvider, providerIds } from "../../services/integrations/registry";
import {
  createUndiciHttpClient,
  RESPONSE_BODY_MAX_BYTES,
} from "../../services/integrations/http-client";
import {
  handleConnectionEnableTransition,
} from "../../services/integrations/connection-events";
import {
  newestSecretEntry,
  parseWebhookCredentials,
  type WebhookSecretEntry,
} from "../../services/integrations/providers/custom-webhook";
import { generateWebhookSecret } from "../../lib/svix-sign";
import { assertPublicWebhookUrl, WebhookUrlError } from "../../lib/ssrf-guard";
import { isUniqueViolationOf } from "../../lib/pg-errors";
import {
  enqueueBackfillForConnection,
  outboxRowToEnvelope,
  type BackfillAuditInput,
  type OutboxRow,
} from "../../services/integrations/backfill";
import {
  INTEGRATIONS_DELIVER_QUEUE_NAME,
  buildRedeliverJobId,
  deliverJobOptions,
  type IntegrationsDeliverJob,
} from "../../queues/integrations";
import type { ProviderId, ProviderPayload } from "../../services/integrations/types";
import type { AuditTx } from "../../lib/audit";
import type { NewIntegrationConnection } from "@rovenue/db/src/drizzle/schema";

// =============================================================
// Rollout ordering — first deploy of integrations framework
// =============================================================
//
// 1. Apply migration 0053_integrations_framework.sql against the production
//    database (pnpm db:migrate). pg_partman must be installed and the
//    create_parent call inside the migration must succeed.
// 2. Deploy the API binary. On boot, `startIntegrationsFanout()` joins the
//    `rovenue-integrations-fanout` consumer group on rovenue.revenue +
//    rovenue.billing and `ensureIntegrationsDeliverWorker()` starts.
// 3. The dashboard route mounted below is reachable immediately, but until
//    an operator creates a connection there are no consumers of the worker.
//
// No feature flag gates these routes — the only "off" state is "no
// connection exists" or `is_enabled=false`. If we later want a hard kill
// switch, add `INTEGRATIONS_FRAMEWORK_DISABLED=true` env check at the top
// of this router.
// =============================================================

// =============================================================
// Dashboard: Integration connections
// =============================================================
//
// GET    /                          — list connections (credentials redacted)
// POST   /                          — create connection (validate first)
// POST   /validate                  — dry-run credential validation
// PATCH  /:id                       — update connection (scope/enabled/rotation)
// DELETE /:id                       — soft-delete connection
// POST   /:id/test-event            — synthetic test event
// GET    /:id/deliveries            — cursor-paginated delivery log
// POST   /:id/deliveries/:deliveryId/redeliver — manual redeliver

// =============================================================
// Helpers
// =============================================================

/**
 * Builds a short credential hint from raw creds object.
 * Format: "Pixel <first4>…<last4>"
 */
function buildCredentialsHint(
  _providerId: string,
  creds: Record<string, string>,
): string {
  const token = creds["access_token"] ?? creds[Object.keys(creds)[0] ?? ""] ?? "";
  if (token.length >= 8) {
    const first4 = token.slice(0, 4);
    const last4 = token.slice(-4);
    return `Pixel ${first4}…${last4}`;
  }
  return "Pixel ****";
}

function getEncryptionKey(): string {
  if (!env.ENCRYPTION_KEY) {
    throw new HTTPException(500, { message: "ENCRYPTION_KEY not configured" });
  }
  return env.ENCRYPTION_KEY;
}

// =============================================================
// Webhook (CUSTOM_WEBHOOK) constants
// =============================================================
//
// CUSTOM_WEBHOOK is the one provider with `allowMultipleConnections: true`
// (migration 0104's partial unique index exempts it) — a project can add
// several endpoints, so a project-wide cap replaces the DB-enforced
// one-per-provider uniqueness that every other provider still gets for
// free from the index.
export const MAX_WEBHOOK_ENDPOINTS_PER_PROJECT = 10;

// How long a rotated-out secret keeps signing. Measured from the ROTATION
// (stamped onto the outgoing entry as `expiresAt`), never from when the key
// was created — otherwise rotating a key older than this window would
// invalidate it the instant the operator clicked the button, dead-lettering
// every delivery to a receiver that hadn't picked up the new key yet.
export const WEBHOOK_SECRET_GRACE_MS = 24 * 60 * 60 * 1000;

// The unique index from migration 0104 — matched by name (not by code
// alone) so a 23505 raised by some other constraint on this table doesn't
// get misreported as "connection already exists".
const PROJECT_PROVIDER_UNIQUE_INDEX = "integration_connections_project_provider_uidx";

// Namespaces the advisory-lock key space so a project id can never collide
// with a lock key some other subsystem derives from the same string (e.g.
// assets/quota.ts locks storage reservations by project id too).
const WEBHOOK_ENDPOINT_CAP_LOCK_PREFIX = "webhook-endpoint-cap:";

// Client input for CUSTOM_WEBHOOK create — deliberately NOT the provider's
// stored-credentials schema ({ url, secrets }): the server generates the
// secret, so a client-supplied "secrets" field is rejected outright rather
// than silently ignored.
const webhookCreateCredentialsBody = z.object({ url: z.string().min(1) }).strict();

// Same reasoning for PATCH: the stored `secrets` array is server-owned and
// only POST /:id/rotate-secret may change it, so a webhook connection's
// patchable credentials are exactly `{ url }` — anything else is rejected,
// not merged.
const webhookPatchCredentialsBody = z.object({ url: z.string().min(1) }).strict();

// =============================================================
// Zod schemas
// =============================================================

const createConnectionBody = z.object({
  providerId: z.enum(providerIds()),
  displayName: z.string().min(1).max(255),
  credentials: z.record(z.string()),
  enabledEvents: z.array(z.string()).optional(),
  eventMapping: z
    .record(
      z.object({
        eventName: z.string().optional(),
        skip: z.literal(true).optional(),
      }),
    )
    .optional(),
  actionSource: z.enum(["app", "website", "system_generated"]).optional(),
  testEventCode: z.string().optional(),
});

const patchConnectionBody = z.object({
  displayName: z.string().min(1).max(255).optional(),
  credentials: z.record(z.string()).optional(),
  enabledEvents: z.array(z.string()).optional(),
  eventMapping: z
    .record(
      z.object({
        eventName: z.string().optional(),
        skip: z.literal(true).optional(),
      }),
    )
    .optional(),
  actionSource: z.enum(["app", "website", "system_generated"]).optional(),
  testEventCode: z.string().optional(),
  isEnabled: z.boolean().optional(),
});

const validateBody = z.object({
  providerId: z.enum(providerIds()),
  credentials: z.record(z.string()),
});

const deliveriesQuery = z.object({
  cursor: z.string().optional(),
  status: z
    .enum(["pending", "succeeded", "failed", "skipped", "dead_letter"])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// Re-usable projection for list/read (excludes credentialsCipher).
// Evaluated lazily at call time so tests that mock @rovenue/db without
// a full schema object can still import this module without crashing.
function connectionSelect() {
  const t = drizzle.schema.integrationConnections;
  return {
    id: t.id,
    projectId: t.projectId,
    providerId: t.providerId,
    displayName: t.displayName,
    credentialsHint: t.credentialsHint,
    enabledEvents: t.enabledEvents,
    eventMapping: t.eventMapping,
    actionSource: t.actionSource,
    testEventCode: t.testEventCode,
    isEnabled: t.isEnabled,
    lastValidatedAt: t.lastValidatedAt,
    lastError: t.lastError,
    lastBackfillAt: t.lastBackfillAt,
    createdAt: t.createdAt,
    updatedAt: t.updatedAt,
  };
}

// =============================================================
// Webhook (CUSTOM_WEBHOOK) create — multi-connection branch
// =============================================================
//
// CUSTOM_WEBHOOK is exempt from the DB-enforced one-per-provider unique
// index (migration 0104), so uniqueness isn't the concern here — an
// unbounded endpoint count is.
//
// A bare `SELECT ... FOR UPDATE` precheck does NOT close the race: under
// READ COMMITTED it only blocks on rows that already exist, so at zero
// (or few) pre-existing rows there's nothing to lock, and a transaction
// that blocked on an existing row never re-scans for a sibling
// transaction's newly-inserted row (the classic phantom-read gap). N
// concurrent creates near the cap can overrun it by up to N-1. The fix is
// a per-project `pg_advisory_xact_lock`, taken BEFORE the count check —
// the same pattern `reserveStorage` in services/assets/quota.ts uses for
// the storage cap: the second transaction's count is only taken after the
// first has committed (or rolled back) and released the lock, so the
// count it sees already reflects the first transaction's insert.
//
// Unlike the generic path, this does NOT call `provider.validateCredentials`
// — that function requires a non-empty `secrets` array, which doesn't exist
// yet for a brand-new connection (the server is about to generate it). URL
// validity is checked directly via `assertPublicWebhookUrl`, the same sync,
// offline check `validateCredentials` would have delegated to anyway.
async function createWebhookConnection(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: Context<any>,
  projectId: string,
  user: { id: string },
  body: z.infer<typeof createConnectionBody>,
) {
  const provider = getProvider(body.providerId as ProviderId);

  const credsParse = webhookCreateCredentialsBody.safeParse(body.credentials);
  if (!credsParse.success) {
    return c.json(
      { error: { code: "VALIDATION_ERROR", message: credsParse.error.message } },
      400,
    );
  }
  const { url } = credsParse.data;

  try {
    assertPublicWebhookUrl(url);
  } catch (err) {
    if (err instanceof WebhookUrlError) {
      return c.json({ error: { code: "invalid_credentials", message: err.reason } }, 400);
    }
    throw err;
  }

  const encKey = getEncryptionKey();
  const id = createId();
  const now = new Date();
  const secretEntry: WebhookSecretEntry = {
    id: createId(),
    key: generateWebhookSecret(),
    createdAt: now.toISOString(),
  };
  const credsObj = { url, secrets: JSON.stringify([secretEntry]) };
  const credentialsCipher = encrypt(JSON.stringify(credsObj), encKey);
  const credentialsHint = provider.buildCredentialsHint
    ? provider.buildCredentialsHint(credsObj)
    : buildCredentialsHint(body.providerId, credsObj);

  const { integrationConnections } = drizzle.schema;

  let capReached = false;
  await drizzle.db.transaction(async (tx) => {
    // Serializes the count-then-insert below across concurrent creates
    // for this project. Must come BEFORE the count query — see the
    // block comment above this function for why FOR UPDATE alone can't
    // do this job.
    await drizzle.lockRepo.advisoryXactLock(
      tx,
      `${WEBHOOK_ENDPOINT_CAP_LOCK_PREFIX}${projectId}`,
    );

    const existing = await tx
      .select({ id: integrationConnections.id })
      .from(integrationConnections)
      .where(
        and(
          eq(integrationConnections.projectId, projectId),
          eq(integrationConnections.providerId, "CUSTOM_WEBHOOK"),
          isNull(integrationConnections.deletedAt),
        ),
      );

    if (existing.length >= MAX_WEBHOOK_ENDPOINTS_PER_PROJECT) {
      capReached = true;
      return;
    }

    const values: NewIntegrationConnection = {
      id,
      projectId,
      providerId: body.providerId as ProviderId,
      displayName: body.displayName,
      credentialsCipher,
      credentialsHint,
      enabledEvents: (body.enabledEvents ?? []) as string[],
      eventMapping: body.eventMapping ?? {},
      actionSource: body.actionSource ?? "app",
      testEventCode: body.testEventCode ?? null,
      isEnabled: false,
      lastValidatedAt: now,
      createdAt: now,
      updatedAt: now,
    };
    await tx.insert(integrationConnections).values(values);

    await audit(
      {
        projectId,
        userId: user.id,
        action: "integration.connection.created",
        resource: "integration_connection",
        resourceId: id,
        after: {
          providerId: body.providerId,
          displayName: body.displayName,
          credentialsHint,
          enabledEvents: body.enabledEvents ?? [],
          actionSource: body.actionSource ?? "app",
          testEventCode: body.testEventCode ?? null,
        },
      },
      tx as unknown as AuditTx,
    );
  });

  if (capReached) {
    return c.json(
      {
        error: {
          code: "endpoint_limit_reached",
          message: `A project may have at most ${MAX_WEBHOOK_ENDPOINTS_PER_PROJECT} webhook endpoints`,
        },
      },
      409,
    );
  }

  const [row] = await drizzle.db
    .select(connectionSelect())
    .from(integrationConnections)
    .where(eq(integrationConnections.id, id));

  return c.json(ok({ connection: row, secret: secretEntry.key }), 201);
}

// =============================================================
// Route
// =============================================================

export const integrationsRoute = new Hono()
  .use("*", requireDashboardAuth)

  // =============================================================
  // GET /dashboard/projects/:projectId/integrations
  // =============================================================
  .get("/", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) {
      throw new HTTPException(400, { message: "Missing projectId" });
    }

    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const rows = await drizzle.db
      .select(connectionSelect())
      .from(drizzle.schema.integrationConnections)
      .where(
        and(
          eq(drizzle.schema.integrationConnections.projectId, projectId),
          isNull(drizzle.schema.integrationConnections.deletedAt),
        ),
      );

    return c.json(ok({ connections: rows }));
  })

  // =============================================================
  // POST /dashboard/projects/:projectId/integrations
  // M5.3 — validate credentials BEFORE any DB write
  // =============================================================
  .post("/", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) throw new HTTPException(400, { message: "Missing projectId" });

    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.ADMIN);

    const raw = await c.req.json();
    const parse = createConnectionBody.safeParse(raw);
    if (!parse.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: parse.error.message } },
        400,
      );
    }
    const body = parse.data;

    // CUSTOM_WEBHOOK (and any future allowMultipleConnections provider)
    // branches entirely: server-generated secret, endpoint cap instead of
    // DB uniqueness, no generic validateCredentials network path.
    const provider = getProvider(body.providerId as ProviderId);
    if (provider.allowMultipleConnections) {
      return createWebhookConnection(c, projectId, user, body);
    }

    // Validate credentials BEFORE any DB write
    const credsParse = provider.credentialsSchema.safeParse(body.credentials);
    if (!credsParse.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: credsParse.error.message } },
        400,
      );
    }

    const http = createUndiciHttpClient();
    const validation = await provider.validateCredentials(body.credentials, http);
    if (!validation.ok) {
      return c.json(
        {
          error: {
            code: "invalid_credentials",
            message: (validation as { ok: false; reason: string }).reason,
          },
        },
        400,
      );
    }

    const encKey = getEncryptionKey();
    const credentialsCipher = encrypt(JSON.stringify(body.credentials), encKey);
    const credentialsHint = buildCredentialsHint(body.providerId, body.credentials);
    const id = createId();
    const now = new Date();

    try {
      await drizzle.db.transaction(async (tx) => {
        const values: NewIntegrationConnection = {
          id,
          projectId,
          providerId: body.providerId as ProviderId,
          displayName: body.displayName,
          credentialsCipher,
          credentialsHint,
          enabledEvents: (body.enabledEvents ?? []) as string[],
          eventMapping: body.eventMapping ?? {},
          actionSource: body.actionSource ?? "app",
          testEventCode: body.testEventCode ?? null,
          isEnabled: false,
          lastValidatedAt: now,
          createdAt: now,
          updatedAt: now,
        };
        await tx
          .insert(drizzle.schema.integrationConnections)
          .values(values);

        await audit(
          {
            projectId,
            userId: user.id,
            action: "integration.connection.created",
            resource: "integration_connection",
            resourceId: id,
            after: {
              providerId: body.providerId,
              displayName: body.displayName,
              credentialsHint,
              enabledEvents: body.enabledEvents ?? [],
              actionSource: body.actionSource ?? "app",
              testEventCode: body.testEventCode ?? null,
            },
          },
          tx as unknown as AuditTx,
        );
      });
    } catch (err) {
      // A concurrent create beat us to the punch on the partial unique
      // index (migration 0104) — every non-webhook provider allows at
      // most one connection per project. Drizzle wraps the driver error
      // (see lib/pg-errors), so this must be matched by constraint name,
      // not a bare top-level `.code` read.
      if (isUniqueViolationOf(err, PROJECT_PROVIDER_UNIQUE_INDEX)) {
        return c.json(
          {
            error: {
              code: "connection_exists",
              message: "a connection for this provider already exists",
            },
          },
          409,
        );
      }
      throw err;
    }

    const [row] = await drizzle.db
      .select(connectionSelect())
      .from(drizzle.schema.integrationConnections)
      .where(eq(drizzle.schema.integrationConnections.id, id));

    return c.json(ok({ connection: row }), 201);
  })

  // =============================================================
  // POST /dashboard/projects/:projectId/integrations/validate
  // M5.6 — dry-run credential validation, no DB write
  // NOTE: Must be registered BEFORE /:id routes to avoid id="validate" clash
  // =============================================================
  .post(
    "/validate",
    // This endpoint makes an outbound third-party credential-validation call
    // on every request. Cap it per authenticated dashboard user so an
    // authenticated (or compromised) developer can't drive unbounded
    // egress/cost. Runs before the access check so abusive traffic is shed early.
    endpointRateLimit({
      name: "integrations-validate",
      max: 20,
      identify: (c) => c.get("user")?.id ?? clientIp(c),
    }),
    async (c) => {
      const projectId = c.req.param("projectId");
      if (!projectId)
        throw new HTTPException(400, { message: "Missing projectId" });

      const user = c.get("user");
      await assertProjectAccess(projectId, user.id, MemberRole.DEVELOPER);

      const raw = await c.req.json();
      const parse = validateBody.safeParse(raw);
      if (!parse.success) {
        return c.json(
          { error: { code: "VALIDATION_ERROR", message: parse.error.message } },
          400,
        );
      }
      const body = parse.data;

      const http = createUndiciHttpClient();
      const provider = getProvider(body.providerId as ProviderId);
      const result = await provider.validateCredentials(body.credentials, http);

      if (result.ok) {
        return c.json(ok({ ok: true }));
      }
      // Failure goes in body with 200 status — NOT 400 (per plan §M5.6)
      return c.json(
        ok({
          ok: false,
          reason: (result as { ok: false; reason: string }).reason,
        }),
      );
    },
  )

  // =============================================================
  // POST /dashboard/projects/:projectId/integrations/:id/rotate-secret
  // Webhook secret rotation — registered BEFORE /:id (same reasoning as
  // /validate above: a literal path segment after :id doesn't collide
  // with the bare PATCH/DELETE /:id routes, but keeping every named
  // sub-route grouped ahead of them avoids re-litigating the ordering
  // question later).
  // =============================================================
  .post("/:id/rotate-secret", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing path parameters" });
    }

    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.ADMIN);

    const db = getDb();
    const [existing] = await db
      .select()
      .from(drizzle.schema.integrationConnections)
      .where(
        and(
          eq(drizzle.schema.integrationConnections.id, id),
          eq(drizzle.schema.integrationConnections.projectId, projectId),
          isNull(drizzle.schema.integrationConnections.deletedAt),
        ),
      );
    if (!existing) {
      throw new HTTPException(404, { message: "Integration connection not found" });
    }
    if (existing.providerId !== "CUSTOM_WEBHOOK") {
      return c.json(
        {
          error: {
            code: "not_a_webhook_connection",
            message: "secret rotation only applies to CUSTOM_WEBHOOK connections",
          },
        },
        400,
      );
    }

    const encKey = getEncryptionKey();
    const existingCreds = JSON.parse(
      decrypt(existing.credentialsCipher, encKey),
    ) as Record<string, string>;
    const { url, secrets } = parseWebhookCredentials(existingCreds);

    const now = new Date();
    const newEntry: WebhookSecretEntry = {
      id: createId(),
      key: generateWebhookSecret(),
      createdAt: now.toISOString(),
    };

    // Grace is measured from THIS rotation, not from when each key was
    // created: stamp the outgoing (previously newest) entry with an
    // `expiresAt` one grace window out, and prune anything whose stamp has
    // already passed. Measuring from creation instantly invalidated any
    // secret older than the window — exactly the receivers most likely to
    // still be holding it.
    const outgoingId = newestSecretEntry(secrets)?.id;
    const keptSecrets: WebhookSecretEntry[] = [
      newEntry,
      ...secrets
        .map((s) =>
          s.id === outgoingId
            ? {
                ...s,
                expiresAt: new Date(now.getTime() + WEBHOOK_SECRET_GRACE_MS).toISOString(),
              }
            : s,
        )
        // Entries with no expiresAt were written before this field existed
        // and are only pruned once a rotation has stamped them.
        .filter((s) => !s.expiresAt || new Date(s.expiresAt).getTime() > now.getTime()),
    ];
    const newCredsObj = { url, secrets: JSON.stringify(keptSecrets) };
    const newCipher = encrypt(JSON.stringify(newCredsObj), encKey);
    const provider = getProvider("CUSTOM_WEBHOOK" as ProviderId);
    const newHint = provider.buildCredentialsHint
      ? provider.buildCredentialsHint(newCredsObj)
      : existing.credentialsHint;

    await drizzle.db.transaction(async (tx) => {
      await tx
        .update(drizzle.schema.integrationConnections)
        .set({
          credentialsCipher: newCipher,
          credentialsHint: newHint,
          lastValidatedAt: now,
          updatedAt: now,
        })
        .where(eq(drizzle.schema.integrationConnections.id, id));

      await audit(
        {
          projectId,
          userId: user.id,
          action: "integration.webhook.secret.rotated",
          resource: "integration_connection",
          resourceId: id,
          before: { credentialsHint: existing.credentialsHint },
          after: { credentialsHint: newHint },
        },
        tx as unknown as AuditTx,
      );
    });

    return c.json(ok({ secret: newEntry.key }));
  })

  // =============================================================
  // GET /dashboard/projects/:projectId/integrations/:id/secret
  // Reveal the newest active webhook secret. GET, but still audited —
  // this exposes a live signing key, not just metadata.
  // =============================================================
  .get("/:id/secret", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing path parameters" });
    }

    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.ADMIN);

    const db = getDb();
    const [existing] = await db
      .select()
      .from(drizzle.schema.integrationConnections)
      .where(
        and(
          eq(drizzle.schema.integrationConnections.id, id),
          eq(drizzle.schema.integrationConnections.projectId, projectId),
          isNull(drizzle.schema.integrationConnections.deletedAt),
        ),
      );
    if (!existing) {
      throw new HTTPException(404, { message: "Integration connection not found" });
    }
    if (existing.providerId !== "CUSTOM_WEBHOOK") {
      return c.json(
        {
          error: {
            code: "not_a_webhook_connection",
            message: "secret reveal only applies to CUSTOM_WEBHOOK connections",
          },
        },
        400,
      );
    }

    const encKey = getEncryptionKey();
    const creds = JSON.parse(
      decrypt(existing.credentialsCipher, encKey),
    ) as Record<string, string>;
    const { secrets } = parseWebhookCredentials(creds);
    const newest = newestSecretEntry(secrets);

    await audit({
      projectId,
      userId: user.id,
      action: "integration.webhook.secret.revealed",
      resource: "integration_connection",
      resourceId: id,
    });

    return c.json(ok({ secret: newest?.key ?? null }));
  })

  // =============================================================
  // PATCH /dashboard/projects/:projectId/integrations/:id
  // M5.4 — update scope/mapping/enabled, optional credential rotation
  // =============================================================
  .patch("/:id", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing path parameters" });
    }

    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.ADMIN);

    const raw = await c.req.json();
    const parse = patchConnectionBody.safeParse(raw);
    if (!parse.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: parse.error.message } },
        400,
      );
    }
    const body = parse.data;

    const db = getDb();

    const [existing] = await db
      .select()
      .from(drizzle.schema.integrationConnections)
      .where(
        and(
          eq(drizzle.schema.integrationConnections.id, id),
          eq(drizzle.schema.integrationConnections.projectId, projectId),
          isNull(drizzle.schema.integrationConnections.deletedAt),
        ),
      );

    if (!existing) {
      throw new HTTPException(404, { message: "Integration connection not found" });
    }

    const wasEnabled = existing.isEnabled;
    const willBeEnabled =
      body.isEnabled !== undefined ? body.isEnabled : wasEnabled;

    let newCipher = existing.credentialsCipher;
    let newHint = existing.credentialsHint;
    let rotated = false;

    if (body.credentials) {
      // Decrypt existing, merge new fields, re-validate, encrypt
      const encKey = getEncryptionKey();
      const existingCreds = JSON.parse(
        decrypt(existing.credentialsCipher, encKey),
      ) as Record<string, string>;

      const provider = getProvider(existing.providerId as ProviderId);

      // For webhook connections the SERVER owns the signing keys: they are
      // minted on create and replaced only via POST /:id/rotate-secret,
      // which stamps the rotation grace and audits the change. Accepting a
      // client-supplied `secrets` array here would let an ADMIN install an
      // arbitrary (or shared, or attacker-chosen) signing key behind the
      // rotation audit trail, and could silently strip the grace stamps off
      // keys still in their window. Only `url` is patchable, and it is
      // re-validated through the same SSRF guard as create.
      if (provider.allowMultipleConnections) {
        const webhookPatch = webhookPatchCredentialsBody.safeParse(body.credentials);
        if (!webhookPatch.success) {
          return c.json(
            {
              error: {
                code: "VALIDATION_ERROR",
                message:
                  "only `url` may be patched on a webhook connection; use POST /:id/rotate-secret to change the signing secret",
              },
            },
            400,
          );
        }
        try {
          assertPublicWebhookUrl(webhookPatch.data.url);
        } catch (err) {
          if (err instanceof WebhookUrlError) {
            return c.json(
              { error: { code: "invalid_credentials", message: err.reason } },
              400,
            );
          }
          throw err;
        }
      }

      const mergedCreds = { ...existingCreds, ...body.credentials };
      const credsParse = provider.credentialsSchema.safeParse(mergedCreds);
      if (!credsParse.success) {
        return c.json(
          { error: { code: "VALIDATION_ERROR", message: credsParse.error.message } },
          400,
        );
      }

      const http = createUndiciHttpClient();
      const validation = await provider.validateCredentials(mergedCreds, http);
      if (!validation.ok) {
        return c.json(
          {
            error: {
              code: "invalid_credentials",
              message: (validation as { ok: false; reason: string }).reason,
            },
          },
          400,
        );
      }

      newCipher = encrypt(JSON.stringify(mergedCreds), encKey);
      // Prefer the provider's own hint builder (webhook = host · …key4);
      // the generic one assumes a pixel-style access token.
      newHint = provider.buildCredentialsHint
        ? provider.buildCredentialsHint(mergedCreds)
        : buildCredentialsHint(existing.providerId, mergedCreds);
      rotated = true;
    }

    // Build a partial update set
    const patch: Partial<NewIntegrationConnection> = {
      updatedAt: new Date(),
    };
    if (body.displayName !== undefined) patch.displayName = body.displayName;
    if (body.enabledEvents !== undefined)
      patch.enabledEvents = body.enabledEvents as string[];
    if (body.eventMapping !== undefined) patch.eventMapping = body.eventMapping;
    if (body.actionSource !== undefined) patch.actionSource = body.actionSource;
    if (body.testEventCode !== undefined) patch.testEventCode = body.testEventCode;
    if (body.isEnabled !== undefined) patch.isEnabled = body.isEnabled;
    if (rotated) {
      patch.credentialsCipher = newCipher;
      patch.credentialsHint = newHint;
      patch.lastValidatedAt = new Date();
    }

    await drizzle.db.transaction(async (tx) => {
      await tx
        .update(drizzle.schema.integrationConnections)
        .set(patch)
        .where(eq(drizzle.schema.integrationConnections.id, id));

      if (rotated) {
        await audit(
          {
            projectId,
            userId: user.id,
            action: "integration.credentials.rotated",
            resource: "integration_connection",
            resourceId: id,
            before: { credentialsHint: existing.credentialsHint },
            after: { credentialsHint: newHint },
          },
          tx as unknown as AuditTx,
        );
      } else {
        await audit(
          {
            projectId,
            userId: user.id,
            action: "integration.connection.updated",
            resource: "integration_connection",
            resourceId: id,
            before: {
              displayName: existing.displayName,
              enabledEvents: existing.enabledEvents,
              isEnabled: existing.isEnabled,
            },
            after: {
              displayName: body.displayName ?? existing.displayName,
              enabledEvents: body.enabledEvents ?? existing.enabledEvents,
              isEnabled: willBeEnabled,
            },
          },
          tx as unknown as AuditTx,
        );
      }
    });

    // After tx: handle false→true enable transition (enqueue backfill)
    // TODO M9.1: cache invalidation via EventEmitter — currently relying on 60s TTL
    if (!wasEnabled && willBeEnabled) {
      // Best-effort: don't fail PATCH if Redis is unavailable
      void (async () => {
        const redisConn = attachRedisErrorLogger(
          new Redis(env.REDIS_URL, {
            maxRetriesPerRequest: null,
            enableOfflineQueue: false,
          }),
          "integrations-backfill-queue",
        );
        const queue = new Queue<IntegrationsDeliverJob>(
          INTEGRATIONS_DELIVER_QUEUE_NAME,
          { connection: redisConn },
        );

        const backfillAuditFn = async (input: BackfillAuditInput) => {
          await audit({
            projectId: input.projectId,
            userId: user.id,
            action: input.action as Parameters<typeof audit>[0]["action"],
            resource: input.resource as Parameters<typeof audit>[0]["resource"],
            resourceId: input.resourceId,
            after: input.metadata ?? null,
          });
        };

        try {
          await handleConnectionEnableTransition(
            {
              connectionId: id,
              projectId,
              providerId: existing.providerId as ProviderId,
              wasEnabled,
              willBeEnabled,
            },
            {
              enqueueBackfill: (args) =>
                enqueueBackfillForConnection(args, {
                  db: {
                    execute: async (sqlInput: { sql: string; params: unknown[] }) => {
                      const result = await drizzle.db.execute(
                        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                        { sql: sqlInput.sql, params: sqlInput.params } as any,
                      );
                      return { rows: (result as unknown as { rows?: OutboxRow[] }).rows ?? [] };
                    },
                  },
                  queue,
                  audit: backfillAuditFn,
                }),
            },
          );
        } catch {
          // Backfill is best-effort
        } finally {
          await queue.close().catch(() => undefined);
          await redisConn.quit().catch(() => undefined);
        }
      })();
    }

    const [updated] = await drizzle.db
      .select(connectionSelect())
      .from(drizzle.schema.integrationConnections)
      .where(eq(drizzle.schema.integrationConnections.id, id));

    return c.json(ok({ connection: updated }));
  })

  // =============================================================
  // DELETE /dashboard/projects/:projectId/integrations/:id
  // M5.5 — soft delete
  // =============================================================
  .delete("/:id", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing path parameters" });
    }

    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.ADMIN);

    const db = getDb();

    const [existing] = await db
      .select({ id: drizzle.schema.integrationConnections.id })
      .from(drizzle.schema.integrationConnections)
      .where(
        and(
          eq(drizzle.schema.integrationConnections.id, id),
          eq(drizzle.schema.integrationConnections.projectId, projectId),
          isNull(drizzle.schema.integrationConnections.deletedAt),
        ),
      );

    if (!existing) {
      throw new HTTPException(404, { message: "Integration connection not found" });
    }

    const now = new Date();

    await drizzle.db.transaction(async (tx) => {
      await tx
        .update(drizzle.schema.integrationConnections)
        .set({ deletedAt: now, isEnabled: false, updatedAt: now })
        .where(eq(drizzle.schema.integrationConnections.id, id));

      await audit(
        {
          projectId,
          userId: user.id,
          action: "integration.connection.deleted",
          resource: "integration_connection",
          resourceId: id,
        },
        tx as unknown as AuditTx,
      );
    });

    // TODO M9.1: cache invalidation via EventEmitter — currently relying on 60s TTL
    return c.body(null, 204);
  })

  // =============================================================
  // POST /dashboard/projects/:projectId/integrations/:id/test-event
  // M5.7 — synthetic $0.01 Subscribe via test_event_code
  // =============================================================
  .post("/:id/test-event", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing path parameters" });
    }

    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.DEVELOPER);

    const db = getDb();
    const [conn] = await db
      .select()
      .from(drizzle.schema.integrationConnections)
      .where(
        and(
          eq(drizzle.schema.integrationConnections.id, id),
          eq(drizzle.schema.integrationConnections.projectId, projectId),
          isNull(drizzle.schema.integrationConnections.deletedAt),
        ),
      );

    if (!conn) {
      throw new HTTPException(404, { message: "Integration connection not found" });
    }

    if (!conn.testEventCode) {
      return c.json(
        {
          error: {
            code: "VALIDATION_ERROR",
            message: "testEventCode is not configured on this connection",
          },
        },
        400,
      );
    }

    const encKey = getEncryptionKey();
    const creds = JSON.parse(
      decrypt(conn.credentialsCipher, encKey),
    ) as Record<string, string>;

    const provider = getProvider(conn.providerId as ProviderId);
    const http = createUndiciHttpClient();

    // Build synthetic envelope — INITIAL revenue event, $0.01 USD
    const envelope = {
      outboxEventId: createId(),
      projectId,
      eventType: "revenue.event.recorded" as const,
      occurredAt: new Date().toISOString(),
      revenueEventKind: "INITIAL" as const,
      amount: "0.01",
      currency: "USD",
      subscriberId: "test-subscriber",
      identityContext: {
        email: "test@example.com",
        externalId: "test-external-id",
      },
    };

    // Include "revenue.INITIAL" in enabledEvents to bypass scope filter
    const config = {
      connectionId: conn.id,
      projectId: conn.projectId,
      enabledEvents: ["revenue.INITIAL"] as unknown as Parameters<
        typeof provider.mapEvent
      >[1]["enabledEvents"],
      eventMapping: (conn.eventMapping ??
        {}) as Parameters<typeof provider.mapEvent>[1]["eventMapping"],
      actionSource: (conn.actionSource ?? "app") as
        | "app"
        | "website"
        | "system_generated",
      testEventCode: conn.testEventCode,
    };

    const mapResult = provider.mapEvent(envelope, config, creds);

    let okResult = false;
    let httpStatus: number | null = null;
    let responseBody: string | null = null;
    let errorMessage: string | null = null;

    if ("skip" in mapResult && mapResult.skip) {
      errorMessage = `Event was skipped: ${mapResult.reason}`;
    } else {
      const deliveryResult = await provider.deliver(mapResult as ProviderPayload, creds, http);
      okResult = deliveryResult.ok;
      httpStatus = deliveryResult.httpStatus;
      responseBody = deliveryResult.responseBody.slice(0, RESPONSE_BODY_MAX_BYTES);
      errorMessage = deliveryResult.errorMessage ?? null;
    }

    await audit({
      projectId,
      userId: user.id,
      action: "integration.test_event.sent",
      resource: "integration_connection",
      resourceId: id,
      after: {
        testEventCode: conn.testEventCode,
        ok: okResult,
        httpStatus,
      },
    });

    return c.json(ok({ ok: okResult, httpStatus, responseBody, errorMessage }));
  })

  // =============================================================
  // GET /dashboard/projects/:projectId/integrations/:id/deliveries
  // M5.8 — cursor-paginated delivery log with optional status filter
  // =============================================================
  .get("/:id/deliveries", async (c) => {
    const projectId = c.req.param("projectId");
    const id = c.req.param("id");
    if (!projectId || !id) {
      throw new HTTPException(400, { message: "Missing path parameters" });
    }

    const user = c.get("user");
    await assertProjectAccess(projectId, user.id, MemberRole.CUSTOMER_SUPPORT);

    const qParse = deliveriesQuery.safeParse(c.req.query());
    if (!qParse.success) {
      return c.json(
        { error: { code: "VALIDATION_ERROR", message: qParse.error.message } },
        400,
      );
    }
    const { cursor, status, limit } = qParse.data;

    const db = getDb();

    // Verify connection exists and belongs to project
    const [conn] = await db
      .select({ id: drizzle.schema.integrationConnections.id })
      .from(drizzle.schema.integrationConnections)
      .where(
        and(
          eq(drizzle.schema.integrationConnections.id, id),
          eq(drizzle.schema.integrationConnections.projectId, projectId),
          isNull(drizzle.schema.integrationConnections.deletedAt),
        ),
      );

    if (!conn) {
      throw new HTTPException(404, { message: "Integration connection not found" });
    }

    const page = await drizzle.integrationDeliveryRepo.listDeliveriesForConnection(
      db,
      {
        connectionId: id,
        limit,
        cursor,
        status: status as Parameters<
          typeof drizzle.integrationDeliveryRepo.listDeliveriesForConnection
        >[1]["status"],
      },
    );

    return c.json(
      ok({ deliveries: page.rows, nextCursor: page.nextCursor ?? null }),
    );
  })

  // =============================================================
  // POST /dashboard/projects/:projectId/integrations/:id/deliveries/:deliveryId/redeliver
  // Task 10 — manual redeliver of a single past delivery.
  //
  // Rebuilds the RovenueEventEnvelope from the delivery's originating
  // `outbox_events` row (via the same `outboxRowToEnvelope` helper the
  // backfill loop uses — see services/integrations/backfill.ts) and
  // re-enqueues it under a fresh `buildRedeliverJobId` job id so it runs
  // again even if the original realtime/backfill job already completed
  // and is still retained under BullMQ's removeOnComplete/removeOnFail
  // window (see deliverJobOptions).
  //
  // The redeliver window is bounded by outbox retention, NOT by anything
  // this route enforces directly: workers/outbox-cleanup.ts prunes
  // `outbox_events` rows older than OUTBOX_RETENTION_WINDOW_MS (72h, kept
  // deliberately longer than the longest retry ladder), and once the row is
  // gone this returns 410 event_expired — the delivery row itself is kept
  // indefinitely as an audit trail, but there is nothing left to replay.
  // =============================================================
  .post(
    "/:id/deliveries/:deliveryId/redeliver",
    // Mirrors /validate's rate-limit shape — a manual redeliver also does
    // real work (a live BullMQ enqueue that will hit a third-party API),
    // so it gets the same per-user cap rather than the router's default.
    endpointRateLimit({
      name: "integrations-redeliver",
      max: 30,
      identify: (c) => c.get("user")?.id ?? clientIp(c),
    }),
    async (c) => {
      const projectId = c.req.param("projectId");
      const id = c.req.param("id");
      const deliveryId = c.req.param("deliveryId");
      if (!projectId || !id || !deliveryId) {
        throw new HTTPException(400, { message: "Missing path parameters" });
      }

      const user = c.get("user");
      await assertProjectAccess(projectId, user.id, MemberRole.DEVELOPER);

      const db = getDb();

      const [conn] = await db
        .select()
        .from(drizzle.schema.integrationConnections)
        .where(
          and(
            eq(drizzle.schema.integrationConnections.id, id),
            eq(drizzle.schema.integrationConnections.projectId, projectId),
            isNull(drizzle.schema.integrationConnections.deletedAt),
          ),
        );
      if (!conn) {
        throw new HTTPException(404, { message: "Integration connection not found" });
      }

      const delivery = await drizzle.integrationDeliveryRepo.getDeliveryById(
        db,
        deliveryId,
      );
      // The ownership chain: the delivery must belong to THIS connection
      // AND this project — a delivery id alone isn't enough to authorize
      // access to it.
      if (!delivery || delivery.connectionId !== id || delivery.projectId !== projectId) {
        throw new HTTPException(404, { message: "Delivery not found" });
      }

      const [outboxRow] = await db
        .select()
        .from(drizzle.schema.outboxEvents)
        .where(eq(drizzle.schema.outboxEvents.id, delivery.outboxEventId));

      if (!outboxRow) {
        return c.json(
          {
            error: {
              code: "event_expired",
              message:
                "The originating outbox event has been pruned and can no longer be redelivered",
            },
          },
          410,
        );
      }

      // Same normalization the live fan-out consumer applies (see
      // services/integrations/backfill.ts). A row this build can't map onto
      // a fan-out envelope — an aggregate type with no fan-out topic, an
      // unmapped event type, a payload without a projectId — is a permanent
      // condition, not a transient one: report it instead of enqueueing a
      // job that would fail on the NOT NULL outbox_event_id column.
      const envelope = outboxRowToEnvelope({
        id: outboxRow.id,
        aggregateType: outboxRow.aggregateType,
        eventType: outboxRow.eventType,
        payload: outboxRow.payload,
        createdAt: outboxRow.createdAt,
      });
      if (!envelope) {
        return c.json(
          {
            error: {
              code: "event_unmappable",
              message:
                "The originating outbox event cannot be mapped onto a deliverable event and can no longer be redelivered",
            },
          },
          422,
        );
      }

      const jobId = buildRedeliverJobId(id, delivery.outboxEventId, createId());

      // Short-lived Queue + Redis connection, same pattern as the
      // false→true backfill-enqueue path in the PATCH /:id route above —
      // closed in `finally` regardless of enqueue outcome.
      const redisConn = attachRedisErrorLogger(
        new Redis(env.REDIS_URL, {
          maxRetriesPerRequest: null,
          enableOfflineQueue: false,
        }),
        "integrations-redeliver-queue",
      );
      const queue = new Queue<IntegrationsDeliverJob>(
        INTEGRATIONS_DELIVER_QUEUE_NAME,
        { connection: redisConn },
      );

      try {
        const job: IntegrationsDeliverJob = {
          connectionId: id,
          projectId,
          providerId: conn.providerId as ProviderId,
          envelope,
        };
        await queue.add("deliver", job, deliverJobOptions(conn.providerId, jobId));
      } finally {
        await queue.close().catch(() => undefined);
        await redisConn.quit().catch(() => undefined);
      }

      await audit({
        projectId,
        userId: user.id,
        action: "integration.delivery.redelivered",
        resource: "integration_connection",
        resourceId: id,
        after: { deliveryId, outboxEventId: delivery.outboxEventId },
      });

      return c.json(ok({ enqueued: true }), 202);
    },
  );
