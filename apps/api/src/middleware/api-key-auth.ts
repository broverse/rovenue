import bcrypt from "bcryptjs";
import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import {
  API_KEY_KIND,
  API_KEY_PREFIX,
  BEARER_SCHEME,
  HEADER,
  type ApiKeyKind,
} from "@rovenue/shared";
import { drizzle } from "@rovenue/db";
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

/**
 * Secret API key token layout: `rov_sec_<apiKeyId>_<random>`
 *
 * We encode the ApiKey row id in the token so we can do an indexed lookup
 * before running the expensive bcrypt comparison — otherwise every request
 * would have to iterate all non-revoked secrets and bcrypt each one.
 */
function parseSecretKeyId(rawKey: string): string | null {
  const body = rawKey.slice(API_KEY_PREFIX[API_KEY_KIND.SECRET].length);
  const delimiter = body.indexOf("_");
  if (delimiter <= 0) return null;
  return body.slice(0, delimiter);
}

export type ApiKeyRequirement = ApiKeyKind | "any";

type ApiKeyRecord = Awaited<
  ReturnType<typeof drizzle.apiKeyRepo.findApiKeyByPublic>
>;

async function lookupPublicKey(rawKey: string): Promise<ApiKeyRecord> {
  return drizzle.apiKeyRepo.findApiKeyByPublic(drizzle.db, rawKey);
}

async function lookupSecretKey(rawKey: string): Promise<ApiKeyRecord> {
  const keyId = parseSecretKeyId(rawKey);
  if (!keyId) return null;

  const record = await drizzle.apiKeyRepo.findApiKeyById(drizzle.db, keyId);
  if (!record) return null;

  const valid = await bcrypt.compare(rawKey, record.keySecretHash);
  return valid ? record : null;
}

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

    const record =
      detected === API_KEY_KIND.PUBLIC
        ? await lookupPublicKey(rawKey)
        : await lookupSecretKey(rawKey);

    const now = new Date();
    const isExpired = record?.expiresAt != null && record.expiresAt < now;
    if (!record || record.revokedAt || isExpired) {
      throw new HTTPException(401, { message: "Invalid or expired API key" });
    }

    c.set("project", {
      id: record.project.id,
      name: record.project.name,
      slug: record.project.slug,
      keyKind: detected,
      apiKeyId: record.id,
    });

    // Fire-and-forget last-used touch.
    drizzle.apiKeyRepo
      .updateApiKeyLastUsed(drizzle.db, record.id, now)
      .catch((err: unknown) => {
        log.warn("lastUsedAt update failed", {
          apiKeyId: record.id,
          err: err instanceof Error ? err.message : String(err),
        });
      });

    await next();
  };
}

/**
 * Route-level guard that runs after `apiKeyAuth` and enforces that the
 * authenticated caller presented a SECRET key. Used for server-side-only
 * endpoints like credit grants.
 */
export const requireSecretKey: MiddlewareHandler = async (c, next) => {
  const project = c.get("project");
  if (project?.keyKind !== API_KEY_KIND.SECRET) {
    throw new HTTPException(403, { message: "Secret API key required" });
  }
  await next();
};
