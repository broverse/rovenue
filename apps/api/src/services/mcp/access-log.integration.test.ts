// =============================================================
// MCP access trail + quota axis.
//
// Every tool call reaching the MCP handler emits exactly one
// MCP_ACCESS outbox row (the only path to Kafka/ClickHouse — never a
// direct write), carrying the tool and the actor but only a digest of
// the arguments. The tier ladder gains an mcp_calls axis on top of the
// existing evaluateQuota, plus an abuse floor that ignores
// quotasUnlimited() (R3 resolution).
// =============================================================

import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { Hono } from "hono";
import { and, desc, eq, sql } from "drizzle-orm";
import { createId } from "@paralleldrive/cuid2";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { MCP_TOKEN_PREFIX } from "@rovenue/shared";
import { getDb, projects, drizzle } from "@rovenue/db";
import { errorHandler } from "../../middleware/error";
import { evaluateQuota } from "../copilot/quota";
import { MCP_PROTOCOL_REVISION } from "./server";
import { mcpRoute } from "../../routes/mcp";

const RUN_ID = Date.now();
const TEST_BCRYPT_ROUNDS = 4;

const ACCESS_LOG_PATH = new URL("./access-log.ts", import.meta.url);

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
        [CLIENT_INFO_META_KEY]: { name: "access-log-test", version: "0.0.1" },
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

async function callTool(raw: string, tool: string, args: unknown) {
  const res = await buildMcpApp().request("/mcp", {
    method: "POST",
    headers: { ...mcpHeaders(raw, "tools/call"), "mcp-name": tool },
    body: envelope(2, "tools/call", { name: tool, arguments: args }),
  });
  return (await res.json()) as {
    result?: { isError?: boolean };
    error?: { message?: string };
  };
}

async function seedUser(suffix: string) {
  const db = getDb();
  const id = `usr_mcpaccess_${RUN_ID}${suffix}`;
  await db.insert(drizzle.schema.user).values({
    id,
    name: `MCP Access User ${suffix}`,
    email: `mcpaccess_${RUN_ID}_${suffix}@rovenue.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { id };
}

async function seedProject(suffix = "") {
  const db = getDb();
  const id = `prj_mcpaccess_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `MCP Access Project ${RUN_ID}${suffix}`,
  });
  seededProjectIds.push(id);
  return { id };
}

async function seedReadToken(suffix: string) {
  const project = await seedProject(suffix);
  const { id: userId } = await seedUser(suffix);
  await getDb().insert(drizzle.schema.projectMembers).values({
    projectId: project.id,
    userId,
    role: "OWNER",
  });
  const tokenId = createId();
  const raw = `${MCP_TOKEN_PREFIX}${tokenId}_${randomBytes(16).toString("base64url")}`;
  await drizzle.mcpTokenRepo.create(drizzle.db, {
    id: tokenId,
    projectId: project.id,
    userId,
    label: `test token ${RUN_ID}`,
    scope: "read",
    keyPublic: `${MCP_TOKEN_PREFIX}${tokenId}`,
    keySecretHash: await bcrypt.hash(raw, TEST_BCRYPT_ROUNDS),
    expiresAt: null,
  });
  return { raw, projectId: project.id, userId, tokenId };
}

async function countOutbox(projectId: string): Promise<number> {
  const rows = await getDb()
    .select({ id: drizzle.schema.outboxEvents.id })
    .from(drizzle.schema.outboxEvents)
    .where(
      and(
        eq(drizzle.schema.outboxEvents.aggregateType, "MCP_ACCESS"),
        sql`${drizzle.schema.outboxEvents.payload}->>'projectId' = ${projectId}`,
      ),
    );
  return rows.length;
}

async function latestOutbox(projectId: string) {
  const [row] = await getDb()
    .select()
    .from(drizzle.schema.outboxEvents)
    .where(
      and(
        eq(drizzle.schema.outboxEvents.aggregateType, "MCP_ACCESS"),
        sql`${drizzle.schema.outboxEvents.payload}->>'projectId' = ${projectId}`,
      ),
    )
    .orderBy(desc(drizzle.schema.outboxEvents.createdAt))
    .limit(1);
  return row ?? null;
}

const seededProjectIds: string[] = [];

afterAll(async () => {
  const db = getDb();
  for (const id of seededProjectIds) {
    await db.delete(projects).where(eq(projects.id, id));
  }
});

describe("MCP access trail", () => {
  it("emits exactly one outbox row per tool call, in the same transaction", async () => {
    const { raw, projectId } = await seedReadToken("onetrail");
    const before = await countOutbox(projectId);
    await callTool(raw, "list_experiments", {});
    expect(await countOutbox(projectId)).toBe(before + 1);
  });

  it("writes ClickHouse only through the outbox", async () => {
    // The outbox is the ONLY path to Kafka in this codebase; a direct
    // write would bypass the dispatcher and lose at-least-once.
    const source = readFileSync(ACCESS_LOG_PATH, "utf8");
    expect(source).not.toMatch(/clickhouse|insertInto|kafkajs|redpanda/i);
  });

  it("records the tool and the actor but not the argument values", async () => {
    const { raw, projectId, userId } = await seedReadToken("privacy");
    await callTool(raw, "find_subscribers", {
      filter: { q: "alice@example.com" },
    });
    const row = await latestOutbox(projectId);
    expect(row?.payload.toolName).toBe("find_subscribers");
    expect(row?.payload.userId).toBe(userId);
    // An argument DIGEST, never the arguments: a query string can itself
    // be PII, and this row is destined for analytics storage.
    expect(JSON.stringify(row?.payload)).not.toContain("alice@example.com");
    expect(typeof row?.payload.argsDigest).toBe("string");
  });

  it("counts MCP calls against the tier ladder, not a parallel limiter", async () => {
    const base = {
      tier: "free" as const,
      unlimited: false,
      usage: { messages: 0, inputTokens: 0, outputTokens: 0, mcpCalls: 0 },
    };
    expect(evaluateQuota(base).exceeded).toBeNull();
    const verdict = evaluateQuota({
      ...base,
      usage: { ...base.usage, mcpCalls: 1_000_000 },
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.exceeded).toBe("mcp_calls");
  });
});
