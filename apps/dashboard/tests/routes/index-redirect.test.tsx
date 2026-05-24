import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resolveLandingTarget } from "../../src/routes/index";

describe("resolveLandingTarget", () => {
  const projects = [
    { id: "p1", name: "Alpha", slug: "alpha", role: "OWNER" as const, createdAt: "2024-01-01T00:00:00Z" },
    { id: "p2", name: "Beta", slug: "beta", role: "OWNER" as const, createdAt: "2024-01-02T00:00:00Z" },
  ];

  let storage: Record<string, string>;
  beforeEach(() => {
    storage = {};
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      value: {
        getItem: (k: string) => (k in storage ? storage[k]! : null),
        setItem: (k: string, v: string) => { storage[k] = v; },
        removeItem: (k: string) => { delete storage[k]; },
      },
    });
  });
  afterEach(() => {
    // @ts-expect-error — cleanup
    delete globalThis.localStorage;
  });

  it("returns setup when project list is empty", () => {
    expect(resolveLandingTarget([])).toEqual({ kind: "setup" });
  });

  it("returns last project when lastProjectId is in the list", () => {
    storage.lastProjectId = "p2";
    expect(resolveLandingTarget(projects)).toEqual({
      kind: "project",
      projectId: "p2",
      wroteLastProjectId: false,
    });
  });

  it("falls back to first project when lastProjectId is stale", () => {
    storage.lastProjectId = "deleted";
    const result = resolveLandingTarget(projects);
    expect(result).toEqual({
      kind: "project",
      projectId: "p1",
      wroteLastProjectId: true,
    });
    expect(storage.lastProjectId).toBe("p1");
  });

  it("falls back to first project when no lastProjectId is stored", () => {
    const result = resolveLandingTarget(projects);
    expect(result).toEqual({
      kind: "project",
      projectId: "p1",
      wroteLastProjectId: true,
    });
    expect(storage.lastProjectId).toBe("p1");
  });
});
