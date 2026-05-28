import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { and, eq, isNull } from "drizzle-orm";
import { z } from "zod";
import { Queue } from "bullmq";
import { Redis } from "ioredis";
import { createId } from "@paralleldrive/cuid2";
import { MemberRole, drizzle, getDb } from "@rovenue/db";
import { encrypt, decrypt } from "@rovenue/shared/crypto";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { ok } from "../../lib/response";
import { audit } from "../../lib/audit";
import { env } from "../../lib/env";
import { getProvider } from "../../services/integrations/registry";
import { createUndiciHttpClient } from "../../services/integrations/http-client";
import {
  handleConnectionEnableTransition,
} from "../../services/integrations/connection-events";
import {
  enqueueBackfillForConnection,
  type BackfillAuditInput,
  type OutboxRow,
} from "../../services/integrations/backfill";
import {
  INTEGRATIONS_DELIVER_QUEUE_NAME,
  type IntegrationsDeliverJob,
} from "../../queues/integrations";
import type { ProviderId, ProviderPayload } from "../../services/integrations/types";
import type { AuditTx } from "../../lib/audit";
import type { NewIntegrationConnection } from "@rovenue/db/src/drizzle/schema";

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
// Zod schemas
// =============================================================

const createConnectionBody = z.object({
  providerId: z.enum(["META_CAPI", "TIKTOK_EVENTS"]),
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
  providerId: z.enum(["META_CAPI", "TIKTOK_EVENTS"]),
  credentials: z.record(z.string()),
});

const deliveriesQuery = z.object({
  cursor: z.string().optional(),
  status: z
    .enum(["pending", "succeeded", "failed", "skipped", "dead_letter"])
    .optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

// Re-usable projection for list/read (excludes credentialsCipher)
const CONNECTION_SELECT = {
  id: drizzle.schema.integrationConnections.id,
  projectId: drizzle.schema.integrationConnections.projectId,
  providerId: drizzle.schema.integrationConnections.providerId,
  displayName: drizzle.schema.integrationConnections.displayName,
  credentialsHint: drizzle.schema.integrationConnections.credentialsHint,
  enabledEvents: drizzle.schema.integrationConnections.enabledEvents,
  eventMapping: drizzle.schema.integrationConnections.eventMapping,
  actionSource: drizzle.schema.integrationConnections.actionSource,
  testEventCode: drizzle.schema.integrationConnections.testEventCode,
  isEnabled: drizzle.schema.integrationConnections.isEnabled,
  lastValidatedAt: drizzle.schema.integrationConnections.lastValidatedAt,
  lastError: drizzle.schema.integrationConnections.lastError,
  lastBackfillAt: drizzle.schema.integrationConnections.lastBackfillAt,
  createdAt: drizzle.schema.integrationConnections.createdAt,
  updatedAt: drizzle.schema.integrationConnections.updatedAt,
};

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
      .select(CONNECTION_SELECT)
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

    // Validate credentials BEFORE any DB write
    const http = createUndiciHttpClient();
    const provider = getProvider(body.providerId as ProviderId);
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

    const [row] = await drizzle.db
      .select(CONNECTION_SELECT)
      .from(drizzle.schema.integrationConnections)
      .where(eq(drizzle.schema.integrationConnections.id, id));

    return c.json(ok({ connection: row }), 201);
  })

  // =============================================================
  // POST /dashboard/projects/:projectId/integrations/validate
  // M5.6 — dry-run credential validation, no DB write
  // NOTE: Must be registered BEFORE /:id routes to avoid id="validate" clash
  // =============================================================
  .post("/validate", async (c) => {
    const projectId = c.req.param("projectId");
    if (!projectId) throw new HTTPException(400, { message: "Missing projectId" });

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

    // NOTE: rate-limit middleware for this endpoint deferred to M9.1
    const http = createUndiciHttpClient();
    const provider = getProvider(body.providerId as ProviderId);
    const result = await provider.validateCredentials(body.credentials, http);

    if (result.ok) {
      return c.json(ok({ ok: true }));
    }
    // Failure goes in body with 200 status — NOT 400 (per plan §M5.6)
    return c.json(
      ok({ ok: false, reason: (result as { ok: false; reason: string }).reason }),
    );
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
      const mergedCreds = { ...existingCreds, ...body.credentials };

      const http = createUndiciHttpClient();
      const provider = getProvider(existing.providerId as ProviderId);
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
      newHint = buildCredentialsHint(existing.providerId, mergedCreds);
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
        const redisConn = new Redis(env.REDIS_URL, {
          maxRetriesPerRequest: null,
          enableOfflineQueue: false,
        });
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
      .select(CONNECTION_SELECT)
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
      responseBody = deliveryResult.responseBody.slice(0, 4096);
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
  });
