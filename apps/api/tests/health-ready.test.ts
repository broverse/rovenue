import { Hono } from "hono";
import { beforeEach, describe, expect, test, vi } from "vitest";

// =============================================================
// Hoisted mocks
// =============================================================

const { prismaMock, drizzleMock, redisMock, queueMock } = vi.hoisted(() => {
  const prismaMock = {
    $queryRaw: vi.fn(async () => [{ "?column?": 1 }]),
    project: {
      findUnique: vi.fn(),
    },
    projectMember: {
      findUnique: vi.fn(),
    },
    webhookEvent: {
      findFirst: vi.fn(),
    },
  };

  // health.ts pings the DB via drizzle.db.execute(sql`SELECT 1`).
  // The execute spy delegates to prismaMock.$queryRaw so the
  // existing test setup (mockResolvedValue / mockRejectedValue)
  // still controls the health-check outcome.
  const drizzleMock = {
    db: {
      execute: vi.fn(async () => {
        const rows = await prismaMock.$queryRaw();
        return { rows: Array.isArray(rows) ? rows : [] };
      }),
    },
    projectRepo: {
      findMembership: vi.fn(async (_db, projectId, userId) =>
        prismaMock.projectMember.findUnique({
          where: { projectId_userId: { projectId, userId } },
          select: { id: true, role: true },
        }),
      ),
      findProjectById: vi.fn(async () => null),
      findProjectCredentials: vi.fn(async () => null),
    },
    webhookEventRepo: {
      findLastProcessedWebhookAt: vi.fn(
        async (_db: unknown, projectId: string, source: string) => {
          const row = await prismaMock.webhookEvent.findFirst({
            where: { projectId, source, status: "PROCESSED" },
            orderBy: { processedAt: "desc" },
            select: { processedAt: true },
          });
          return row?.processedAt ?? null;
        },
      ),
    },
    shadowRead: vi.fn(
      async <T>(primary: () => Promise<T>, _shadow: () => Promise<T>): Promise<T> =>
        primary(),
    ),
  };

  const redisMock = {
    ping: vi.fn(async () => "PONG"),
  };

  const queueMock = {
    getJobCounts: vi.fn(async () => ({ active: 0, waiting: 0 })),
  };

  return { prismaMock, drizzleMock, redisMock, queueMock };
});

vi.mock("@rovenue/db", () => ({
  default: prismaMock,
  drizzle: drizzleMock,
  WebhookEventStatus: {
    RECEIVED: "RECEIVED",
    PROCESSING: "PROCESSING",
    PROCESSED: "PROCESSED",
    FAILED: "FAILED",
  },
  WebhookSource: {
    APPLE: "APPLE",
    GOOGLE: "GOOGLE",
    STRIPE: "STRIPE",
  },
}));

vi.mock("../src/lib/redis", () => ({ redis: redisMock }));

vi.mock("../src/services/webhook-processor", () => ({
  getWebhookQueue: () => queueMock,
  WEBHOOK_QUEUE_NAME: "rovenue-webhooks",
}));

vi.mock("../src/workers/webhook-delivery", () => ({
  getDeliveryQueue: () => queueMock,
}));

vi.mock("../src/services/fx", () => ({
  getFxQueue: () => queueMock,
  isFxStale: vi.fn(async () => false),
}));

vi.mock("../src/lib/project-credentials", () => ({
  loadAppleCredentials: vi.fn(async () => ({ bundleId: "com.example.app" })),
  loadGoogleCredentials: vi.fn(async () => ({
    packageName: "com.example.app",
    serviceAccount: { client_email: "s@p.iam", private_key: "key" },
  })),
  loadStripeCredentials: vi.fn(async () => ({
    secretKey: "sk_test_xxx",
    webhookSecret: "whsec_xxx",
  })),
}));

vi.mock("../src/middleware/dashboard-auth", () => ({
  requireDashboardAuth: async (c: any, next: any) => {
    const u = c.req.header("x-test-user");
    if (!u) {
      const { HTTPException } = await import("hono/http-exception");
      throw new HTTPException(401, { message: "Unauthorized" });
    }
    c.set("user", { id: u });
    await next();
  },
}));

// =============================================================
// Imports after mocks
// =============================================================

import { healthRoute, API_VERSION } from "../src/routes/health";

function buildApp(): Hono {
  const app = new Hono();
  app.route("/health", healthRoute);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  prismaMock.$queryRaw.mockResolvedValue([{ "?column?": 1 }]);
  redisMock.ping.mockResolvedValue("PONG");
  queueMock.getJobCounts.mockResolvedValue({ active: 2, waiting: 5 });
});

// =============================================================
// GET /health — liveness
// =============================================================

describe("GET /health (liveness)", () => {
  test("returns 200 with status ok + version", async () => {
    const res = await buildApp().request("/health");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { status: string; version: string } };
    expect(body.data).toEqual({ status: "ok", version: API_VERSION });
  });
});

// =============================================================
// GET /health/ready — readiness
// =============================================================

