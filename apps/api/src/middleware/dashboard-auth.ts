import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { auth } from "../lib/auth";

type DashboardSessionResult = NonNullable<
  Awaited<ReturnType<typeof auth.api.getSession>>
>;
type DashboardUser = DashboardSessionResult["user"];
type DashboardSession = DashboardSessionResult["session"];

declare module "hono" {
  interface ContextVariableMap {
    user: DashboardUser;
    session: DashboardSession;
  }
}

export const requireDashboardAuth: MiddlewareHandler = async (c, next) => {
  const session = await auth.api.getSession({ headers: c.req.raw.headers });

  if (!session) {
    throw new HTTPException(401, { message: "Unauthorized" });
  }

  c.set("user", session.user);
  c.set("session", session.session);

  await next();
};
