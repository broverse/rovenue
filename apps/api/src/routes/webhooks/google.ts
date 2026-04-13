import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { BEARER_SCHEME, HEADER } from "@rovenue/shared";
import prisma from "@rovenue/db";
import { handleGoogleNotification } from "../../services/google/google-webhook";
import { verifyPubSubPushToken } from "../../services/google/google-auth";
import type {
  GoogleServiceAccountCredentials,
  GoogleVerifyConfig,
} from "../../services/google";
import { env } from "../../lib/env";
import { ok } from "../../lib/response";
import { logger } from "../../lib/logger";

const log = logger.child("route:webhook:google");

const pushBodySchema = z.object({
  message: z.object({
    data: z.string().min(1),
    messageId: z.string(),
    publishTime: z.string(),
    attributes: z.record(z.string()).optional(),
  }),
  subscription: z.string(),
});

const googleCredentialsSchema = z
  .object({
    packageName: z.string().min(1),
    serviceAccount: z
      .object({
        client_email: z.string().email(),
        private_key: z.string().min(1),
      })
      .passthrough(),
  })
  .passthrough();

async function loadVerifyConfig(
  projectId: string,
): Promise<GoogleVerifyConfig | undefined> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { googleCredentials: true },
  });
  if (!project?.googleCredentials) return undefined;

  const parsed = googleCredentialsSchema.safeParse(project.googleCredentials);
  if (!parsed.success) {
    log.warn("project googleCredentials failed schema validation", {
      projectId,
      issues: parsed.error.issues,
    });
    return undefined;
  }

  return {
    packageName: parsed.data.packageName,
    credentials: parsed.data.serviceAccount as GoogleServiceAccountCredentials,
  };
}

async function enforcePubSubAuth(authHeader: string | undefined): Promise<void> {
  if (!env.PUBSUB_PUSH_AUDIENCE) {
    return; // Verification disabled (dev / no config)
  }

  const prefix = `${BEARER_SCHEME.toLowerCase()} `;
  if (!authHeader || !authHeader.toLowerCase().startsWith(prefix)) {
    throw new HTTPException(401, { message: "Pub/Sub Bearer token required" });
  }

  const idToken = authHeader.slice(prefix.length).trim();
  try {
    await verifyPubSubPushToken(idToken, {
      audience: env.PUBSUB_PUSH_AUDIENCE,
      serviceAccountEmail: env.PUBSUB_PUSH_SERVICE_ACCOUNT,
    });
  } catch (err) {
    log.warn("pubsub token verification failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    throw new HTTPException(401, { message: "Invalid Pub/Sub token" });
  }
}

export const googleWebhookRoute = new Hono();

/**
 * Real-time Developer Notifications webhook (Pub/Sub push endpoint).
 *
 * Configure this URL in your Pub/Sub push subscription and set
 * `project.googleCredentials` to `{ packageName, serviceAccount }` so the
 * handler can call purchases.subscriptionsv2.get for authoritative state.
 *
 * If `PUBSUB_PUSH_AUDIENCE` is set on the API, each request must carry a
 * Google-signed OIDC Bearer token whose `aud` matches that value.
 */
googleWebhookRoute.post("/:projectId", async (c) => {
  const projectId = c.req.param("projectId");

  await enforcePubSubAuth(c.req.header(HEADER.AUTHORIZATION));

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { id: true },
  });
  if (!project) {
    throw new HTTPException(404, { message: "Project not found" });
  }

  const pushBody = pushBodySchema.parse(await c.req.json());
  const verifyConfig = await loadVerifyConfig(projectId);

  const result = await handleGoogleNotification({
    projectId,
    pushBody,
    verifyConfig,
  });

  log.info("google notification handled", {
    projectId,
    status: result.status,
    kind: "kind" in result ? result.kind : undefined,
  });

  return c.json(ok(result));
});
