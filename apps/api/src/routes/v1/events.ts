import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { validate } from "../../lib/validate";
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
    // Wire format version (EVENT_WIRE_VERSION). Optional for backwards-compat
    // with SDKs predating the versioned envelope; current SDKs always send 1.
    version: z.literal(1).optional(),
    // Stable client-generated id, reused across SDK retries so downstream
    // fan-out (Meta CAPI / TikTok) can dedupe on it and avoid double-counting.
    eventId: z.string().min(1).optional(),
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
    // Present on `paywall_view` (and future paywall-lifecycle) events so
    // the CH paywall funnel can attribute a view to the placement/paywall
    // (and, when the placement resolved to an experiment row, the variant)
    // that served it. Opaque strings — never validated against live rows,
    // mirroring receipt `presentedContext` (attribution must not fail the
    // event write).
    paywallContext: z
      .object({
        paywallId: z.string().min(1),
        placementId: z.string().min(1),
        placementRevision: z.number().int().positive(),
        variantId: z.string().min(1).optional(),
        experimentKey: z.string().min(1).optional(),
      })
      .optional(),
  })
  .strict()
  .superRefine((body, ctx) => {
    // A paywall_* event without its attribution payload would flow to the
    // ClickHouse pipeline as an all-empty ('','') row — reject it up-front.
    // Rovenue SDKs always attach paywallContext (or skip the event entirely).
    // Covers paywall_view AND paywall_close (and any future paywall_*
    // lifecycle event) — see deriveAggregateType below for the same prefix.
    if (body.eventType.startsWith("paywall_") && !body.paywallContext) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paywallContext"],
        message: "paywallContext is required for paywall_* events",
      });
    }
  });

export type EventEnvelopeBody = z.infer<typeof eventEnvelopeSchema>;

// =============================================================
// Aggregate type derivation
// =============================================================

function deriveAggregateType(
  eventType: string,
): "REVENUE_EVENT" | "BILLING" | "PAYWALL_EVENT" {
  if (eventType.startsWith("paywall_")) return "PAYWALL_EVENT";
  return eventType.startsWith("revenue.") ? "REVENUE_EVENT" : "BILLING";
}

// =============================================================
// Route
// =============================================================

export const eventsRoute = new Hono()
  .post(
    "/",
    requirePublicApiKey,
    validate("json", eventEnvelopeSchema),
    async (c) => {
      const project = c.get("project");
      const body = c.req.valid("json");

      const aggregateType = deriveAggregateType(body.eventType);
      const id = createId();

      // paywall_* events ONLY (paywall_view, paywall_close, ...): resolve the
      // SDK wire id (rovenueId) to the owned subscriber.id BEFORE the outbox
      // write, so the ClickHouse paywall rows land in the same identity
      // space as raw_revenue_events (which is keyed by subscriber.id
      // everywhere) — otherwise the placement purchases/CR join can never
      // match. Deliberately NOT done for other event types: their payloads
      // flow raw into the integrations fan-out, which expects the wire
      // identity untouched.
      let payload: Record<string, unknown> = body as Record<string, unknown>;
      if (body.eventType.startsWith("paywall_") && body.subscriberId) {
        const subscriber = await drizzle.subscriberRepo.upsertSubscriber(drizzle.db, {
          projectId: project.id,
          rovenueId: body.subscriberId,
          createAttributes: {},
        });
        payload = { ...payload, subscriberId: subscriber.id };
      }

      await drizzle.outboxRepo.insert(drizzle.db, {
        id,
        aggregateType,
        aggregateId: project.id,
        eventType: body.eventType,
        payload,
      });

      return c.body(null, 202);
    },
  );
