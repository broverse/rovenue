import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { createId } from "@paralleldrive/cuid2";
import { drizzle } from "@rovenue/db";
import { API_KEY_KIND } from "@rovenue/shared";

// =============================================================
// POST /v1/events — public ingest with identityContext forwarding
// =============================================================
//
// Accepts SDK-originated events and writes them directly to the
// outbox so the integrations-dispatch pipeline can fan them out
// to Meta CAPI / TikTok Events.
//
// Authentication: PUBLIC API key (rov_pub_*). The route is mounted
// under /v1 which runs `apiKeyAuth("any")` globally; we enforce
// public-only via `requirePublicApiKey` below.
//
// Aggregate type mapping:
//   "revenue.*" prefix → REVENUE_EVENT
//   everything else    → BILLING
//
// The raw validated body is stored as the outbox payload without
// re-wrapping so downstream consumers (processFanoutMessage) can
// read payload.identityContext directly.

// =============================================================
// Route-level guard — public key only
// =============================================================

const requirePublicApiKey: import("hono").MiddlewareHandler = async (
  c,
  next,
) => {
  const project = c.get("project");
  if (project?.keyKind !== API_KEY_KIND.PUBLIC) {
    throw new HTTPException(403, { message: "Public API key required" });
  }
  await next();
};

// =============================================================
// Zod schemas
// =============================================================

const identityContextSchema = z
  .object({
    email: z.string().min(1).optional(),
    externalId: z.string().min(1).optional(),
    phone: z.string().min(1).optional(),
    ip: z.string().min(1).optional(),
    userAgent: z.string().min(1).optional(),
    firstName: z.string().min(1).optional(),
    lastName: z.string().min(1).optional(),
    city: z.string().min(1).optional(),
    countryCode: z.string().min(1).optional(),
  })
  .strict();

export const eventEnvelopeSchema = z
  .object({
    eventType: z.string().min(1),
    occurredAt: z.string().datetime(),
    subscriberId: z.string().min(1).optional(),
    productId: z.string().min(1).optional(),
    amount: z
      .string()
      .regex(/^-?\d+(\.\d+)?$/, "amount must be a decimal string")
      .optional(),
    currency: z.string().length(3).optional(),
    eventSourceUrl: z.string().url().optional(),
    identityContext: identityContextSchema.optional(),
  })
  .strict();

export type EventEnvelopeBody = z.infer<typeof eventEnvelopeSchema>;

// =============================================================
// Aggregate type derivation
// =============================================================

function deriveAggregateType(
  eventType: string,
): "REVENUE_EVENT" | "BILLING" {
  return eventType.startsWith("revenue.") ? "REVENUE_EVENT" : "BILLING";
}

// =============================================================
// Route
// =============================================================

export const eventsRoute = new Hono()
  .post(
    "/",
    requirePublicApiKey,
    zValidator("json", eventEnvelopeSchema),
    async (c) => {
      const project = c.get("project");
      const body = c.req.valid("json");

      const aggregateType = deriveAggregateType(body.eventType);
      const id = createId();

      await drizzle.outboxRepo.insert(drizzle.db, {
        id,
        aggregateType,
        aggregateId: project.id,
        eventType: body.eventType,
        payload: body as Record<string, unknown>,
      });

      return c.body(null, 202);
    },
  );
