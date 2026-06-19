import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { HEADER, parseSdkPlatform } from "@rovenue/shared";
import type { Subscriber } from "@rovenue/db";
import { resolveOrCreateSubscriber } from "../lib/resolve-or-create-subscriber";

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
  // First-install platform (ios/android/web). Only persisted when the
  // subscriber is created on this call; ignored for existing subscribers.
  const platform = parseSdkPlatform(c.req.header(HEADER.X_ROVENUE_PLATFORM));
  const subscriber = await resolveOrCreateSubscriber(project.id, key, platform);
  c.set("subscriber", subscriber);
  await next();
};
