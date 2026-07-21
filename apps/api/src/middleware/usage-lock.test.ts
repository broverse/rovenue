import { beforeEach, describe, expect, it, vi } from "vitest";
import { Hono } from "hono";

vi.mock("@rovenue/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@rovenue/db")>();
  return {
    ...actual,
    drizzle: {
      ...actual.drizzle,
      db: {},
      projectRepo: { findProjectById: vi.fn() },
    },
  };
});

import { drizzle } from "@rovenue/db";
import { usageLockGuard } from "./usage-lock";

const d = drizzle as unknown as {
  projectRepo: { findProjectById: ReturnType<typeof vi.fn> };
};

function app() {
  return new Hono()
    .use("/projects/:projectId/*", usageLockGuard)
    .get("/projects/:projectId/charts", (c) => c.json({ ok: true }))
    .get("/projects/:projectId/billing/summary", (c) => c.json({ ok: true }));
}

beforeEach(() => vi.clearAllMocks());

describe("usageLockGuard", () => {
  it("passes through when the project is unlocked", async () => {
    d.projectRepo.findProjectById.mockResolvedValue({ id: "p1", usageLockedAt: null });
    const res = await app().request("/projects/p1/charts");
    expect(res.status).toBe(200);
  });

  it("returns 403 usage_limit_exceeded when locked", async () => {
    d.projectRepo.findProjectById.mockResolvedValue({ id: "p1", usageLockedAt: new Date() });
    const res = await app().request("/projects/p1/charts");
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("usage_limit_exceeded");
  });

  it("exempts billing paths so the upgrade flow stays reachable", async () => {
    d.projectRepo.findProjectById.mockResolvedValue({ id: "p1", usageLockedAt: new Date() });
    const res = await app().request("/projects/p1/billing/summary");
    expect(res.status).toBe(200);
    expect(d.projectRepo.findProjectById).not.toHaveBeenCalled();
  });
});
