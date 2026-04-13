import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  API_KEY_KIND,
  API_KEY_PREFIX,
  BEARER_SCHEME,
  HEADER,
  type ApiKeyKind,
} from "@rovenue/shared";
import prisma from "@rovenue/db";
import { logger } from "../lib/logger";

const log = logger.child("api-key-auth");

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

const BEARER_PREFIX_LOWER = `${BEARER_SCHEME.toLowerCase()} `;

function detectKind(rawKey: string): ApiKeyKind | null {
  if (rawKey.startsWith(API_KEY_PREFIX[API_KEY_KIND.PUBLIC])) {
    return API_KEY_KIND.PUBLIC;
  }
  if (rawKey.startsWith(API_KEY_PREFIX[API_KEY_KIND.SECRET])) {
    return API_KEY_KIND.SECRET;
  }
  return null;
}

export type ApiKeyRequirement = ApiKeyKind | "any";

export function apiKeyAuth(
  required: ApiKeyRequirement = "any",
): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header(HEADER.AUTHORIZATION);
    if (!header || !header.toLowerCase().startsWith(BEARER_PREFIX_LOWER)) {
      throw new HTTPException(401, { message: "Bearer token required" });
    }

    const rawKey = header.slice(BEARER_PREFIX_LOWER.length).trim();
    const detected = detectKind(rawKey);
    if (!detected) {
      throw new HTTPException(401, { message: "Invalid API key format" });
    }

    if (required !== "any" && detected !== required) {
      throw new HTTPException(403, {
        message: `${required.toLowerCase()} API key required`,
      });
    }

    // Public keys are stored plaintext and indexed for direct lookup.
    // Secret keys are bcrypted — verification needs a lookup convention
    // (e.g. key-id prefix) that isn't wired yet.
    if (detected !== API_KEY_KIND.PUBLIC) {
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
      keyKind: API_KEY_KIND.PUBLIC,
      apiKeyId: record.id,
    });

    prisma.apiKey
      .update({
        where: { id: record.id },
        data: { lastUsedAt: now },
      })
      .catch((err: unknown) => {
        log.warn("lastUsedAt update failed", {
          apiKeyId: record.id,
          err: err instanceof Error ? err.message : String(err),
        });
      });

    await next();
  };
}
