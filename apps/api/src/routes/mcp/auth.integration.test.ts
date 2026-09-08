// =============================================================
// MCP token verification + dashboard token management — integration tests
//
// Real Postgres seeded inline (mirrors the offerings dashboard harness):
// minimal Hono apps mounted on the same paths the production tree uses,
// real Better Auth session cookie so requireDashboardAuth runs unmocked.
// =============================================================

import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { MCP_TOKEN_PREFIX } from "@rovenue/shared";
import { getDb, projects, drizzle } from "@rovenue/db";
import { auth } from "../../lib/auth";
import { errorHandler } from "../../middleware/error";
import { app as fullApp } from "../../app";
import { MCP_PROTOCOL_REVISION } from "../../services/mcp/server";
import { mcpRoute } from "./index";
import { mcpTokensRoute } from "../dashboard/mcp-tokens";

const RUN_ID = Date.now();
const UNAUTHORIZED = 401;
const TEST_BCRYPT_ROUNDS = 4;

function buildMcpApp() {
  const app = new Hono();
  app.onError(errorHandler);
  return app.route("/mcp", mcpRoute);
}

function buildDashboardApp() {
  const app = new Hono();
  app.onError(errorHandler);
  return app.route("/projects/:projectId/mcp-tokens", mcpTokensRoute);
}

function discoverBody(id: number): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "server/discover",
    params: {
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_REVISION,
        [CLIENT_INFO_META_KEY]: { name: "auth-test", version: "0.0.1" },
        [CLIENT_CAPABILITIES_META_KEY]: {},
      },
    },
  });
}

async function callMcp(raw: string) {
  return buildMcpApp().request("/mcp", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-method": "server/discover",
      authorization: `Bearer ${raw}`,
    },
    body: discoverBody(1),
  });
}

async function createUserAndSession(
  suffix: string,
): Promise<{ userId: string; cookie: string }> {
  const email = `mcpauth_${RUN_ID}_${suffix}@rovenue.test`;
  const password = "Test1234!mcpauth";
  const name = `MCP Auth User ${suffix}`;

  const signUp = await auth.api.signUpEmail({
    body: { email, password, name },
  });
  if (!signUp?.user?.id) throw new Error("signUp failed");

  const signIn = await auth.api.signInEmail({
    body: { email, password },
    asResponse: true,
  });
  const rawCookie = signIn.headers.get("set-cookie") ?? "";
  const cookie = rawCookie
    .split(",")
    .map((s) => s.trim().split(";")[0])
    .join("; ");

  return { userId: signUp.user.id, cookie };
}

async function seedProject(suffix = "") {
  const db = getDb();
  const id = `prj_mcpauth_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `MCP Auth Project ${RUN_ID}${suffix}`,
  });
  seededProjectIds.push(id);
  return { id };
}

async function seedMember({
  projectId,
  userId,
  role,
}: {
  projectId: string;
  userId: string;
  role: "OWNER" | "ADMIN";
}) {
  await getDb().insert(drizzle.schema.projectMembers).values({
    projectId,
    userId,
    role,
  });
}

async function seedMcpToken({
  projectId,
  userId,
  scope,
  expiresAt = null,
}: {
  projectId: string;
  userId: string;
  scope: string;
  expiresAt?: Date | null;
}) {
  // cuid2 has no "_" so the verifier's first-delimiter split recovers it.
  const tokenId = createId();
  const raw = `${MCP_TOKEN_PREFIX}${tokenId}_${randomBytes(16).toString("base64url")}`;
  const keySecretHash = await bcrypt.hash(raw, TEST_BCRYPT_ROUNDS);
  await drizzle.mcpTokenRepo.create(drizzle.db, {
    id: tokenId,
    projectId,
    userId,
    label: `test token ${RUN_ID}`,
    scope,
    keyPublic: `${MCP_TOKEN_PREFIX}${tokenId}`,
    keySecretHash,
    expiresAt,
  });
  return { raw, tokenId };
}

const seededProjectIds: string[] = [];

afterAll(async () => {
  const db = getDb();
  for (const id of seededProjectIds) {
    await db.delete(projects).where(eq(projects.id, id));
  }
});

describe("MCP token verification", () => {
  it("accepts a live token and rejects a revoked one", async () => {
    const { userId } = await createUserAndSession("live");
    const project = await seedProject("live");
    await seedMember({ projectId: project.id, userId, role: "OWNER" });
    const { raw, tokenId } = await seedMcpToken({
      projectId: project.id,
      userId,
      scope: "read",
    });

    const live = await callMcp(raw);
    expect(live.status).not.toBe(UNAUTHORIZED);
    const liveBody = (await live.json()) as {
      result?: { capabilities?: Record<string, unknown> };
    };
    // The exact-set discovery contract (Task 2) holds behind auth too.
    expect(Object.keys(liveBody.result?.capabilities ?? {}).sort()).toEqual([
      "resources",
      "tools",
    ]);

    await drizzle.mcpTokenRepo.revoke(drizzle.db, project.id, tokenId);
    // Revocation takes effect on the NEXT request with no session to expire,
    // because the server is stateless. Assert that, don't assume it.
    expect((await callMcp(raw)).status).toBe(UNAUTHORIZED);
  });

  it("rejects an expired token", async () => {
    const { userId } = await createUserAndSession("expired");
    const project = await seedProject("expired");
    await seedMember({ projectId: project.id, userId, role: "OWNER" });
    const { raw } = await seedMcpToken({
      projectId: project.id,
      userId,
      scope: "read",
      expiresAt: new Date(Date.now() - 1000),
    });
    expect((await callMcp(raw)).status).toBe(UNAUTHORIZED);
  });

  it("apiKeyAuth cannot classify an MCP token, and fails closed", async () => {
    // This is the whole justification for a separate table rather than a
    // third kind in `api_keys`: an MCP token must not become accepted by
    // every /v1/* route that uses apiKeyAuth("any"). Assert it.
    const { userId } = await createUserAndSession("failclosed");
    const project = await seedProject("failclosed");
    await seedMember({ projectId: project.id, userId, role: "OWNER" });
    const { raw } = await seedMcpToken({
      projectId: project.id,
      userId,
      scope: "read_write",
    });
    const res = await fullApp.request("/v1/offerings", {
      headers: { authorization: `Bearer ${raw}` },
    });
    expect(res.status).toBe(UNAUTHORIZED);
  });
});

describe("dashboard MCP token management", () => {
  it("shows the secret exactly once", async () => {
    // OWNER passes the settings:write gate on all three endpoints.
    const owner = await createUserAndSession("once-owner");
    const project = await seedProject("once");
    await seedMember({ projectId: project.id, userId: owner.userId, role: "OWNER" });

    const app = buildDashboardApp();
    const created = await app.request(`/projects/${project.id}/mcp-tokens`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: owner.cookie },
      body: JSON.stringify({ label: "ci token", scope: "read" }),
    });
    expect(created.status).toBe(200);
    const createdBody = (await created.json()) as {
      data: { token: string };
    };
    expect(createdBody.data.token).toMatch(/^rov_mcp_/);

    const listed = await app.request(`/projects/${project.id}/mcp-tokens`, {
      headers: { cookie: owner.cookie },
    });
    expect(listed.status).toBe(200);
    const listedBody = await listed.json();
    expect(JSON.stringify(listedBody)).not.toContain(createdBody.data.token);
  });
});
