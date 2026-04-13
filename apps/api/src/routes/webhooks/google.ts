import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import prisma from "@rovenue/db";
import { handleGoogleNotification } from "../../services/google/google-webhook";
import type {
  GoogleServiceAccountCredentials,
  GoogleVerifyConfig,
} from "../../services/google";
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

const googleCredentialsSchema = z.object({
  packageName: z.string().min(1),
  serviceAccount: z.object({
    client_email: z.string().email(),
    private_key: z.string().min(1),
  }).passthrough(),
});

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

export const googleWebhookRoute = new Hono();

/**
 * Real-time Developer Notifications webhook (Pub/Sub push endpoint).
 *
 * Configure this URL in your Pub/Sub push subscription and set
 * `project.googleCredentials` to `{ packageName, serviceAccount }` so the
 * handler can call purchases.subscriptionsv2.get for authoritative state.
 */
googleWebhookRoute.post("/:projectId", async (c) => {
  const projectId = c.req.param("projectId");

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
