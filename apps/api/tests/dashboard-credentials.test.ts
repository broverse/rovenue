import { beforeEach, describe, expect, test, vi } from "vitest";
const auditMock = vi.hoisted(() => ({
  audit: vi.fn(async () => undefined),
  extractRequestContext: vi.fn(() => ({ ipAddress: null, userAgent: null })),
  redactCredentials: vi.fn((obj: Record<string, unknown> | null | undefined) => {
    if (!obj) return null;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(obj)) out[k] = "[REDACTED]";
    return out;
  }),
  verifyAuditChain: vi.fn(async () => ({
    projectId: "",
    rowCount: 0,
    firstVerifiedAt: null,
    lastVerifiedAt: null,
    errors: [],
  })),
}));
vi.mock("../src/lib/audit", () => auditMock);

const { dbMock, drizzleMock, authMock } = vi.hoisted(() => {
  const dbMock = {
    projectMember: { findUnique: vi.fn() },
    project: { findUnique: vi.fn(), update: vi.fn() },
    auditLog: {
      create: vi.fn(async () => ({ id: "al_1" })),
      findFirst: vi.fn(async () => null),
    },
    $executeRaw: vi.fn(async () => 0),
    $transaction: vi.fn(async <T>(fn: (tx: unknown) => Promise<T>) =>
      fn(dbMock),
    ),
  };

  // Drizzle reads delegate to the dbMock spies so existing
  // `dbMock.projectMember.findUnique.mockResolvedValue(...)` calls
  // keep driving the test. Project credential loaders go through
  // findProjectCredentials; tests that need to exercise that path
  // override it explicitly.
  const drizzleDb = {
    transaction: vi.fn(async <T>(fn: (tx: unknown) => Promise<T>) =>
      fn(drizzleDb),
    ),
  };
  const drizzleMock = {
    db: drizzleDb,
    projectRepo: {
      findMembership: vi.fn(async (_db, projectId, userId) =>
        dbMock.projectMember.findUnique({
          where: { projectId_userId: { projectId, userId } },
          select: { id: true, role: true },
        }),
      ),
      findProjectById: vi.fn(async (_db: unknown, id: string) =>
        dbMock.project.findUnique({ where: { id } }),
      ),
      findProjectCredentials: vi.fn(async (_db, id, store) => {
        const project = await dbMock.project.findUnique({
          where: { id },
          select: { [`${store}Credentials`]: true },
        });
        const value = project?.[`${store}Credentials`];
        return value != null ? { value } : null;
      }),
      // Write paths — the route hands these the tx handle from
      // drizzle.db.transaction. Test assertions pin the call args
      // directly on these spies.
      writeProjectCredential: vi.fn(async () => undefined),
      clearProjectCredential: vi.fn(async () => undefined),
    },
    shadowRead: vi.fn(
      async <T>(primary: () => Promise<T>, _shadow: () => Promise<T>): Promise<T> =>
        primary(),
    ),
  };
  const authMock = { api: { getSession: vi.fn() } };
  return { dbMock, drizzleMock, authMock };
});

vi.mock("@rovenue/db", async () => {
  const actual = await vi.importActual<typeof import("@rovenue/db")>(
    "@rovenue/db",
  );
  return {
    ...actual,
    default: dbMock,
    drizzle: drizzleMock,
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
    dbMock.projectMember.findUnique.mockResolvedValue(null);
    const res = await app.request("/dashboard/projects/proj_1/credentials");
    expect(res.status).toBe(403);
  });

  test("returns configured=false for all stores when project has no credentials", async () => {
    signedIn("user_1");
    dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "VIEWER" });
    dbMock.project.findUnique.mockResolvedValue({
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
    dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "VIEWER" });
    const key = process.env.ENCRYPTION_KEY!;
    const encryptedApple = encryptCredential(
      { bundleId: "com.acme.app", keyId: "KEY1", privateKey: "LEAKED" },
      key,
    );
    const encryptedStripe = encryptCredential(
      { secretKey: "sk_live_SUPER_SECRET", webhookSecret: "whsec_LEAK" },
      key,
    );
    dbMock.project.findUnique.mockResolvedValue({
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
    dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "ADMIN" });
    const res = await app.request("/dashboard/projects/proj_1/credentials/apple", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundleId: "com.acme.app" }),
    });
    expect(res.status).toBe(403);
  });

  test("OWNER writes apple credentials encrypted + audit is redacted", async () => {
    signedIn("owner");
    dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "OWNER" });

    const res = await app.request("/dashboard/projects/proj_1/credentials/apple", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ bundleId: "com.acme.app", keyId: "KEY1", privateKey: "-----BEGIN PRIVATE KEY-----\nfoo\n" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { credential: { store: string; configured: boolean } } };
    expect(body.data.credential).toEqual({ store: "apple", configured: true });

    // update payload carries the encrypted wrapper, not the plaintext
    const writeCall = drizzleMock.projectRepo.writeProjectCredential.mock
      .calls[0]! as [unknown, string, string, { v: number; enc: string }];
    expect(writeCall[1]).toBe("proj_1");
    expect(writeCall[2]).toBe("apple");
    const encrypted = writeCall[3];
    expect(encrypted.v).toBe(1);
    expect(typeof encrypted.enc).toBe("string");
    expect(encrypted.enc).not.toContain("com.acme.app");
    expect(encrypted.enc).not.toContain("BEGIN PRIVATE KEY");

    // audit snapshot is redacted
    const auditCall = auditMock.audit.mock.calls[0]![0] as {
      before: Record<string, string>;
      after: Record<string, string>;
      resource: string;
    };
    expect(auditCall.resource).toBe("credential");
    expect(auditCall.before).toEqual({ apple: "[REDACTED]" });
    expect(auditCall.after).toEqual({ apple: "[REDACTED]" });
  });

  test("rejects invalid payload with 400", async () => {
    signedIn("owner");
    dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "OWNER" });
    const res = await app.request("/dashboard/projects/proj_1/credentials/stripe", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secretKey: "" }), // empty, invalid
    });
    expect(res.status).toBe(400);
    expect(drizzleMock.projectRepo.writeProjectCredential).not.toHaveBeenCalled();
    expect(auditMock.audit).not.toHaveBeenCalled();
  });

  test("rejects unknown store with 400", async () => {
    signedIn("owner");
    dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "OWNER" });
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
    dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "OWNER" });

    const res = await app.request("/dashboard/projects/proj_1/credentials/google", {
      method: "DELETE",
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { credential: { configured: boolean } } };
    expect(body.data.credential.configured).toBe(false);

    expect(drizzleMock.projectRepo.clearProjectCredential).toHaveBeenCalledWith(
      expect.anything(),
      "proj_1",
      "google",
    );

    const auditCall = auditMock.audit.mock.calls[0]![0] as {
      action: string;
      before: Record<string, string>;
      after: unknown;
    };
    expect(auditCall.action).toBe("credential.cleared");
    expect(auditCall.before).toEqual({ google: "[REDACTED]" });
    expect(auditCall.after).toBeNull();
  });

  test("ADMIN cannot clear (OWNER only)", async () => {
    signedIn("admin");
    dbMock.projectMember.findUnique.mockResolvedValue({ id: "pm", role: "ADMIN" });
    const res = await app.request("/dashboard/projects/proj_1/credentials/google", {
      method: "DELETE",
    });
    expect(res.status).toBe(403);
  });
});
