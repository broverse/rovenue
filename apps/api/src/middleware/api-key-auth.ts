import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import prisma from "@rovenue/db";

export type ApiKeyKind = "PUBLIC" | "SECRET";

export interface AuthenticatedProject {
  id: string;
  name: string;
  slug: string;
  keyKind: ApiKeyKind;
  apiKeyId: string;
}

declare module "hono" {
  interface ContextVariableMap {
    project: AuthenticatedProject;
  }
}

function detectKind(rawKey: string): ApiKeyKind | null {
  if (rawKey.startsWith("rov_pub_")) return "PUBLIC";
  if (rawKey.startsWith("rov_sec_")) return "SECRET";
  return null;
}

export function apiKeyAuth(
  required: ApiKeyKind | "any" = "any",
): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header("authorization");
    if (!header?.toLowerCase().startsWith("bearer ")) {
      throw new HTTPException(401, { message: "Bearer token required" });
    }

    const rawKey = header.slice(7).trim();
    const detected = detectKind(rawKey);
    if (!detected) {
      throw new HTTPException(401, { message: "Invalid API key format" });
    }

    if (required !== "any" && detected !== required) {
      throw new HTTPException(403, {
        message: `${required.toLowerCase()} API key required`,
      });
    }

    // Public keys are stored plaintext and indexed, so we can look them up
    // directly. Secret keys are bcrypted — verification path requires a lookup
    // convention (e.g. key-id prefix) that isn't wired yet.
    if (detected !== "PUBLIC") {
      throw new HTTPException(501, {
        message: "Secret key verification not yet implemented",
      });
    }

    const record = await prisma.apiKey.findUnique({
      where: { keyPublic: rawKey },
      include: { project: true },
    });

    const now = new Date();
    const isExpired = record?.expiresAt != null && record.expiresAt < now;

    if (!record || record.revokedAt || isExpired) {
      throw new HTTPException(401, { message: "Invalid or expired API key" });
    }

    c.set("project", {
      id: record.project.id,
      name: record.project.name,
      slug: record.project.slug,
      keyKind: "PUBLIC",
      apiKeyId: record.id,
    });

    prisma.apiKey
      .update({
        where: { id: record.id },
        data: { lastUsedAt: now },
      })
      .catch((err) =>
        console.error("[api-key-auth] lastUsedAt update:", err),
      );

    await next();
  };
}
