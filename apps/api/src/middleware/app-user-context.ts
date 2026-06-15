import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { HEADER } from "@rovenue/shared";
import type { Subscriber } from "@rovenue/db";
import { resolveSubscriber } from "../lib/resolve-subscriber";

declare module "hono" {
  interface ContextVariableMap {
    subscriber: Subscriber;
  }
}

/**
 * Reads `X-Rovenue-App-User-Id` from the request, resolves the
 * subscriber for the authenticated project, and exposes it on the
 * Hono context. Used by the `/v1/me/*` route family so the SDK can
 * call user-scoped endpoints without repeating appUserId in every
 * path. Requires `apiKeyAuth` to have run first (it reads `project`
 * off the context).
 */
export const appUserContext: MiddlewareHandler = async (c, next) => {
  const project = c.get("project");
  // Carries the device key (the SDK's permanent rovenueId). Header
  // name kept as X-Rovenue-App-User-Id for wire back-compat.
  const key = c.req.header(HEADER.X_ROVENUE_APP_USER_ID)?.trim();
  if (!key) {
    throw new HTTPException(400, {
      message: `${HEADER.X_ROVENUE_APP_USER_ID} header is required`,
    });
  }
  const subscriber = await resolveSubscriber(project.id, key);
  c.set("subscriber", subscriber);
  await next();
};
