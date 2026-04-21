import { Hono, type Context } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import prisma, { drizzle, type Prisma } from "@rovenue/db";
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

export const configBodySchema = z.object({
  attributes: z.record(z.unknown()).optional(),
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
  requestAttributes: Record<string, unknown>,
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
  // into the stored set instead of overwriting. A subscriber who
  // moves from country=TR to country=US must be reflected in both
  // the evaluation path AND the stored attributes, otherwise the
  // dashboard's "subscribers with country=TR" view goes stale.
  //
  // Cutover: this read is Drizzle-only after Phase 5. Shadow
  // reads against the dashboard list + config attribute fetch
  // ran clean for a full cycle; the Prisma caller is removed.
  // Writes (upsert below) stay on Prisma until Phase 6.
  const existing = await drizzle.subscriberRepo.findSubscriberAttributes(
    drizzle.db,
    { projectId: project.id, appUserId },
  );
  const mergedAttributes: Record<string, unknown> = {
    ...((existing?.attributes as Record<string, unknown> | null) ?? {}),
    ...requestAttributes,
  };

  const hasNewAttributes = Object.keys(requestAttributes).length > 0;
  const subscriber = await prisma.subscriber.upsert({
    where: {
      projectId_appUserId: { projectId: project.id, appUserId },
    },
    create: {
      projectId: project.id,
      appUserId,
      attributes: requestAttributes as Prisma.InputJsonValue,
    },
    update: {
      lastSeenAt: new Date(),
      ...(hasNewAttributes && {
        attributes: mergedAttributes as Prisma.InputJsonValue,
      }),
    },
  });

  const [flags, experiments] = await Promise.all([
    evaluateAllFlags(project.id, subscriber.id, mergedAttributes),
    evaluateExperiments(project.id, subscriber.id, mergedAttributes),
  ]);

  return c.json(ok({ flags, experiments }));
}

export const configRoute = new Hono()
  .get("/", (c) => handleConfig(c, {}))
  .post("/", zValidator("json", configBodySchema), (c) => {
    const body = c.req.valid("json");
    return handleConfig(c, body.attributes ?? {});
  });
