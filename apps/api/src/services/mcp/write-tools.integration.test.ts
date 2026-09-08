// =============================================================
// MCP write tools: start_experiment / stop_experiment.
//
// Propose-and-confirm through the copilot intent flow with in-band
// elicitation. The first call creates a pending intent and returns
// input_required WITHOUT mutating; the client re-issues the call with
// the elicitation response + echoed requestState, and only an accepted
// confirm executes. No confirm_intent tool exists by design (spec D5):
// the human gate must not be callable by the agent.
// =============================================================

import { randomBytes } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { Hono } from "hono";
import { desc, eq } from "drizzle-orm";
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

const RUN_ID = Date.now();
const TEST_BCRYPT_ROUNDS = 4;

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
        [CLIENT_INFO_META_KEY]: { name: "write-tools-test", version: "0.0.1" },
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

interface ToolCallResult {
  isError: boolean;
  text: string;
  structured: Record<string, unknown> | null;
  rawResult: Record<string, unknown>;
}

async function callTool(
  raw: string,
  tool: string,
  args: unknown,
  roundTrip?: { inputResponses: unknown; requestState: string },
): Promise<ToolCallResult> {
  const res = await buildMcpApp().request("/mcp", {
    method: "POST",
    headers: { ...mcpHeaders(raw, "tools/call"), "mcp-name": tool },
    body: envelope(2, "tools/call", {
      name: tool,
      arguments: args,
      ...(roundTrip ?? {}),
    }),
  });
  const body = (await res.json()) as {
    result?: {
      content?: Array<{ type: string; text?: string }>;
      structuredContent?: Record<string, unknown>;
      isError?: boolean;
      resultType?: string;
      inputRequests?: Record<string, unknown>;
      requestState?: string;
    };
    error?: { message?: string };
  };
  if (body.error) {
    return {
      isError: true,
      text: body.error.message ?? "",
      structured: null,
      rawResult: {},
    };
  }
  const text = (body.result?.content ?? [])
    .map((c) => c.text ?? "")
    .join("\n");
  return {
    isError: body.result?.isError ?? false,
    text,
    structured: body.result?.structuredContent ?? null,
    rawResult: (body.result ?? {}) as Record<string, unknown>,
  };
}

async function seedUser(suffix: string) {
  const db = getDb();
  const id = `usr_mcpwrite_${RUN_ID}${suffix}`;
  await db.insert(drizzle.schema.user).values({
    id,
    name: `MCP Write User ${suffix}`,
    email: `mcpwrite_${RUN_ID}_${suffix}@rovenue.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { id };
}

async function seedProject(suffix = "") {
  const db = getDb();
  const id = `prj_mcpwrite_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `MCP Write Project ${RUN_ID}${suffix}`,
  });
  seededProjectIds.push(id);
  return { id };
}

async function seedToken(
  suffix: string,
  scope: "read" | "read_write",
  role: "OWNER" | "CUSTOMER_SUPPORT" = "OWNER",
) {
  const project = await seedProject(suffix);
  const { id: userId } = await seedUser(suffix);
  await getDb().insert(drizzle.schema.projectMembers).values({
    projectId: project.id,
    userId,
    role,
  });
  const tokenId = createId();
  const raw = `${MCP_TOKEN_PREFIX}${tokenId}_${randomBytes(16).toString("base64url")}`;
  await drizzle.mcpTokenRepo.create(drizzle.db, {
    id: tokenId,
    projectId: project.id,
    userId,
    label: `test token ${RUN_ID}`,
    scope,
    keyPublic: `${MCP_TOKEN_PREFIX}${tokenId}`,
    keySecretHash: await bcrypt.hash(raw, TEST_BCRYPT_ROUNDS),
    expiresAt: null,
  });
  return { raw, projectId: project.id, userId };
}

async function seedExperiment(projectId: string, suffix: string) {
  const audience = await drizzle.audienceRepo.createAudience(drizzle.db, {
    projectId,
    name: `Write Audience ${suffix}`,
    rules: {},
  });
  const experiment = await drizzle.experimentRepo.createExperiment(drizzle.db, {
    projectId,
    name: `Write Experiment ${suffix}`,
    type: "FLAG",
    key: `write_exp_${RUN_ID}_${suffix}`,
    audienceId: audience.id,
    status: "DRAFT",
    variants: [
      { key: "control", allocation: 50 },
      { key: "treatment", allocation: 50 },
    ],
    metrics: [{ key: "conversion" }],
  });
  return experiment;
}

