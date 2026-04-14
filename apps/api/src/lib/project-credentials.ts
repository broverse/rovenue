import prisma, { decryptCredential } from "@rovenue/db";
import { z } from "zod";
import { env } from "./env";
import { logger } from "./logger";

const log = logger.child("project-credentials");

// =============================================================
// Per-store credential schemas
// =============================================================

const googleSchema = z
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

const stripeSchema = z
  .object({
    secretKey: z.string().min(1),
    webhookSecret: z.string().min(1),
  })
  .passthrough();

const appleSchema = z
  .object({
    bundleId: z.string().min(1),
    appAppleId: z.number().int().positive().optional(),
    keyId: z.string().optional(),
    issuerId: z.string().optional(),
    privateKey: z.string().optional(),
  })
  .passthrough();

export type GoogleCredentials = z.infer<typeof googleSchema>;
export type StripeCredentials = z.infer<typeof stripeSchema>;
export type AppleCredentials = z.infer<typeof appleSchema>;

// =============================================================
// Loader helpers
// =============================================================

function unwrap(raw: unknown): unknown {
  if (raw === null || raw === undefined) return null;
  try {
    return decryptCredential(raw, env.ENCRYPTION_KEY ?? "");
  } catch (err) {
    log.error("credential decrypt failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export async function loadGoogleCredentials(
  projectId: string,
): Promise<GoogleCredentials | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { googleCredentials: true },
  });
  const plain = unwrap(project?.googleCredentials ?? null);
  if (!plain) return null;
  const parsed = googleSchema.safeParse(plain);
  if (!parsed.success) {
    log.warn("google credentials schema mismatch", {
      projectId,
      issues: parsed.error.issues,
    });
    return null;
  }
  return parsed.data;
}

export async function loadStripeCredentials(
  projectId: string,
): Promise<StripeCredentials | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { stripeCredentials: true },
  });
  const plain = unwrap(project?.stripeCredentials ?? null);
  if (!plain) return null;
  const parsed = stripeSchema.safeParse(plain);
  if (!parsed.success) {
    log.warn("stripe credentials schema mismatch", {
      projectId,
      issues: parsed.error.issues,
    });
    return null;
  }
  return parsed.data;
}

export async function loadAppleCredentials(
  projectId: string,
): Promise<AppleCredentials | null> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { appleCredentials: true },
  });
  const plain = unwrap(project?.appleCredentials ?? null);
  if (!plain) return null;
  const parsed = appleSchema.safeParse(plain);
  if (!parsed.success) {
    log.warn("apple credentials schema mismatch", {
      projectId,
      issues: parsed.error.issues,
    });
    return null;
  }
  return parsed.data;
}
