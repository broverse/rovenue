import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { WebhookSource, drizzle } from "@rovenue/db";
import { sql } from "drizzle-orm";
import { getStoreCircuits, type CircuitBreakerStats } from "../lib/circuit-breaker";
import { redis } from "../lib/redis";
import { loadAppleCredentials, loadGoogleCredentials } from "../lib/project-credentials";
import { chargesEnabled, getConnectedStripe } from "../lib/stripe-platform";
import { getWebhookQueue } from "../services/webhook-processor";
import { getDeliveryQueue } from "../workers/webhook-delivery";
import { getFxQueue, isFxStale } from "../services/fx";
import { requireDashboardAuth } from "../middleware/dashboard-auth";
import { assertProjectAccess } from "../lib/project-access";
import { ok } from "../lib/response";
import { logger } from "../lib/logger";

export const API_VERSION = "0.1.0";

const log = logger.child("health");

export const healthRoute = new Hono();

// =============================================================
// GET /health — liveness probe
// =============================================================
//
// Returns 200 whenever the process is alive. Never touches the DB
// or Redis — used by container orchestrators that just want to know
// if the process is still responding.

healthRoute.get("/", (c) => {
  return c.json(ok({ status: "ok" as const, version: API_VERSION }));
});

// =============================================================
// GET /health/ready — readiness probe
// =============================================================
//
// Probes every external dependency the API needs to serve real
// traffic. Returns 503 if any dependency is unreachable so the
// load balancer stops routing to this instance while the deps
// recover.

type CheckStatus = "ok" | "down";
type OverallStatus = "ok" | "degraded" | "down";

interface CheckResult {
  status: CheckStatus;
  latencyMs: number;
  error?: string;
}

interface QueueCheckResult extends CheckResult {
  activeJobs: number;
  waitingJobs: number;
}

async function measure<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; latencyMs: number }> {
  const start = Date.now();
  const value = await fn();
  return { value, latencyMs: Date.now() - start };
}

async function checkDatabase(): Promise<CheckResult> {
  try {
    const { latencyMs } = await measure(() =>
      drizzle.db.execute(sql`SELECT 1`),
    );
    return { status: "ok", latencyMs };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn("database health check failed", { err: error });
    return { status: "down", latencyMs: 0, error };
  }
}

async function checkRedis(): Promise<CheckResult> {
  try {
    const { value, latencyMs } = await measure(() => redis.ping());
    if (value !== "PONG") {
      return {
        status: "down",
        latencyMs,
        error: `unexpected ping response: ${value}`,
      };
    }
    return { status: "ok", latencyMs };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn("redis health check failed", { err: error });
    return { status: "down", latencyMs: 0, error };
  }
}

