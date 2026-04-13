import { Hono } from "hono";
import { ok } from "../lib/response";

export const API_VERSION = "0.1.0";

export const healthRoute = new Hono();

healthRoute.get("/", (c) => {
  return c.json(ok({ status: "ok" as const, version: API_VERSION }));
});
