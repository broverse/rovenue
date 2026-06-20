import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { validate } from "../../lib/validate";
import { z } from "zod";
import { FeatureFlagEnv } from "@rovenue/db";
import { attributesBodySchema } from "@rovenue/shared";
import { evaluateSubscriberConfig } from "../../services/subscriber-config";
import { ok } from "../../lib/response";

// =============================================================
// GET / POST /v1/config
// =============================================================
//
// Unified bootstrap endpoint for the SDK. One request returns
// every feature flag + experiment assignment for the given
// subscriber, so the SDK can cache the response locally (MMKV)
// and decide UI behaviour without a round-trip per decision.
//
// GET is the lightweight path — only subscriberId identity is
// required. POST carries runtime attributes (country, platform,
// appVersion, custom fields) that get merged with whatever is
// stored on the Subscriber row so audience targeting has the
// freshest picture.
//
// Route handlers are chained on a single `new Hono()` expression
// and the POST body passes through `validate("json", …)` so
// the AppType export at apps/api/src/app.ts carries both the
// request body + response shape into downstream RPC consumers:
//
//   await client.v1.config.$post({ json: { attributes: {…} } })
//     // body is typechecked against configBodySchema

export const SUBSCRIBER_HEADER = "x-rovenue-user-id";
const ENV_HEADER = "x-rovenue-env";

const ENV_LOOKUP: Record<string, FeatureFlagEnv> = {
  prod: FeatureFlagEnv.PROD,
  production: FeatureFlagEnv.PROD,
  PROD: FeatureFlagEnv.PROD,
  PRODUCTION: FeatureFlagEnv.PROD,
  staging: FeatureFlagEnv.STAGING,
  STAGING: FeatureFlagEnv.STAGING,
  development: FeatureFlagEnv.DEVELOPMENT,
  dev: FeatureFlagEnv.DEVELOPMENT,
  DEVELOPMENT: FeatureFlagEnv.DEVELOPMENT,
  DEV: FeatureFlagEnv.DEVELOPMENT,
};

export function resolveEnv(c: Context): FeatureFlagEnv {
  const raw = c.req.query("env") ?? c.req.header(ENV_HEADER) ?? "";
  if (raw.length === 0) return FeatureFlagEnv.PROD;
  const mapped = ENV_LOOKUP[raw];
  if (!mapped) {
    throw new HTTPException(400, {
      message: "env must be one of prod, staging, development",
    });
  }
  return mapped;
}

export const configBodySchema = z.object({
  attributes: attributesBodySchema.shape.attributes.optional(),
});

export type ConfigBody = z.infer<typeof configBodySchema>;

export function resolveSubscriberId(c: Context): string | null {
  return (
    c.req.query("subscriberId") ??
    c.req.header(SUBSCRIBER_HEADER) ??
    null
  );
}

async function handleConfig(
  c: Context,
  requestAttributes: Record<string, string | null>,
) {
  const project = c.get("project");
  const appUserId = resolveSubscriberId(c);
  if (!appUserId) {
    throw new HTTPException(400, {
      message:
        "subscriberId is required (via query param or X-Rovenue-User-Id header)",
    });
  }

  const { flags, experiments } = await evaluateSubscriberConfig({
    projectId: project.id,
    appUserId,
    env: resolveEnv(c),
    requestAttributes,
  });

  return c.json(ok({ flags, experiments }));
}

export const configRoute = new Hono()
  .get("/", (c) => handleConfig(c, {}))
  .post("/", validate("json", configBodySchema), (c) => {
    const body = c.req.valid("json");
    return handleConfig(c, body.attributes ?? {});
  });
