import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";

export type ApiKeyKind = "public" | "secret";

export interface AuthContext {
  apiKey: string;
  kind: ApiKeyKind;
}

declare module "hono" {
  interface ContextVariableMap {
    auth: AuthContext;
  }
}

export function apiKeyAuth(kind: ApiKeyKind = "secret"): MiddlewareHandler {
  return async (c, next) => {
    const headerKey =
      c.req.header("x-api-key") ??
      c.req.header("authorization")?.replace(/^Bearer\s+/i, "");

    if (!headerKey) {
      throw new HTTPException(401, { message: "API key required" });
    }

    // TODO: look up the project by API key via @rovenue/db and verify `kind`
    c.set("auth", { apiKey: headerKey, kind });

    await next();
  };
}