async function getExperimentStatus(experimentId: string, projectId: string) {
  const row = await drizzle.experimentRepo.findByIdInProject(
    drizzle.db,
    experimentId,
    projectId,
  );
  return row?.status ?? null;
}

async function latestAuditRow(projectId: string) {
  const db = getDb();
  const [row] = await db
    .select()
    .from(drizzle.schema.auditLogs)
    .where(eq(drizzle.schema.auditLogs.projectId, projectId))
    .orderBy(desc(drizzle.schema.auditLogs.createdAt))
    .limit(1);
  return row ?? null;
}

async function countIntents(): Promise<number> {
  const rows = await getDb()
    .select({ id: drizzle.schema.copilotIntents.id })
    .from(drizzle.schema.copilotIntents);
  return rows.length;
}

const seededProjectIds: string[] = [];

afterAll(async () => {
  const db = getDb();
  for (const id of seededProjectIds) {
    await db.delete(projects).where(eq(projects.id, id));
  }
});

describe("MCP write tools", () => {
  it("proposes rather than mutating, and mutates only after confirmation", async () => {
    const { raw, projectId } = await seedToken("propose", "read_write");
    const experiment = await seedExperiment(projectId, "propose");

    const proposal = await callTool(raw, "stop_experiment", {
      experimentId: experiment.id,
    });
    expect(proposal.isError).toBe(false);
    // The first call must NOT have changed anything.
    expect(await getExperimentStatus(experiment.id, projectId)).toBe("DRAFT");
    // input_required with an elicitation request and echoed state.
    expect(proposal.rawResult.resultType).toBe("input_required");
    expect(proposal.rawResult.inputRequests).toHaveProperty("confirm");
    const requestState = proposal.rawResult.requestState;
    expect(typeof requestState).toBe("string");

    const confirmed = await callTool(
      raw,
      "stop_experiment",
      { experimentId: experiment.id },
      {
        inputResponses: {
          confirm: { action: "accept", content: { confirm: true } },
        },
        requestState: requestState as string,
      },
    );
    expect(confirmed.isError).toBe(false);
    expect(await getExperimentStatus(experiment.id, projectId)).toBe(
      "COMPLETED",
    );
  });

  it("writes an audit row naming the token's owner, not an API key", async () => {
    const { raw, projectId, userId } = await seedToken("audit", "read_write");
    const experiment = await seedExperiment(projectId, "audit");

    const proposal = await callTool(raw, "start_experiment", {
      experimentId: experiment.id,
    });
    const confirmed = await callTool(
      raw,
      "start_experiment",
      { experimentId: experiment.id },
      {
        inputResponses: {
          confirm: { action: "accept", content: { confirm: true } },
        },
        requestState: proposal.rawResult.requestState as string,
      },
    );
    expect(confirmed.isError).toBe(false);

    const row = await latestAuditRow(projectId);
    expect(row?.userId).toBe(userId);
    expect(row?.resource).toBe("experiment");
  });

  it("declines cleanly when the user refuses", async () => {
    const { raw, projectId } = await seedToken("decline", "read_write");
    const experiment = await seedExperiment(projectId, "decline");

    const proposal = await callTool(raw, "stop_experiment", {
      experimentId: experiment.id,
    });
    const declined = await callTool(
      raw,
      "stop_experiment",
      { experimentId: experiment.id },
      {
        inputResponses: { confirm: { action: "decline" } },
        requestState: proposal.rawResult.requestState as string,
      },
    );
    expect(declined.isError).toBe(true);
    expect(await getExperimentStatus(experiment.id, projectId)).not.toBe(
      "COMPLETED",
    );
  });

  it("a read token cannot propose: protocol refusal, no intent row", async () => {
    const before = await countIntents();
    const { raw } = await seedToken("readgate", "read");
    const res = await callTool(raw, "stop_experiment", {
      experimentId: "whatever",
    });
    expect(res.isError).toBe(true);
    expect(await countIntents()).toBe(before);
  });
});
