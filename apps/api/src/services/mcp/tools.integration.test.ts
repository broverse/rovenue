// =============================================================
// MCP read tools served from the surface-tagged shared registry.
//
// Seven consolidated tools (NOT get_metrics: R1 resolved that sandbox
// revenue is mixed into production analytics, so get_metrics does not
// ship until that is fixed — see the design spec). Chat-shaped ui_* and
// raw query_* names must never appear as MCP tools.
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
import { errorHandler } from "../../middleware/error";
import { MCP_PROTOCOL_REVISION } from "./server";
import { mcpRoute } from "../../routes/mcp";
import { TOOL_SURFACE, assertToolAllowed } from "./authorize";

const RUN_ID = Date.now();
const MAX_PAGE = 200;
const TEST_BCRYPT_ROUNDS = 4;

const READ_TOOLS = [
  "find_subscribers",
  "list_subscriptions",
  "list_catalog",
  "list_audiences",
  "list_feature_flags",
  "list_experiments",
  "get_paywall",
];

function buildMcpApp() {
  const app = new Hono();
  app.onError(errorHandler);
  return app.route("/mcp", mcpRoute);
}

function envelope(id: number, method: string, params: unknown) {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method,
    params: {
      ...(params as Record<string, unknown>),
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_REVISION,
        [CLIENT_INFO_META_KEY]: { name: "tools-test", version: "0.0.1" },
        [CLIENT_CAPABILITIES_META_KEY]: {},
      },
    },
  });
}

function mcpHeaders(raw: string, method: string) {
  return {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-method": method,
    authorization: `Bearer ${raw}`,
  };
}

async function listMcpToolNames(raw: string): Promise<string[]> {
  const res = await buildMcpApp().request("/mcp", {
    method: "POST",
    headers: mcpHeaders(raw, "tools/list"),
    body: envelope(1, "tools/list", {}),
  });
  const body = (await res.json()) as {
    result?: { tools?: Array<{ name: string }> };
  };
  return (body.result?.tools ?? []).map((t) => t.name);
}

async function callTool(raw: string, tool: string, args: unknown) {
  const res = await buildMcpApp().request("/mcp", {
    method: "POST",
    headers: mcpHeaders(raw, "tools/call"),
    body: envelope(2, "tools/call", { name: tool, arguments: args }),
  });
  const body = (await res.json()) as {
    result?: {
      content?: Array<{ type: string; text?: string }>;
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
    };
    error?: { message?: string };
  };
  if (body.error) {
    return { isError: true, text: body.error.message ?? "", structured: null };
  }
  const text = (body.result?.content ?? [])
    .map((c) => c.text ?? "")
    .join("\n");
  return {
    isError: body.result?.isError ?? false,
    text,
    structured: body.result?.structuredContent ?? null,
  };
}

async function seedUser(suffix: string) {
  const db = getDb();
  const id = `usr_mcptools_${RUN_ID}${suffix}`;
  await db.insert(drizzle.schema.user).values({
    id,
    name: `MCP Tools User ${suffix}`,
    email: `mcptools_${RUN_ID}_${suffix}@rovenue.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { id };
}

async function seedProject(suffix = "") {
  const db = getDb();
  const id = `prj_mcptools_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `MCP Tools Project ${RUN_ID}${suffix}`,
  });
  seededProjectIds.push(id);
  return { id };
}

async function seedOwner(projectId: string, suffix: string) {
  const { id: userId } = await seedUser(suffix);
  await getDb().insert(drizzle.schema.projectMembers).values({
    projectId,
    userId,
    role: "OWNER",
  });
  return { userId };
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

async function seedReadToken(suffix: string) {
  const project = await seedProject(suffix);
  const { userId } = await seedOwner(project.id, suffix);
  const { raw } = await seedMcpToken({
    projectId: project.id,
    userId,
    scope: "read",
  });
  return { raw, projectId: project.id };
}

async function seedSubscribers(projectId: string, n: number) {
  for (let i = 0; i < n; i++) {
    await drizzle.subscriberRepo.createSubscriber(drizzle.db, {
      projectId,
      rovenueId: `rvn_tools_${RUN_ID}_${i}`,
      appUserId: `tools_user_${i}`,
      attributes: { email: `tools_user_${i}@example.com` },
    });
  }
}

const seededProjectIds: string[] = [];

afterAll(async () => {
  const db = getDb();
  for (const id of seededProjectIds) {
    await db.delete(projects).where(eq(projects.id, id));
  }
});

describe("MCP consolidated surface", () => {
  it("serves the consolidated surface, and no ui_* tool", async () => {
    const { raw } = await seedReadToken("surface");
    const names = await listMcpToolNames(raw);
    for (const tool of READ_TOOLS) expect(names).toContain(tool);
    expect(names.filter((n) => n.startsWith("ui_"))).toEqual([]);
    // Raw chat names never surface: consolidation replaces them.
    expect(names.filter((n) => n.startsWith("query_"))).toEqual([]);
    expect(names.filter((n) => n.startsWith("action_"))).toEqual([]);
    // R1: sandbox revenue is mixed into production analytics, so
    // get_metrics does NOT ship until that is fixed. Assert the absence.
    expect(names).not.toContain("get_metrics");
  });

  it("serves the paywall tool, which chat gates behind a builder route", async () => {
    // ctx.route gates it for chat; MCP has no route, so a naive port would
    // serve it never. Assert it is present.
    const { raw } = await seedReadToken("paywall");
    expect(await listMcpToolNames(raw)).toContain("get_paywall");
  });

  it("list_catalog merges products and product groups in one call", async () => {
    const { raw } = await seedReadToken("catalog");
    const res = await callTool(raw, "list_catalog", {});
    expect(res.isError).toBe(false);
    const structured = res.structured as {
      products?: unknown[];
      productGroups?: unknown[];
    } | null;
    expect(structured).not.toBeNull();
    expect(structured?.products).toBeInstanceOf(Array);
    expect(structured?.productGroups).toBeInstanceOf(Array);
  });

  it("caps a page and says so rather than truncating silently", async () => {
    const { raw, projectId } = await seedReadToken("caps");
    await seedSubscribers(projectId, MAX_PAGE + 50);
    const res = await callTool(raw, "find_subscribers", { limit: 1000 });
    const structured = res.structured as {
      rows?: unknown[];
      truncationNote?: string | null;
    } | null;
    expect(structured?.rows?.length).toBeLessThanOrEqual(MAX_PAGE);
    expect(structured?.truncationNote ?? "").toMatch(/of \d+/);
  });

  it("strips subscriber PII", async () => {
    const { raw, projectId } = await seedReadToken("pii");
    await seedSubscribers(projectId, 1);
    const res = await callTool(raw, "find_subscribers", {});
    expect(res.isError).toBe(false);
    expect(JSON.stringify(res)).not.toContain("@");
  });

  it("a missing id is a tool error the model can act on, not a protocol error", async () => {
    const { raw } = await seedReadToken("missing");
    const res = await callTool(raw, "get_paywall", { paywallId: "nope" });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/list|not found/i);
  });
});

describe("read scope allow-path (Task 5 debt)", () => {
  it("a read token reaches tools the surface marks read", () => {
    // Pure: no DB touched. Every shipped read tool must pass here.
    const readCtx = {
      tokenId: "t-read",
      projectId: "p",
      userId: "u",
      scope: "read",
    };
    for (const tool of READ_TOOLS) {
      expect(TOOL_SURFACE[tool]).toBe("read");
      expect(() => assertToolAllowed(readCtx, tool)).not.toThrow();
    }
  });
});
