// =============================================================
// apiKeyAuth — the four auth branches must surface their own codes
// =============================================================
//
// Before this test, all four throw sites (`apiKeyAuth`'s missing-Bearer,
// bad-format, wrong-kind and invalid/expired branches) used a bare
// `HTTPException` with no `cause`, so `middleware/error.ts`'s status→code
// fallback collapsed every one of them into the generic UNAUTHORIZED (401)
// or FORBIDDEN (403). A client could not tell "no bearer token" from
// "wrong key kind" from "malformed key" from "the key doesn't exist" —
// each assertion below pins the SPECIFIC code on the wire, not merely the
// generic status.

import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "./error";

const findApiKeyByPublicMock = vi.fn();
const findApiKeyByIdMock = vi.fn();
const updateApiKeyLastUsedMock = vi.fn();

vi.mock("@rovenue/db", () => ({
  drizzle: {
    db: {},
    apiKeyRepo: {
      findApiKeyByPublic: (...args: unknown[]) =>
        findApiKeyByPublicMock(...args),
      findApiKeyById: (...args: unknown[]) => findApiKeyByIdMock(...args),
      updateApiKeyLastUsed: (...args: unknown[]) =>
        updateApiKeyLastUsedMock(...args),
    },
  },
}));

const { apiKeyAuth, requireSecretKey } = await import("./api-key-auth");

function buildApp(required: "any" | "PUBLIC" | "SECRET" = "any") {
  const app = new Hono()
    .use("*", apiKeyAuth(required))
    .get("/probe", (c) => c.json({ ok: true }));
  app.onError(errorHandler);
  return app;
}

function buildSecretGuardedApp() {
  const app = new Hono()
    .use("*", apiKeyAuth("any"))
    .use("*", requireSecretKey)
    .get("/probe", (c) => c.json({ ok: true }));
  app.onError(errorHandler);
  return app;
}

async function errorCodeOf(res: Response): Promise<string> {
  const body = (await res.json()) as { error: { code: string } };
  return body.error.code;
}

beforeEach(() => {
  findApiKeyByPublicMock.mockReset();
  findApiKeyByIdMock.mockReset();
  updateApiKeyLastUsedMock.mockReset();
  updateApiKeyLastUsedMock.mockResolvedValue(undefined);
});

describe("apiKeyAuth error codes", () => {
  it("emits BEARER_REQUIRED when the Authorization header is missing", async () => {
    const res = await buildApp().request("/probe");
    expect(res.status).toBe(401);
    expect(await errorCodeOf(res)).toBe("BEARER_REQUIRED");
  });

  it("emits BEARER_REQUIRED when Authorization is not a Bearer scheme", async () => {
    const res = await buildApp().request("/probe", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(res.status).toBe(401);
    expect(await errorCodeOf(res)).toBe("BEARER_REQUIRED");
  });

  it("emits INVALID_API_KEY_FORMAT for a token matching neither key prefix", async () => {
    const res = await buildApp().request("/probe", {
      headers: { Authorization: "Bearer not-a-real-key" },
    });
    expect(res.status).toBe(401);
    expect(await errorCodeOf(res)).toBe("INVALID_API_KEY_FORMAT");
  });

  it("emits API_KEY_KIND_MISMATCH when a public key is presented where a secret key is required", async () => {
    const res = await buildApp("SECRET").request("/probe", {
      headers: { Authorization: "Bearer rov_pub_abc123" },
    });
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe("API_KEY_KIND_MISMATCH");
  });

  it("emits API_KEY_KIND_MISMATCH when a secret key is presented where a public key is required", async () => {
    const res = await buildApp("PUBLIC").request("/probe", {
      headers: { Authorization: "Bearer rov_sec_key1_random" },
    });
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe("API_KEY_KIND_MISMATCH");
  });

  it("emits INVALID_API_KEY when the public key does not resolve to a live record", async () => {
    findApiKeyByPublicMock.mockResolvedValue(null);
    const res = await buildApp().request("/probe", {
      headers: { Authorization: "Bearer rov_pub_unknown" },
    });
    expect(res.status).toBe(401);
    expect(await errorCodeOf(res)).toBe("INVALID_API_KEY");
  });

  it("emits INVALID_API_KEY when the key is revoked", async () => {
    findApiKeyByPublicMock.mockResolvedValue({
      id: "ak_1",
      keyPublic: "rov_pub_revoked",
      revokedAt: new Date(),
      expiresAt: null,
      project: { id: "proj_1", name: "Revoked project" },
    });
    const res = await buildApp().request("/probe", {
      headers: { Authorization: "Bearer rov_pub_revoked" },
    });
    expect(res.status).toBe(401);
    expect(await errorCodeOf(res)).toBe("INVALID_API_KEY");
  });

  it("emits INVALID_API_KEY when the key is expired", async () => {
    findApiKeyByPublicMock.mockResolvedValue({
      id: "ak_2",
      keyPublic: "rov_pub_expired",
      revokedAt: null,
      expiresAt: new Date(Date.now() - 1000),
      project: { id: "proj_1", name: "Expired project" },
    });
    const res = await buildApp().request("/probe", {
      headers: { Authorization: "Bearer rov_pub_expired" },
    });
    expect(res.status).toBe(401);
    expect(await errorCodeOf(res)).toBe("INVALID_API_KEY");
  });

  it("still resolves to FORBIDDEN (not one of the four) for the route-level requireSecretKey guard", async () => {
    // requireSecretKey is a SEPARATE guard from apiKeyAuth's own
    // kind-check (`required` param) — out of this task's scope, so it
    // must keep behaving exactly as before: generic FORBIDDEN.
    findApiKeyByPublicMock.mockResolvedValue({
      id: "ak_3",
      keyPublic: "rov_pub_ok",
      revokedAt: null,
      expiresAt: null,
      project: { id: "proj_1", name: "OK project" },
    });
    const res = await buildSecretGuardedApp().request("/probe", {
      headers: { Authorization: "Bearer rov_pub_ok" },
    });
    expect(res.status).toBe(403);
    expect(await errorCodeOf(res)).toBe("FORBIDDEN");
  });

  it("passes through with 200 for a valid public key on an unrestricted route", async () => {
    findApiKeyByPublicMock.mockResolvedValue({
      id: "ak_4",
      keyPublic: "rov_pub_valid",
      revokedAt: null,
      expiresAt: null,
      project: { id: "proj_1", name: "Valid project" },
    });
    const res = await buildApp().request("/probe", {
      headers: { Authorization: "Bearer rov_pub_valid" },
    });
    expect(res.status).toBe(200);
  });
});
