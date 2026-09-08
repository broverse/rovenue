// =============================================================
// MCP resources: project info, funnel structure, experiment status.
//
// URI decision: the design spec (D2) names project://, funnel://, and
// experiment:// with scheme-per-entity rationale. The Task 8 brief sketch
// uses rovenue://paywall| catalog|experiments without explanation — the
// ratified spec wins, so the test pins the SPEC's three URIs. Likewise
// project://info carries only data that exists (id, name, server
// version): there is no plan/limits source to mirror.
//
// Mirror rule: client support for resources is uneven, so nothing
// ACTIONABLE may live only in a resource. funnel:// and experiment://
// re-read entity state reachable via find_funnels / list_experiments;
// project://info is static reference context with no actionable payload,
// so it asserts a fixed key set instead of a tool mirror.
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

const RUN_ID = Date.now();
const TEST_BCRYPT_ROUNDS = 4;

const MIRRORS: Record<string, string> = {
  "funnel://{id}/structure": "find_funnels",
  "experiment://{id}/status": "list_experiments",
};

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
        [CLIENT_INFO_META_KEY]: { name: "resources-test", version: "0.0.1" },
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

async function mcpCall(raw: string, method: string, params: unknown) {
  const res = await buildMcpApp().request("/mcp", {
    method: "POST",
    headers: mcpHeaders(raw, method),
    body: envelope(1, method, params),
  });
  return (await res.json()) as {
    result?: {
      resources?: Array<{ uri: string }>;
      resourceTemplates?: Array<{ uriTemplate: string }>;
      contents?: Array<{ uri?: string; mimeType?: string; text?: string }>;
    };
    error?: { message?: string };
  };
}

async function listMcpResources(raw: string): Promise<string[]> {
  const [res, tpl] = await Promise.all([
    mcpCall(raw, "resources/list", {}),
    mcpCall(raw, "resources/templates/list", {}),
  ]);
  return [
    ...(res.result?.resources ?? []).map((r) => r.uri),
    ...(tpl.result?.resourceTemplates ?? []).map((t) => t.uriTemplate),
  ];
}

async function readResource(raw: string, uri: string): Promise<unknown> {
  const res = await buildMcpApp().request("/mcp", {
    method: "POST",
    // Mcp-Name carries the URI itself (not the registered name) — header
    // and params.uri must agree or the entry answers 400.
    headers: { ...mcpHeaders(raw, "resources/read"), "mcp-name": uri },
    body: envelope(3, "resources/read", { uri }),
  });
  const body = (await res.json()) as {
    result?: { contents?: Array<{ text?: string }> };
    error?: { message?: string };
  };
  if (body.error) throw new Error(body.error.message ?? "resource read failed");
  const text = body.result?.contents?.[0]?.text;
  if (typeof text !== "string") throw new Error("empty resource");
  return JSON.parse(text);
}

async function seedUser(suffix: string) {
  const db = getDb();
  const id = `usr_mcpres_${RUN_ID}${suffix}`;
  await db.insert(drizzle.schema.user).values({
    id,
    name: `MCP Resources User ${suffix}`,
    email: `mcpres_${RUN_ID}_${suffix}@rovenue.test`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  return { id };
}

async function seedProject(suffix = "") {
  const db = getDb();
  const id = `prj_mcpres_${RUN_ID}${suffix}`;
  await db.insert(projects).values({
    id,
    name: `MCP Resources Project ${RUN_ID}${suffix}`,
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

async function seedReadToken(suffix: string) {
  const project = await seedProject(suffix);
  const { userId } = await seedOwner(project.id, suffix);
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
  return { raw, projectId: project.id };
}

async function seedFunnel(projectId: string, suffix: string) {
  const row = await drizzle.funnelRepo.insert(drizzle.db, {
    projectId,
    slug: `res-funnel-${RUN_ID}-${suffix}`,
    name: `Resources Funnel ${suffix}`,
  });
  return row;
}

async function seedExperiment(projectId: string, suffix: string) {
  const audience = await drizzle.audienceRepo.createAudience(drizzle.db, {
    projectId,
    name: `Resources Audience ${suffix}`,
    rules: {},
  });
  const experiment = await drizzle.experimentRepo.createExperiment(drizzle.db, {
    projectId,
    name: `Resources Experiment ${suffix}`,
    type: "FLAG",
    key: `res_exp_${RUN_ID}_${suffix}`,
    audienceId: audience.id,
    status: "RUNNING",
    variants: [
      { key: "control", allocation: 50 },
      { key: "treatment", allocation: 50 },
    ],
    metrics: [{ key: "conversion" }],
  });
  return experiment;
}

async function listMcpToolNames(raw: string): Promise<string[]> {
  const res = await buildMcpApp().request("/mcp", {
    method: "POST",
    headers: mcpHeaders(raw, "tools/list"),
    body: envelope(2, "tools/list", {}),
  });
  const body = (await res.json()) as {
    result?: { tools?: Array<{ name: string }> };
  };
  return (body.result?.tools ?? []).map((t) => t.name);
}

const seededProjectIds: string[] = [];

afterAll(async () => {
  const db = getDb();
  for (const id of seededProjectIds) {
    await db.delete(projects).where(eq(projects.id, id));
  }
});

describe("MCP resources", () => {
  it("every resource is mirrored by a tool", async () => {
    const { raw } = await seedReadToken("mirror");
    const resources = await listMcpResources(raw);
    const tools = await listMcpToolNames(raw);
    expect(resources).toContain("project://info");
    for (const uri of resources) {
      if (uri === "project://info") continue;
      expect(tools).toContain(MIRRORS[uri]);
    }
  });

  it("project://info is fixed reference context, nothing actionable", async () => {
    const { raw, projectId } = await seedReadToken("info");
    const info = (await readResource(raw, "project://info")) as Record<
      string,
      unknown
    >;
    expect(Object.keys(info).sort()).toEqual([
      "mcpServerVersion",
      "projectId",
      "projectName",
    ]);
    expect(info.projectId).toBe(projectId);
  });

  it("a funnel resource is scoped to the token's project", async () => {
    const { raw } = await seedReadToken("funnel-scope");
    const other = await seedProject("funnel-scope-other");
    const foreign = await seedFunnel(other.id, "foreign");
    await expect(
      readResource(raw, `funnel://${foreign.id}/structure`),
    ).rejects.toThrow();
  });

  it("an experiment resource is scoped to the token's project", async () => {
    const { raw } = await seedReadToken("exp-scope");
    const other = await seedProject("exp-scope-other");
    const foreign = await seedExperiment(other.id, "foreign");
    await expect(
      readResource(raw, `experiment://${foreign.id}/status`),
    ).rejects.toThrow();
  });

  it("funnel structure carries the page skeleton, never page JSON", async () => {
    const { raw, projectId } = await seedReadToken("funnel-pages");
    const funnel = await seedFunnel(projectId, "pages");
    const structure = (await readResource(
      raw,
      `funnel://${funnel.id}/structure`,
    )) as { pages?: unknown[] };
    expect(structure.pages).toBeInstanceOf(Array);
    expect(JSON.stringify(structure)).not.toContain("elements");
  });
});