async function checkQueue(
  name: string,
  getQueue: () => { getJobCounts: (...args: any[]) => Promise<Record<string, number>> },
): Promise<QueueCheckResult & { name: string }> {
  try {
    const { value, latencyMs } = await measure(() =>
      getQueue().getJobCounts("active", "waiting"),
    );
    return {
      name,
      status: "ok",
      latencyMs,
      activeJobs: value.active ?? 0,
      waitingJobs: value.waiting ?? 0,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    log.warn("queue health check failed", { queue: name, err: error });
    return {
      name,
      status: "down",
      latencyMs: 0,
      activeJobs: 0,
      waitingJobs: 0,
      error,
    };
  }
}

async function checkFxStale(): Promise<CheckResult> {
  try {
    const stale = await isFxStale();
    if (stale) {
      return {
        status: "down",
        latencyMs: 0,
        error: "fx rates have not refreshed in the last 24h",
      };
    }
    return { status: "ok", latencyMs: 0 };
  } catch (err) {
    return {
      status: "down",
      latencyMs: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

healthRoute.get("/ready", async (c) => {
  const [database, redisCheck, webhookQueue, deliveryQueue, fxQueue, fx] =
    await Promise.all([
      checkDatabase(),
      checkRedis(),
      checkQueue("webhook", getWebhookQueue),
      checkQueue("delivery", getDeliveryQueue),
      checkQueue("fx", getFxQueue),
      checkFxStale(),
    ]);

  const queues = [webhookQueue, deliveryQueue, fxQueue];
  const anyDown =
    database.status === "down" ||
    redisCheck.status === "down" ||
    fx.status === "down" ||
    queues.some((q) => q.status === "down");
  const status: OverallStatus = anyDown ? "degraded" : "ok";

  const payload = {
    status,
    checks: {
      database,
      redis: redisCheck,
      queues,
      fx,
    },
    uptime: Math.round(process.uptime()),
  };

  if (anyDown) {
    return c.json(ok(payload), 503);
  }
  return c.json(ok(payload));
});

// =============================================================
// GET /health/stores — per-store health for the dashboard
// =============================================================
//
// Dashboard-auth only. Reports store connection status, the most
// recent successfully processed webhook per store, and whether
// project credentials are present + loadable.

type CredentialStatus = "ok" | "missing" | "invalid";

interface StoreHealth {
  connected: boolean;
  lastWebhookAt: string | null;
  credentialStatus: CredentialStatus;
  circuit: CircuitBreakerStats;
}

/**
 * Stripe reports connection state (Stripe Connect), not credential
 * presence — there's no per-project secret to load anymore. `connected`
 * mirrors "has an active Stripe Connect connection"; `chargesEnabled`
 * additionally surfaces whether Stripe has actually cleared onboarding
 * for card payments (connecting alone isn't enough).
 */
interface StripeStoreHealth extends StoreHealth {
  chargesEnabled: boolean;
}

async function lastProcessedWebhookAt(
  projectId: string,
  source: WebhookSource,
): Promise<string | null> {
  const at = await drizzle.webhookEventRepo.findLastProcessedWebhookAt(
    drizzle.db,
    projectId,
    source,
  );
  return at ? at.toISOString() : null;
}

async function loadStoreHealth<T>(
  loader: () => Promise<T | null>,
): Promise<{ connected: boolean; credentialStatus: CredentialStatus }> {
  try {
    const creds = await loader();
    if (!creds) {
      return { connected: false, credentialStatus: "missing" };
    }
    return { connected: true, credentialStatus: "ok" };
  } catch (err) {
    log.warn("store credential load failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return { connected: false, credentialStatus: "invalid" };
  }
}

async function loadStripeConnectionHealth(
  projectId: string,
): Promise<{
  connected: boolean;
  credentialStatus: CredentialStatus;
  chargesEnabled: boolean;
}> {
  try {
    const connected = await getConnectedStripe(projectId);
    if (!connected) {
      return { connected: false, credentialStatus: "missing", chargesEnabled: false };
    }
    const enabled = await chargesEnabled(projectId);
    return { connected: true, credentialStatus: "ok", chargesEnabled: enabled };
  } catch (err) {
    log.warn("stripe connection health check failed", {
      err: err instanceof Error ? err.message : String(err),
    });
    return { connected: false, credentialStatus: "invalid", chargesEnabled: false };
  }
}

healthRoute.get("/stores", requireDashboardAuth, async (c) => {
  const projectId = c.req.query("projectId");
  if (!projectId) {
    throw new HTTPException(400, { message: "projectId query param required" });
  }

  const user = c.get("user");
  await assertProjectAccess(projectId, user.id);

  const [
    appleCreds,
    googleCreds,
    stripeConnection,
    appleLast,
    googleLast,
    stripeLast,
  ] = await Promise.all([
    loadStoreHealth(() => loadAppleCredentials(projectId)),
    loadStoreHealth(() => loadGoogleCredentials(projectId)),
    loadStripeConnectionHealth(projectId),
    lastProcessedWebhookAt(projectId, WebhookSource.APPLE),
    lastProcessedWebhookAt(projectId, WebhookSource.GOOGLE),
    lastProcessedWebhookAt(projectId, WebhookSource.STRIPE),
  ]);

  const circuits = getStoreCircuits();

  const apple: StoreHealth = { ...appleCreds, lastWebhookAt: appleLast, circuit: circuits.apple! };
  const google: StoreHealth = { ...googleCreds, lastWebhookAt: googleLast, circuit: circuits.google! };
  const stripe: StripeStoreHealth = {
    ...stripeConnection,
    lastWebhookAt: stripeLast,
    circuit: circuits.stripe!,
  };

  return c.json(ok({ apple, google, stripe }));
});
