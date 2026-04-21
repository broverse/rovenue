import type { MiddlewareHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import type Stripe from "stripe";
import { z } from "zod";
import { BEARER_SCHEME, HEADER } from "@rovenue/shared";
import { env } from "../lib/env";
import { logger } from "../lib/logger";
import {
  loadAppleCredentials,
  loadStripeCredentials,
} from "../lib/project-credentials";
import {
  createAppleVerifier,
  decodeUnverifiedJws,
  JoseAppleNotificationVerifier,
  type AppleNotificationVerifier,
} from "../services/apple/apple-verify";
import type {
  AppleEnvironment,
  AppleResponseBodyV2DecodedPayload,
} from "../services/apple/apple-types";
import { verifyPubSubPushToken } from "../services/google/google-auth";
import { STRIPE_SIGNATURE_HEADER } from "../services/stripe/stripe-types";
import { getStripeClient } from "../services/stripe/stripe-webhook";

// =============================================================
// Webhook signature verification middleware
// =============================================================
//
// Each store exposes a dedicated middleware that verifies the
// request at the edge before it hits the BullMQ queue. On failure
// we return 401 + log so operators can diagnose — and malicious
// retries don't poison the queue. On success the verified payload
// is stashed on the Hono context for the route handler to consume.
//
// Retry semantics:
//   - Stripe: 401 tells Stripe we rejected the delivery. It will
//     retry a few times and then give up — which is fine for a
//     genuinely bad signature (operator misconfig needs fixing).
//   - Apple: 401 causes Apple to retry for up to 3 days. Signature
//     failures in production usually mean rotation or bundle-id
//     mismatch, and we want those retries so the fix gets picked up.
//   - Google Pub/Sub: 401 causes Pub/Sub to redeliver until the
//     subscription's retry policy expires — desirable for transient
//     audience misconfig, harmless for forged traffic.

const log = logger.child("webhook-verify");

// =============================================================
// Shared context type
// =============================================================

interface VerifiedApple {
  source: "APPLE";
  signedPayload: string;
  notification: AppleResponseBodyV2DecodedPayload;
}
interface VerifiedGoogle {
  source: "GOOGLE";
}
interface VerifiedStripe {
  source: "STRIPE";
  rawBody: string;
  event: Stripe.Event;
}

export type VerifiedWebhook = VerifiedApple | VerifiedGoogle | VerifiedStripe;

declare module "hono" {
  interface ContextVariableMap {
    verifiedWebhook?: VerifiedWebhook;
    webhookEventId?: string;
    webhookEventTimestamp?: number;
  }
}

// =============================================================
// Apple — JWS + x5c chain validation
// =============================================================

const appleBodySchema = z.object({ signedPayload: z.string().min(1) });

function requireProjectId(param: string | undefined): string {
  if (!param) {
    throw new HTTPException(400, { message: "Missing projectId route param" });
  }
  return param;
}

export const verifyAppleWebhook: MiddlewareHandler = async (c, next) => {
  const projectId = requireProjectId(c.req.param("projectId"));

  let body: z.infer<typeof appleBodySchema>;
  try {
    body = appleBodySchema.parse(await c.req.json());
  } catch {
    throw new HTTPException(400, {
      message: "Invalid Apple webhook body: signedPayload required",
    });
  }

  // Peek at the unverified payload to pick the right environment for
  // the verifier. If decode fails we let downstream verification fail
  // with a proper error.
  let environment: AppleEnvironment | undefined;
  try {
    const peek = decodeUnverifiedJws<AppleResponseBodyV2DecodedPayload>(
      body.signedPayload,
    );
    environment = peek.data?.environment;
  } catch {
    // ignore — verifier will reject it
  }

  const creds = await loadAppleCredentials(projectId);

  let verifier: AppleNotificationVerifier;
  if (creds) {
    verifier = createAppleVerifier({
      projectId,
      bundleId: creds.bundleId,
      appAppleId: creds.appAppleId,
      environment,
    });
  } else if (env.NODE_ENV === "production") {
    log.warn("apple webhook rejected: no project credentials in production", {
      projectId,
    });
    throw new HTTPException(401, {
      message: "Apple webhook verification unavailable",
    });
  } else {
    log.warn("apple webhook: no project credentials, using jose fallback", {
      projectId,
    });
    verifier = new JoseAppleNotificationVerifier();
  }

  let notification: AppleResponseBodyV2DecodedPayload;
  try {
    notification = await verifier.verifyNotification(body.signedPayload);
  } catch (err) {
    log.warn("apple JWS verification failed", {
      projectId,
      err: err instanceof Error ? err.message : String(err),
    });
    throw new HTTPException(401, { message: "Invalid Apple signature" });
  }

  c.set("verifiedWebhook", {
    source: "APPLE",
    signedPayload: body.signedPayload,
    notification,
  });
  c.set("webhookEventId", notification.notificationUUID);
  c.set(
    "webhookEventTimestamp",
    Math.floor(new Date(notification.signedDate).getTime() / 1000),
  );
  await next();
};

// =============================================================
// Google — Pub/Sub push OIDC bearer token
// =============================================================

export const verifyGoogleWebhook: MiddlewareHandler = async (c, next) => {
  // Peek the body first so dev-mode and prod-mode both populate the
  // ctx vars the downstream replay guard depends on. Use clone() so
  // the downstream zValidator can still read c.req.raw. Swallow JSON
  // parse errors so malformed bodies fall through to the descriptive
  // missing-fields 400 below rather than crashing the middleware.
  const body = (await c.req.raw
    .clone()
    .json()
    .catch(() => ({}))) as {
    message?: { messageId?: string; publishTime?: string };
  };
  const messageId = body.message?.messageId;
  const publishTime = body.message?.publishTime;
  if (!messageId || !publishTime) {
    log.warn("google webhook rejected: body missing messageId/publishTime");
    throw new HTTPException(400, {
      message: "Google push body missing message.messageId or publishTime",
    });
  }

  // Dev fast-path: PUBSUB_PUSH_AUDIENCE is required in production
  // (enforced by env.ts). In dev/test we skip identity verification
  // so local testing works without a Google Cloud setup — but we
  // still stash ctx so the replay guard and downstream handler work
  // the same way as prod.
  if (!env.PUBSUB_PUSH_AUDIENCE) {
    log.debug("google webhook: PUBSUB_PUSH_AUDIENCE unset, skipping verify");
    c.set("verifiedWebhook", { source: "GOOGLE" });
    c.set("webhookEventId", messageId);
    c.set(
      "webhookEventTimestamp",
      Math.floor(new Date(publishTime).getTime() / 1000),
    );
    await next();
    return;
  }

  const header = c.req.header(HEADER.AUTHORIZATION);
  const prefix = `${BEARER_SCHEME.toLowerCase()} `;
  if (!header || !header.toLowerCase().startsWith(prefix)) {
    log.warn("google webhook rejected: missing Bearer token");
    throw new HTTPException(401, { message: "Pub/Sub Bearer token required" });
  }

  const idToken = header.slice(prefix.length).trim();
  try {
    await verifyPubSubPushToken(idToken, {
      audience: env.PUBSUB_PUSH_AUDIENCE,
      serviceAccountEmail: env.PUBSUB_PUSH_SERVICE_ACCOUNT,
    });
  } catch (err) {
    log.warn("pubsub token verification failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    throw new HTTPException(401, { message: "Invalid Pub/Sub token" });
  }

  c.set("verifiedWebhook", { source: "GOOGLE" });
  c.set("webhookEventId", messageId);
  c.set(
    "webhookEventTimestamp",
    Math.floor(new Date(publishTime).getTime() / 1000),
  );
  await next();
};

// =============================================================
// Stripe — Stripe-Signature HMAC with 300s tolerance
// =============================================================

const STRIPE_TOLERANCE_SECONDS = 300;

export const verifyStripeWebhook: MiddlewareHandler = async (c, next) => {
  const projectId = requireProjectId(c.req.param("projectId"));

  const signature = c.req.header(STRIPE_SIGNATURE_HEADER);
  if (!signature) {
    log.warn("stripe webhook rejected: missing Stripe-Signature header", {
      projectId,
    });
    throw new HTTPException(401, {
      message: "Missing Stripe-Signature header",
    });
  }

  const credentials = await loadStripeCredentials(projectId);
  if (!credentials) {
    log.warn("stripe webhook rejected: no project credentials", { projectId });
    throw new HTTPException(401, {
      message: "Project not configured for Stripe",
    });
  }

  const rawBody = await c.req.text();
  const stripe = getStripeClient(credentials.secretKey);

  let event: Stripe.Event;
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      signature,
      credentials.webhookSecret,
      STRIPE_TOLERANCE_SECONDS,
    );
  } catch (err) {
    log.warn("stripe signature verification failed", {
      projectId,
      err: err instanceof Error ? err.message : String(err),
    });
    throw new HTTPException(401, { message: "Invalid Stripe signature" });
  }

  c.set("verifiedWebhook", { source: "STRIPE", rawBody, event });
  c.set("webhookEventId", event.id);
  c.set("webhookEventTimestamp", event.created);
  await next();
};
