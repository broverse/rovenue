// =============================================================
// MCP per-request authorization + token scope — integration tests
//
// `authorizeMcpRequest` resolves the role live on every request (no
// baked-in role); `assertToolAllowed` gates write tools on token scope
// before any tool body — and therefore before any intent row — runs.
// =============================================================

import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { Hono } from "hono";
import { and, count, eq } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { MCP_TOKEN_PREFIX } from "@rovenue/shared";
import { getDb, projects, drizzle } from "@rovenue/db";
import { errorHandler } from "../../middleware/error";
import { MCP_PROTOCOL_REVISION } from "./server";
import { mcpRoute } from "../../routes/mcp";
import {
  TOOL_SURFACE,
  assertToolAllowed,
  authorizeMcpRequest,
} from "./authorize";

const RUN_ID = Date.now();
const FORBIDDEN = 403;
const TEST_BCRYPT_ROUNDS = 4;

function buildMcpApp() {
  const app = new Hono();
  app.onError(errorHandler);
  return app.route("/mcp", mcpRoute);
}

function mcpHeaders(raw: string) {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-method": "server/discover",
    authorization: `Bearer ${raw}`,
  };
}

function discoverBody(id: number): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "server/discover",
    params: {
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_REVISION,
        [CLIENT_INFO_META_KEY]: { name: "authorize-test", version: "0.0.1" },
        [CLIENT_CAPABILITIES_META_KEY]: {},
      },
    },
  });
}

function toolCallBody(id: number, tool: string, args: unknown): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "tools/call",
    params: {
      name: tool,
      arguments: args,
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_REVISION,
        [CLIENT_INFO_META_KEY]: { name: "authorize-test", version: "0.0.1" },
        [CLIENT_CAPABILITIES_META_KEY]: {},
      },
    },
  });
}

async function callMcp(raw: string) {
  return buildMcpApp().request("/mcp", {
    method: "POST",
    headers: { ...mcpHeaders(raw), "mcp-method": "server/discover" },
    body: discoverBody(1),
  });
}

async function callTool(raw: string, tool: string, args: unknown) {
  return buildMcpApp().request("/mcp", {
    method: "POST",
    headers: { ...mcpHeaders(raw), "mcp-method": "tools/call" },
    body: toolCallBody(2, tool, args),
  });
}

async function seedUser(suffix: string) {
  const db = getDb();
  const id = `usr_mcpautz_${RUN_ID}${suffix}`;
  await db.insert(drizzle.schema.user).values({
    id,
    name: `MCP Autz User ${suffix}`,
    email: `mcpautz_${RUN_ID}_${suffix}@rovenue.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { id };
}

async function seedProject(suffix = "") {
  const db = getDb();
  const id = `prj_mcpautz_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `MCP Autz Project ${RUN_ID}${suffix}`,
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

async function removeMembership(projectId: string, userId: string) {
  await getDb()
    .delete(drizzle.schema.projectMembers)
    .where(
      and(
        eq(drizzle.schema.projectMembers.projectId, projectId),
        eq(drizzle.schema.projectMembers.userId, userId),
      ),
    );
}

async function seedMcpToken({
  projectId,
  userId,
  scope,
}: {
  projectId: string;
  userId: string;
  scope: string;
}) {
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
    expiresAt: null,
  });
  return { raw, tokenId };
}

async function countIntents(projectId: string): Promise<number> {
  const rows = await getDb()
    .select({ n: count() })
    .from(drizzle.schema.copilotIntents)
    .where(eq(drizzle.schema.copilotIntents.projectId, projectId));
  return rows[0]?.n ?? 0;
}

const seededProjectIds: string[] = [];

afterAll(async () => {
  const db = getDb();
  for (const id of seededProjectIds) {
    await db.delete(projects).where(eq(projects.id, id));
  }
});

describe("authorizeMcpRequest", () => {
  it("a token dies with its owner's membership", async () => {
    // The token carries NO baked-in role. If it did, a demoted user would
    // keep their old privileges until the token expired.
    const { id: userId } = await seedUser("dies");
    const project = await seedProject("dies");
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const { raw } = await seedMcpToken({
      projectId: project.id,
      userId,
      scope: "read",
    });
    expect((await callMcp(raw)).status).not.toBe(FORBIDDEN);

    await removeMembership(project.id, userId);
    expect((await callMcp(raw)).status).toBe(FORBIDDEN);
  });

  it("resolves the live role on every request", async () => {
    const { id: userId } = await seedUser("role");
    const project = await seedProject("role");
    await seedMember({ projectId: project.id, userId, role: "ADMIN" });
    const { tokenId } = await seedMcpToken({
      projectId: project.id,
      userId,
      scope: "read",
    });

    const seen = await authorizeMcpRequest({
      tokenId,
      projectId: project.id,
      userId,
      scope: "read",
    });
    expect(seen.role).toBe("ADMIN");
  });
});

describe("assertToolAllowed", () => {
  it("a read token cannot reach a write tool even when its owner could", async () => {
    // Least privilege belongs to the token. The refusal must happen BEFORE
    // an intent row is created — a rejected call must leave no trace of a
    // proposed mutation.
    const { id: userId } = await seedUser("scope");
    const project = await seedProject("scope");
    await seedMember({ projectId: project.id, userId, role: "OWNER" });
    const { raw } = await seedMcpToken({
      projectId: project.id,
      userId,
      scope: "read",
    });
    const before = await countIntents(project.id);

    const res = await callTool(raw, "stop_experiment", { experimentId: "exp_1" });

    expect(res.status).toBe(FORBIDDEN);
    expect(await countIntents(project.id)).toBe(before);
  });

  it("grants write and unknown tools only to read_write scope", () => {
    // NOTE: no `read`-marked tool exists while TOOL_SURFACE is empty, so
    // the allow branch for read tokens has zero coverage here. Task 6 adds
    // an allow-path case when it populates the map.
    const readCtx = {
      tokenId: "t-read",
      projectId: "p",
      userId: "u",
      scope: "read",
    };
    const writeCtx = { ...readCtx, tokenId: "t-rw", scope: "read_write" };

    // No DB touched: scope gating is pure.
    expect(() =>
      assertToolAllowed(writeCtx, "stop_experiment"),
    ).not.toThrow();
    expect(() => assertToolAllowed(readCtx, "stop_experiment")).toThrow();
  });

  it("TOOL_SURFACE marks every shipped tool read", () => {
    // Task 6 populated this map as tools shipped. A tool added WITHOUT an
    // entry stays unreachable to read tokens by construction (fail-closed
    // unknown handling) — this pin makes that allow-list explicit.
    expect(TOOL_SURFACE).toEqual({
      find_subscribers: "read",
      list_subscriptions: "read",
      list_catalog: "read",
      list_audiences: "read",
      list_feature_flags: "read",
      list_experiments: "read",
      get_paywall: "read",
      find_funnels: "read",
    });
  });
});
