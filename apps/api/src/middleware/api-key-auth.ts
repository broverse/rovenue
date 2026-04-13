import { createHash } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import prisma from "@rovenue/db";

export type ApiKeyKind = "PUBLIC" | "SECRET";

export interface AuthenticatedProject {
  id: string;
  name: string;
  keyKind: ApiKeyKind;
}

declare module "hono" {
  interface ContextVariableMap {
    project: AuthenticatedProject;
  }
}

function hashKey(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
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

    const record = await prisma.apiKey.findUnique({
      where: { keyHash: hashKey(rawKey) },
      include: { project: true },
    });

    if (!record || record.revokedAt) {
      throw new HTTPException(401, { message: "Invalid API key" });
    }

    if (record.kind !== detected) {
      throw new HTTPException(401, { message: "Key kind mismatch" });
    }

    c.set("project", {
      id: record.project.id,
      name: record.project.name,
      keyKind: record.kind,
    });

    // Best-effort last-used touch; don't block the request if it fails.
    prisma.apiKey
      .update({
        where: { id: record.id },
        data: { lastUsedAt: new Date() },
      })
      .catch((err) => console.error("[api-key-auth] lastUsedAt update:", err));

    await next();
  };
}
