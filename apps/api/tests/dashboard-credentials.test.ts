import { beforeEach, describe, expect, test, vi } from "vitest";

const { prismaMock, authMock } = vi.hoisted(() => {
  const prismaMock = {
    projectMember: { findUnique: vi.fn() },
    project: { findUnique: vi.fn(), update: vi.fn() },
    auditLog: {
      create: vi.fn(async () => ({ id: "al_1" })),
      findFirst: vi.fn(async () => null),
    },
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(async <T>(fn: (tx: unknown) => Promise<T>) =>
      fn(prismaMock),
    ),
  };
  const authMock = { api: { getSession: vi.fn() } };
  return { prismaMock, authMock };
});

vi.mock("@rovenue/db", async () => {
  const actual = await vi.importActual<typeof import("@rovenue/db")>(
    "@rovenue/db",
  );
  return {
    ...actual,
    default: prismaMock,
    MemberRole: { OWNER: "OWNER", ADMIN: "ADMIN", VIEWER: "VIEWER" },
    // encryptCredential / decryptCredential come from the real module —
    // tests verify both the write shape (encrypted tag) and the round
    // trip via the real crypto helpers.
  };
});
vi.mock("../src/lib/auth", () => ({ auth: authMock }));

import { app } from "../src/app";
import { encryptCredential } from "@rovenue/db";

function signedIn(userId = "user_1") {
  authMock.api.getSession.mockResolvedValue({
    user: { id: userId, email: "u@x" },
  });
}

beforeEach(() => vi.clearAllMocks());

// Minimum ENCRYPTION_KEY for the real helper to run.
process.env.ENCRYPTION_KEY ??=
  "6ecfcd0f73d5afe055ff651e0e4ce85679cdd12bb4cede7aa4338b693047b8f1";

describe("GET /dashboard/projects/:projectId/credentials", () => {
  test("forbidden for non-member", async () => {
    signedIn("outsider");
    prismaMock.projectMember.findUnique.mockResolvedValue(null);
    const res = await app.request("/dashboard/projects/proj_1/credentials");
    expect(res.status).toBe(403);
  });

  test("returns configured=false for all stores when project has no credentials", async () => {
    signedIn("user_1");
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "VIEWER" });
    prismaMock.project.findUnique.mockResolvedValue({
      appleCredentials: null,
      googleCredentials: null,
      stripeCredentials: null,
    });
    const res = await app.request("/dashboard/projects/proj_1/credentials");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { credentials: Record<string, { configured: boolean }> };
    };
    expect(body.data.credentials.apple.configured).toBe(false);
    expect(body.data.credentials.google.configured).toBe(false);
    expect(body.data.credentials.stripe.configured).toBe(false);
  });

  test("returns configured=true + safe fields, never plaintext secrets", async () => {
    signedIn("user_1");
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "VIEWER" });
    const key = process.env.ENCRYPTION_KEY!;
    const encryptedApple = encryptCredential(
      { bundleId: "com.acme.app", keyId: "KEY1", privateKey: "LEAKED" },
      key,
    );
    const encryptedStripe = encryptCredential(
      { secretKey: "sk_live_SUPER_SECRET", webhookSecret: "whsec_LEAK" },
      key,
    );
    prismaMock.project.findUnique.mockResolvedValue({
      appleCredentials: encryptedApple,
      googleCredentials: null,
      stripeCredentials: encryptedStripe,
    });

    const res = await app.request("/dashboard/projects/proj_1/credentials");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      data: { credentials: Record<string, { configured: boolean; safeFields?: Record<string, string> }> };
    };
    expect(body.data.credentials.apple.configured).toBe(true);
    expect(body.data.credentials.apple.safeFields).toEqual(
      expect.objectContaining({ bundleId: "com.acme.app", keyId: "KEY1" }),
    );
    expect(body.data.credentials.stripe.configured).toBe(true);
    const serialized = JSON.stringify(body.data);
    expect(serialized).not.toContain("LEAKED");
    expect(serialized).not.toContain("SUPER_SECRET");
    expect(serialized).not.toContain("whsec_LEAK");
  });
});

describe("PUT /dashboard/projects/:projectId/credentials/:store", () => {
  test("requires OWNER — ADMIN gets 403", async () => {
    signedIn("admin");
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "ADMIN" });
    const res = await app.request("/dashboard/projects/proj_1/credentials/apple", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundleId: "com.acme.app" }),
    });
    expect(res.status).toBe(403);
  });

  test("OWNER writes apple credentials encrypted + audit is redacted", async () => {
    signedIn("owner");
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "OWNER" });
    prismaMock.project.update.mockResolvedValue({ id: "proj_1" });

    const res = await app.request("/dashboard/projects/proj_1/credentials/apple", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundleId: "com.acme.app", keyId: "KEY1", privateKey: "-----BEGIN PRIVATE KEY-----\nfoo\n" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { credential: { store: string; configured: boolean } } };
    expect(body.data.credential).toEqual({ store: "apple", configured: true });

    // update payload carries the encrypted wrapper, not the plaintext
    const updateCall = prismaMock.project.update.mock.calls[0]![0] as {
      data: { appleCredentials: { v: number; enc: string } };
    };
    expect(updateCall.data.appleCredentials.v).toBe(1);
    expect(typeof updateCall.data.appleCredentials.enc).toBe("string");
    expect(updateCall.data.appleCredentials.enc).not.toContain("com.acme.app");
    expect(updateCall.data.appleCredentials.enc).not.toContain("BEGIN PRIVATE KEY");

    // audit snapshot is redacted
    const auditCall = prismaMock.auditLog.create.mock.calls[0]![0] as {
      data: { before: Record<string, string>; after: Record<string, string>; resource: string };
    };
    expect(auditCall.data.resource).toBe("credential");
    expect(auditCall.data.before).toEqual({ apple: "[REDACTED]" });
    expect(auditCall.data.after).toEqual({ apple: "[REDACTED]" });
  });

  test("rejects invalid payload with 400", async () => {
    signedIn("owner");
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "OWNER" });
    const res = await app.request("/dashboard/projects/proj_1/credentials/stripe", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secretKey: "" }), // empty, invalid
    });
    expect(res.status).toBe(400);
    expect(prismaMock.project.update).not.toHaveBeenCalled();
    expect(prismaMock.auditLog.create).not.toHaveBeenCalled();
  });

  test("rejects unknown store with 400", async () => {
    signedIn("owner");
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "OWNER" });
    const res = await app.request("/dashboard/projects/proj_1/credentials/amazon", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ foo: "bar" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("DELETE /dashboard/projects/:projectId/credentials/:store", () => {
  test("OWNER clears credentials + audit after=cleared", async () => {
    signedIn("owner");
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "OWNER" });
    prismaMock.project.update.mockResolvedValue({ id: "proj_1" });

    const res = await app.request("/dashboard/projects/proj_1/credentials/google", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { credential: { configured: boolean } } };
    expect(body.data.credential.configured).toBe(false);

    expect(prismaMock.project.update).toHaveBeenCalled();

    const auditCall = prismaMock.auditLog.create.mock.calls[0]![0] as {
      data: { action: string; before: Record<string, string>; after: unknown };
    };
    expect(auditCall.data.action).toBe("credential.cleared");
    expect(auditCall.data.before).toEqual({ google: "[REDACTED]" });
    expect(auditCall.data.after).toBeUndefined();
  });

  test("ADMIN cannot clear (OWNER only)", async () => {
    signedIn("admin");
    prismaMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "ADMIN" });
    const res = await app.request("/dashboard/projects/proj_1/credentials/google", {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
  });
});
