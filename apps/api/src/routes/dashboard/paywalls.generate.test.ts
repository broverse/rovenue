import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

// =============================================================
// POST /dashboard/projects/:projectId/paywalls/:id/paywall-generate
// (P8 AI-FAB, Task 4) — one-shot generation for the AI start tab.
// Mocking idiom mirrors paywalls.from-app-store.test.ts: auth/access
// mocked at module level, the generation SERVICE mocked for
// determinism (its own unit tests live in
// services/paywall-ai/generate.test.ts), no real LLM/DB touched.
// =============================================================

const assertProjectAccess = vi.hoisted(() => vi.fn());
vi.mock("../../middleware/dashboard-auth", () => ({
  requireDashboardAuth: (c: { set: (k: string, v: unknown) => void }, next: () => Promise<void>) => {
    c.set("user", { id: "u1" });
    return next();
  },
}));
vi.mock("../../lib/project-access", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  assertProjectAccess: (...args: unknown[]) => assertProjectAccess(...args),
}));

// roviQuotaGuard() is called ONCE, at module-eval time, when paywalls.ts
// builds its Hono chain — so `roviQuotaGuardFactory` records exactly one
// call for the lifetime of this test file (never reset). The per-request
// middleware behaviour (`roviQuotaGuardMiddleware`) IS reset per test.
const roviQuotaGuardMiddleware = vi.hoisted(() => vi.fn(async (_c: any, next: any) => next()));
const roviQuotaGuardFactory = vi.hoisted(() => vi.fn(() => roviQuotaGuardMiddleware));
vi.mock("../../middleware/rovi-quota-guard", () => ({
  roviQuotaGuard: () => roviQuotaGuardFactory(),
}));

const findPaywallById = vi.hoisted(() => vi.fn());
vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      paywallRepo: { ...actual.drizzle.paywallRepo, findPaywallById },
    },
  };
});

const generatePaywallConfigMock = vi.hoisted(() => vi.fn());
vi.mock("../../services/paywall-ai/generate", async (importOriginal) => ({
  ...(await importOriginal<object>()),
  generatePaywallConfig: (...args: unknown[]) => generatePaywallConfigMock(...args),
}));

import { paywallsDashboardRoute } from "./paywalls";
import { errorHandler } from "../../middleware/error";
import { GenerationInvalidError } from "../../services/paywall-ai/generate";
import { RoviConfigError } from "../../services/copilot/providers";

function app() {
  return new Hono()
    .onError(errorHandler)
    .route("/dashboard/projects/:projectId/paywalls", paywallsDashboardRoute);
}

const PAYWALL = {
  id: "pw1",
  projectId: "p1",
  remoteConfig: { defaultLocale: "en", locales: { en: {} } },
};

const GENERATED_CONFIG = {
  formatVersion: 2,
  defaultLocale: "en",
  localizations: { en: { gen_1: "Go Pro" } },
  root: { type: "stack", id: "root", axis: "v", children: [] },
};

beforeEach(() => {
  assertProjectAccess.mockReset().mockResolvedValue(undefined);
  roviQuotaGuardMiddleware.mockReset().mockImplementation(async (_c: any, next: any) => next());
  findPaywallById.mockReset().mockResolvedValue(PAYWALL);
  generatePaywallConfigMock.mockReset().mockResolvedValue(GENERATED_CONFIG);
});

async function post(prompt = "make me a paywall") {
  return app().request("/dashboard/projects/p1/paywalls/pw1/paywall-generate", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt }),
  });
}

describe("POST /paywalls/:id/paywall-generate", () => {
  it("mounts roviQuotaGuard on this route", async () => {
    // Registered once, when paywalls.ts builds its Hono chain.
    expect(roviQuotaGuardFactory).toHaveBeenCalled();
    await post();
    expect(roviQuotaGuardMiddleware).toHaveBeenCalled();
  });

  it("short-circuits with the guard's own response when quota is exceeded, without generating", async () => {
    roviQuotaGuardMiddleware.mockImplementation(async (c: any) =>
      c.json({ error: { code: "ROVI_QUOTA_EXCEEDED", message: "Monthly limit reached" } }, 429),
    );
    const res = await post();
    expect(res.status).toBe(429);
    expect(generatePaywallConfigMock).not.toHaveBeenCalled();
  });

  it("returns the generated config on success", async () => {
    const res = await post("make me a great paywall");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { config: unknown } };
    expect(body.data.config).toEqual(GENERATED_CONFIG);
    expect(generatePaywallConfigMock).toHaveBeenCalledWith({
      projectId: "p1",
      prompt: "make me a great paywall",
      defaultLocale: "en",
    });
  });

  it("404s for a foreign/missing paywall before ever generating", async () => {
    findPaywallById.mockResolvedValue(null);
    const res = await post();
    expect(res.status).toBe(404);
    expect(generatePaywallConfigMock).not.toHaveBeenCalled();
  });

  it("maps RoviConfigError to the ROVI_NOT_CONFIGURED envelope at 412", async () => {
    generatePaywallConfigMock.mockRejectedValue(
      new RoviConfigError("Rovi has no provider configured for this project"),
    );
    const res = await post();
    expect(res.status).toBe(412);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ROVI_NOT_CONFIGURED");
  });

  it("maps GenerationInvalidError to GENERATION_INVALID at 422", async () => {
    generatePaywallConfigMock.mockRejectedValue(new GenerationInvalidError(["DUPLICATE_NODE_ID"]));
    const res = await post();
    expect(res.status).toBe(422);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("GENERATION_INVALID");
  });

  it("gates on project access (CUSTOMER_SUPPORT read gate) before generating", async () => {
    assertProjectAccess.mockRejectedValue(Object.assign(new Error("no"), { status: 403 }));
    await post();
    expect(assertProjectAccess).toHaveBeenCalled();
    expect(generatePaywallConfigMock).not.toHaveBeenCalled();
  });
});
