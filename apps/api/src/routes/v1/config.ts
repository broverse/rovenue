import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { FeatureFlagEnv, drizzle } from "@rovenue/db";
import {
  attributesBodySchema,
  applyMutations,
  flattenAttributes,
  normalizeStored,
} from "@rovenue/shared";
import { evaluateAllFlags } from "../../services/flag-engine";
import { evaluateExperiments } from "../../services/experiment-engine";
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
// and the POST body passes through `zValidator("json", …)` so
// the AppType export at apps/api/src/app.ts carries both the
// request body + response shape into downstream RPC consumers:
//
//   await client.v1.config.$post({ json: { attributes: {…} } })
//     // body is typechecked against configBodySchema

const SUBSCRIBER_HEADER = "x-rovenue-user-id";
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

function resolveEnv(c: Context): FeatureFlagEnv {
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

function resolveSubscriberId(c: Context): string | null {
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

  // Read-then-upsert so we can merge request-supplied attributes
  // into the stored nested set instead of overwriting. We persist the
  // nested shape and pass a FLAT projection to flag/experiment
  // evaluation so the engines keep receiving flat maps.
  const existing =
    await drizzle.subscriberRepo.findSubscriberAttributesByRovenueId(
      drizzle.db,
      { projectId: project.id, rovenueId: appUserId },
    );
  const currentNested = normalizeStored(existing?.attributes);
  const hasNewAttributes = Object.keys(requestAttributes).length > 0;
  const now = new Date().toISOString();
  const mergedNested = applyMutations(currentNested, requestAttributes, "sdk", now);
  const evalAttributes = flattenAttributes(mergedNested);

  const subscriber = await drizzle.subscriberRepo.upsertSubscriber(
    drizzle.db,
    {
      projectId: project.id,
      rovenueId: appUserId,
      createAttributes: mergedNested,
      ...(hasNewAttributes && { updateAttributes: mergedNested }),
    },
  );

  const env = resolveEnv(c);
  const [flags, experiments] = await Promise.all([
    evaluateAllFlags(project.id, env, subscriber.id, evalAttributes),
    evaluateExperiments(project.id, subscriber.id, evalAttributes),
  ]);

  return c.json(ok({ flags, experiments }));
}

export const configRoute = new Hono()
  .get("/", (c) => handleConfig(c, {}))
  .post("/", zValidator("json", configBodySchema), (c) => {
    const body = c.req.valid("json");
    return handleConfig(c, body.attributes ?? {});
  });