describe("GET /health/ready", () => {
  test("returns 200 + status ok when all dependencies are healthy", async () => {
    const res = await buildApp().request("/health/ready");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        status: string;
        checks: {
          database: { status: string; latencyMs: number };
          redis: { status: string; latencyMs: number };
          queues: Array<{
            name: string;
            status: string;
            activeJobs: number;
            waitingJobs: number;
          }>;
          fx: { status: string };
        };
        uptime: number;
      };
    };
    expect(body.data.status).toBe("ok");
    expect(body.data.checks.database.status).toBe("ok");
    expect(body.data.checks.redis.status).toBe("ok");
    expect(body.data.checks.queues.every((q) => q.status === "ok")).toBe(true);
    expect(body.data.checks.queues.map((q) => q.name).sort()).toEqual([
      "delivery",
      "fx",
      "webhook",
    ]);
    expect(typeof body.data.checks.database.latencyMs).toBe("number");
    expect(typeof body.data.uptime).toBe("number");
    expect(body.data.uptime).toBeGreaterThanOrEqual(0);
  });

  test("returns 503 + status degraded when database check fails", async () => {
    prismaMock.$queryRaw.mockRejectedValue(new Error("connection refused"));

    const res = await buildApp().request("/health/ready");

    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      data: { status: string; checks: { database: { status: string } } };
    };
    expect(body.data.status).toBe("degraded");
    expect(body.data.checks.database.status).toBe("down");
  });

  test("returns 503 when redis ping fails", async () => {
    redisMock.ping.mockRejectedValue(new Error("ECONNREFUSED"));

    const res = await buildApp().request("/health/ready");

    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      data: { status: string; checks: { redis: { status: string } } };
    };
    expect(body.data.status).toBe("degraded");
    expect(body.data.checks.redis.status).toBe("down");
  });

  test("returns 503 when a queue is unreachable", async () => {
    queueMock.getJobCounts.mockRejectedValue(new Error("queue error"));

    const res = await buildApp().request("/health/ready");

    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      data: {
        status: string;
        checks: { queues: Array<{ name: string; status: string }> };
      };
    };
    expect(body.data.status).toBe("degraded");
    expect(body.data.checks.queues.every((q) => q.status === "down")).toBe(true);
  });

  test("returns 503 when redis returns an unexpected ping response", async () => {
    redisMock.ping.mockResolvedValue("WAT");

    const res = await buildApp().request("/health/ready");

    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      data: { status: string; checks: { redis: { status: string } } };
    };
    expect(body.data.status).toBe("degraded");
    expect(body.data.checks.redis.status).toBe("down");
  });
});

// =============================================================
// GET /health/stores — dashboard-auth, project scoped
// =============================================================

describe("GET /health/stores", () => {
  test("401 when no dashboard auth", async () => {
    const res = await buildApp().request("/health/stores?projectId=proj_a");
    expect(res.status).toBe(401);
  });

  test("400 when projectId query param is missing", async () => {
    const res = await buildApp().request("/health/stores", {
      headers: { "x-test-user": "user_1" },
    });
    expect(res.status).toBe(400);
  });

  test("403 when the authenticated user is not a member of the project", async () => {
    prismaMock.projectMember.findUnique.mockResolvedValue(null);

    const res = await buildApp().request(
      "/health/stores?projectId=proj_a",
      { headers: { "x-test-user": "user_1" } },
    );

    expect(res.status).toBe(403);
  });

  test("returns connection status, last webhook time, and credential status per store", async () => {
    prismaMock.projectMember.findUnique.mockResolvedValue({
      id: "pm_1",
      userId: "user_1",
      projectId: "proj_a",
      role: "OWNER",
    });

    const appleTime = new Date("2026-04-14T10:00:00Z");
    const googleTime = new Date("2026-04-14T11:30:00Z");

    prismaMock.webhookEvent.findFirst.mockImplementation(
      async (args: any) => {
        if (args?.where?.source === "APPLE") {
          return { processedAt: appleTime };
        }
        if (args?.where?.source === "GOOGLE") {
          return { processedAt: googleTime };
        }
        return null;
      },
    );

    const res = await buildApp().request(
      "/health/stores?projectId=proj_a",
      { headers: { "x-test-user": "user_1" } },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        apple: { connected: boolean; lastWebhookAt: string | null; credentialStatus: string };
        google: { connected: boolean; lastWebhookAt: string | null; credentialStatus: string };
        stripe: { connected: boolean; lastWebhookAt: string | null; credentialStatus: string };
      };
    };

    expect(body.data.apple.connected).toBe(true);
    expect(body.data.apple.lastWebhookAt).toBe(appleTime.toISOString());
    expect(body.data.apple.credentialStatus).toBe("ok");

    expect(body.data.google.connected).toBe(true);
    expect(body.data.google.lastWebhookAt).toBe(googleTime.toISOString());
    expect(body.data.google.credentialStatus).toBe("ok");

    expect(body.data.stripe.connected).toBe(true);
    expect(body.data.stripe.lastWebhookAt).toBeNull();
    expect(body.data.stripe.credentialStatus).toBe("ok");
  });

  test("reports credentialStatus=missing when a store has no credentials", async () => {
    prismaMock.projectMember.findUnique.mockResolvedValue({
      id: "pm_1",
      userId: "user_1",
      projectId: "proj_a",
      role: "OWNER",
    });

    prismaMock.webhookEvent.findFirst.mockResolvedValue(null);

    const { loadStripeCredentials } = await import(
      "../src/lib/project-credentials"
    );
    vi.mocked(loadStripeCredentials).mockResolvedValueOnce(null);

    const res = await buildApp().request(
      "/health/stores?projectId=proj_a",
      { headers: { "x-test-user": "user_1" } },
    );

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: {
        stripe: { connected: boolean; credentialStatus: string };
      };
    };
    expect(body.data.stripe.connected).toBe(false);
    expect(body.data.stripe.credentialStatus).toBe("missing");
  });
});
