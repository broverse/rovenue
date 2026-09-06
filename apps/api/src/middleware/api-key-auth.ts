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
  keyKind: ApiKeyKind;
  apiKeyId: string;
  /**
   * The publishable identifier of the key this request authenticated with.
   *
   * Carried so the browser surface can assert that the key in the URL is the
   * same key that authenticated — without that, the two are independent and
   * the origin allow-list stops meaning anything.
   */
  keyPublic: string;
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

/**
 * Marks a middleware as an `apiKeyAuth()` registration.
 *
 * `apiKeyAuth()` is a factory, so every call site produces a *different*
 * closure and reference equality (the trick `requireSecretKey` /
 * `requirePublicApiKey` rely on) cannot find it. Without a tag, a route
 * walker has to infer "is this path behind the key envelope?" from the
 * literal string `/v1/*`, which silently mis-states the auth posture of
 * anything mounted outside `v1Route` — and there are two such endpoints
 * (`/v1/config/stream`, `/v1/preview/paywalls/:token`), with opposite
 * answers.
 *
 * `Symbol.for()` rather than `Symbol()` for the same reason as
 * `ROUTE_SCHEMA_TAG` in lib/validate.ts: two copies of this module in one
 * graph must agree on the key.
 */
export const API_KEY_AUTH_TAG = Symbol.for("rovenue.api.apiKeyAuthTag");

export interface ApiKeyAuthTag {
  required: ApiKeyRequirement;
}

/** Recovers the `{ required }` tag an `apiKeyAuth()` middleware carries. */
export function getApiKeyAuthTag(
  handler: unknown,
): ApiKeyAuthTag | undefined {
  if (typeof handler !== "function") return undefined;
  return (handler as unknown as Record<symbol, unknown>)[API_KEY_AUTH_TAG] as
    | ApiKeyAuthTag
    | undefined;
}

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
  const middleware: MiddlewareHandler = async (c, next) => {
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
      keyKind: detected,
      apiKeyId: record.id,
      keyPublic: record.keyPublic,
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

  // Non-enumerable, symbol-keyed: metadata for the route walker, not part
  // of the middleware's public shape. Same rationale as ROUTE_SCHEMA_TAG.
  Object.defineProperty(middleware, API_KEY_AUTH_TAG, {
    value: { required } satisfies ApiKeyAuthTag,
    enumerable: false,
    configurable: true,
  });

  return middleware;
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

/**
 * Route-level guard that runs after `apiKeyAuth` and enforces that the
 * authenticated caller presented a PUBLIC key. Used for SDK-facing
 * endpoints (e.g. /v1/events, /v1/sdk/sessions) that are mounted under
 * /v1 alongside secret-key routes and must reject secret keys.
 *
 * A single shared export (rather than an independently-declared closure
 * per route file) so a route walk can detect this guard by reference
 * equality, the same way `requireSecretKey` already is.
 */
export const requirePublicApiKey: MiddlewareHandler = async (c, next) => {
  const project = c.get("project");
  if (project?.keyKind !== API_KEY_KIND.PUBLIC) {
    throw new HTTPException(403, { message: "Public API key required" });
  }
  await next();
};
