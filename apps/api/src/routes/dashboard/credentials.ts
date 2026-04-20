import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import prisma, {
  MemberRole,
  Prisma,
  decryptCredential,
  encryptCredential,
} from "@rovenue/db";
import type {
  CredentialStatus,
  CredentialStore,
  CredentialsListResponse,
} from "@rovenue/shared";
import { requireDashboardAuth } from "../../middleware/dashboard-auth";
import { assertProjectAccess } from "../../lib/project-access";
import { audit, extractRequestContext, redactCredentials } from "../../lib/audit";
import { env } from "../../lib/env";
import { ok } from "../../lib/response";

// =============================================================
// Dashboard: Store credentials (apple / google / stripe)
// =============================================================
//
// Write requires OWNER (secret material rotation is a privileged
// operation). Read is VIEWER+ and NEVER echoes plaintext — only a
// boolean `configured` + a small allowlist of non-sensitive fields
// (bundleId, packageName, etc.). Writes go through the existing
// `encryptCredential` helper so the wire format `{v:1, enc:"iv:…"}`
// stays consistent across loaders.

// =============================================================
// Zod request schemas — mirror apps/api/src/lib/project-credentials.ts
// =============================================================
//
// The body shape depends on the `:store` route param so zValidator
// (static schema) isn't a clean fit here. The handler dispatches
// to the right schema post-match and surfaces a 400 with a
// field-level Zod message on failure.

export const appleCredentialsBodySchema = z
  .object({
    bundleId: z.string().min(1),
    appAppleId: z.number().int().positive().optional(),
    keyId: z.string().optional(),
    issuerId: z.string().optional(),
    privateKey: z.string().optional(),
  })
  .passthrough();

export const googleCredentialsBodySchema = z
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

export const stripeCredentialsBodySchema = z
  .object({
    secretKey: z.string().min(1),
    webhookSecret: z.string().min(1),
  })
  .passthrough();

const storeParam = z.enum(["apple", "google", "stripe"]);

// =============================================================
// Shape → safe-to-display subset
// =============================================================

function safeFields(
  store: CredentialStore,
  plain: Record<string, unknown> | null,
): Record<string, string> | undefined {
  if (!plain) return undefined;
  if (store === "apple" && typeof plain.bundleId === "string") {
    const out: Record<string, string> = { bundleId: plain.bundleId };
    if (typeof plain.appAppleId === "number") {
      out.appAppleId = String(plain.appAppleId);
    }
    if (typeof plain.keyId === "string") out.keyId = plain.keyId;
    return out;
  }
  if (store === "google" && typeof plain.packageName === "string") {
    const out: Record<string, string> = { packageName: plain.packageName };
    const sa = plain.serviceAccount as
      | { client_email?: unknown }
      | null
      | undefined;
    if (sa && typeof sa.client_email === "string") {
      out.clientEmail = sa.client_email;
    }
    return out;
  }
  if (store === "stripe") {
    // Only return "configured: true" plus a hint that the webhook
    // secret is set. Never echo any Stripe secrets.
    return { configured: "true" };
  }
  return undefined;
}

function decryptField<T>(raw: unknown): T | null {
  if (raw === null || raw === undefined) return null;
  try {
    return decryptCredential<T>(raw, env.ENCRYPTION_KEY ?? "");
  } catch {
    return null;
  }
}

function columnForStore(store: CredentialStore): keyof Prisma.ProjectSelect {
  if (store === "apple") return "appleCredentials";
  if (store === "google") return "googleCredentials";
  return "stripeCredentials";
}

