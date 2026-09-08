// =============================================================
// MCP resources: the spec-D4 / plan-Task-8 surface.
//
// Three resources ship — rovenue://paywall/{id}, rovenue://catalog/products,
// rovenue://experiments — each a thin read over the same chat handler its
// mirror tool calls (get_paywall, list_catalog, list_experiments).
// rovenue://schema/clickhouse ships only with run_analytics_query (spec D4
// + D7: "its only mirror is that tool's schema mode") and stays out while
// that tool does. Mirror rule: client support for resources is uneven, so
// nothing load-bearing may live only in a resource.
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
  "rovenue://catalog/products": "list_catalog",
  "rovenue://experiments": "list_experiments",
  "rovenue://paywall/{id}": "get_paywall",
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

async function seedPaywall(projectId: string, suffix: string) {
  const db = getDb();
  const [offering] = await db
    .insert(drizzle.schema.offerings)
    .values({
      projectId,
      identifier: `res-offering-${RUN_ID}-${suffix}`,
    })
    .returning();
  const [paywall] = await db
    .insert(drizzle.schema.paywalls)
    .values({
      projectId,
      identifier: `res-paywall-${RUN_ID}-${suffix}`,
      name: `Resources Paywall ${suffix}`,
      offeringId: offering!.id,
    })
    .returning();
  return paywall!;
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
  it("serves exactly the three spec resources, each mirrored by a tool", async () => {
    const { raw } = await seedReadToken("mirror");
    const resources = await listMcpResources(raw);
    const tools = await listMcpToolNames(raw);
    expect(resources.sort()).toEqual(Object.keys(MIRRORS).sort());
    for (const uri of resources) {
      expect(tools).toContain(MIRRORS[uri]);
    }
  });

  it("rovenue://catalog/products reads the project's catalog", async () => {
    const { raw } = await seedReadToken("catalog");
    const catalog = (await readResource(
      raw,
      "rovenue://catalog/products",
    )) as {
      products?: unknown[];
      productGroups?: unknown[];
      truncationNote?: unknown;
    };
    expect(catalog.products).toBeInstanceOf(Array);
    expect(catalog.productGroups).toBeInstanceOf(Array);
    expect("truncationNote" in catalog).toBe(true);
  });

  it("rovenue://experiments lists the project's experiments", async () => {
    const { raw, projectId } = await seedReadToken("explist");
    await seedExperiment(projectId, "listed");
    const body = (await readResource(raw, "rovenue://experiments")) as {
      experiments?: Array<{ id?: string }>;
    };
    expect(body.experiments).toBeInstanceOf(Array);
    expect(body.experiments!.length).toBeGreaterThan(0);
  });

  it("a paywall resource is scoped to the token's project", async () => {
    const { raw } = await seedReadToken("paywall-scope");
    const other = await seedProject("paywall-scope-other");
    const foreign = await seedPaywall(other.id, "foreign");
    await expect(
      readResource(raw, `rovenue://paywall/${foreign.id}`),
    ).rejects.toThrow();
  });

  it("rovenue://paywall/{id} serves the tree summary, never raw config", async () => {
    const { raw, projectId } = await seedReadToken("paywall-tree");
    const paywall = await seedPaywall(projectId, "tree");
    const body = (await readResource(
      raw,
      `rovenue://paywall/${paywall.id}`,
    )) as { paywallId?: string; nodes?: unknown[] };
    expect(body.paywallId).toBe(paywall.id);
    expect(body.nodes).toBeInstanceOf(Array);
    expect(JSON.stringify(body)).not.toContain("builderConfig");
  });
});