export const credentialsRoute = new Hono()
  .use("*", requireDashboardAuth)
  // =============================================================
  // GET /dashboard/projects/:projectId/credentials
  // =============================================================
  .get("/", async (c) => {
  const projectId = c.req.param("projectId");
  if (!projectId) {
    throw new HTTPException(400, { message: "Missing projectId" });
  }
  const user = c.get("user");
  await assertProjectAccess(projectId, user.id, MemberRole.VIEWER);

  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      appleCredentials: true,
      googleCredentials: true,
      stripeCredentials: true,
    },
  });
  if (!project) throw new HTTPException(404, { message: "Project not found" });

  const statusFor = (
    store: CredentialStore,
    raw: unknown,
  ): CredentialStatus => {
    if (!raw) return { store, configured: false };
    const plain = decryptField<Record<string, unknown>>(raw);
    return {
      store,
      configured: Boolean(plain),
      safeFields: safeFields(store, plain),
    };
  };

  const payload: CredentialsListResponse = {
    credentials: {
      apple: statusFor("apple", project.appleCredentials),
      google: statusFor("google", project.googleCredentials),
      stripe: statusFor("stripe", project.stripeCredentials),
    },
  };
    return c.json(ok(payload));
  })
  // =============================================================
  // PUT /dashboard/projects/:projectId/credentials/:store
  // =============================================================
  .put("/:store", async (c) => {
  const projectId = c.req.param("projectId");
  const storeParamRaw = c.req.param("store");
  if (!projectId) {
    throw new HTTPException(400, { message: "Missing projectId" });
  }
  const parsedStore = storeParam.safeParse(storeParamRaw);
  if (!parsedStore.success) {
    throw new HTTPException(400, { message: "Unknown store" });
  }
  const store = parsedStore.data;

  const user = c.get("user");
  await assertProjectAccess(projectId, user.id, MemberRole.OWNER);

  let body: Record<string, unknown>;
  try {
    const raw = await c.req.json();
    const schema = store === "apple"
      ? appleCredentialsBodySchema
      : store === "google"
        ? googleCredentialsBodySchema
        : stripeCredentialsBodySchema;
    body = schema.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new HTTPException(400, {
      message:
        err instanceof z.ZodError
          ? err.errors[0]?.message ?? "Invalid credential payload"
          : "Invalid JSON body",
    });
  }

  if (!env.ENCRYPTION_KEY) {
    throw new HTTPException(500, {
      message: "Server missing ENCRYPTION_KEY",
    });
  }

  const encrypted = encryptCredential(body, env.ENCRYPTION_KEY);
  const column = columnForStore(store);

  await prisma.$transaction(async (tx) => {
    await tx.project.update({
      where: { id: projectId },
      data: { [column]: encrypted as unknown as Prisma.InputJsonValue },
    });
    await audit(
      {
        projectId,
        userId: user.id,
        action: "credential.updated",
        resource: "credential",
        resourceId: `${projectId}:${store}`,
        before: redactCredentials({ [store]: "*" }),
        after: redactCredentials({ [store]: "*" }),
        ...extractRequestContext(c),
      },
      tx,
    );
  });

    return c.json(ok({ credential: { store, configured: true } }));
  })
  // =============================================================
  // DELETE /dashboard/projects/:projectId/credentials/:store
  // =============================================================
  .delete("/:store", async (c) => {
  const projectId = c.req.param("projectId");
  const storeParamRaw = c.req.param("store");
  if (!projectId) {
    throw new HTTPException(400, { message: "Missing projectId" });
  }
  const parsedStore = storeParam.safeParse(storeParamRaw);
  if (!parsedStore.success) {
    throw new HTTPException(400, { message: "Unknown store" });
  }
  const store = parsedStore.data;

  const user = c.get("user");
  await assertProjectAccess(projectId, user.id, MemberRole.OWNER);

  const column = columnForStore(store);
  await prisma.$transaction(async (tx) => {
    await tx.project.update({
      where: { id: projectId },
      data: { [column]: Prisma.JsonNull },
    });
    await audit(
      {
        projectId,
        userId: user.id,
        action: "credential.cleared",
        resource: "credential",
        resourceId: `${projectId}:${store}`,
        before: redactCredentials({ [store]: "*" }),
        after: null,
        ...extractRequestContext(c),
      },
      tx,
    );
  });

    return c.json(ok({ credential: { store, configured: false } }));
  });
