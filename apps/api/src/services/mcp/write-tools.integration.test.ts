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
import { afterAll, beforeAll, describe, expect, it } from "vitest";
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
import { buildStorageKey } from "../../lib/asset-store";
import { errorHandler } from "../../middleware/error";
import { MCP_PROTOCOL_REVISION } from "./server";
import { mcpRoute } from "../../routes/mcp";
import { registerAllIntentHandlers } from "../copilot/intent-handlers";

beforeAll(() => {
  // HANDLERS is a Map — .set() is idempotent; safe even if app.ts
  // startup already registered. Without this the file depends on
  // whichever suite happened to share its worker.
  registerAllIntentHandlers();
});

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

async function seedOffering(projectId: string, suffix: string) {
  return drizzle.offeringRepo.createOffering(drizzle.db, {
    projectId,
    identifier: `mcp_off_${RUN_ID}_${suffix}`.toLowerCase(),
    isDefault: false,
    packages: [],
  });
}

async function seedPaywall(
  projectId: string,
  offeringId: string,
  suffix: string,
) {
  return drizzle.paywallRepo.createPaywall(drizzle.db, {
    projectId,
    identifier: `mcp-pw-${RUN_ID}-${suffix}`.toLowerCase(),
    name: `MCP Paywall ${suffix}`,
    offeringId,
    remoteConfig: { defaultLocale: "en", locales: { en: {} } },
  });
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

  it("rejects an expired intent without mutating", async () => {
    const { raw, projectId } = await seedToken("expired", "read_write");
    const experiment = await seedExperiment(projectId, "expired");
    const proposal = await callTool(raw, "stop_experiment", {
      experimentId: experiment.id,
    });
    const requestState = proposal.rawResult.requestState as string;
    // Backdate past the 5-minute TTL directly: the retry must observe
    // expiry server-side, not trust the echoed state.
    await getDb()
      .update(drizzle.schema.copilotIntents)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(drizzle.schema.copilotIntents.id, requestState));
    const res = await callTool(
      raw,
      "stop_experiment",
      { experimentId: experiment.id },
      {
        inputResponses: {
          confirm: { action: "accept", content: { confirm: true } },
        },
        requestState,
      },
    );
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/expired/i);
    expect(await getExperimentStatus(experiment.id, projectId)).toBe("DRAFT");
  });

  it("a confirmed intent cannot execute twice (replay is a tool error)", async () => {
    const { raw, projectId } = await seedToken("replay", "read_write");
    const experiment = await seedExperiment(projectId, "replay");
    const proposal = await callTool(raw, "stop_experiment", {
      experimentId: experiment.id,
    });
    const roundTrip = {
      inputResponses: {
        confirm: { action: "accept", content: { confirm: true } },
      },
      requestState: proposal.rawResult.requestState as string,
    };
    const first = await callTool(
      raw,
      "stop_experiment",
      { experimentId: experiment.id },
      roundTrip,
    );
    expect(first.isError).toBe(false);
    // Same confirmation replayed: the intent is executed, not pending.
    const second = await callTool(
      raw,
      "stop_experiment",
      { experimentId: experiment.id },
      roundTrip,
    );
    expect(second.isError).toBe(true);
    expect(second.text).toMatch(/already executed/i);
  });

  it("a forged cross-project intent id fails closed", async () => {
    const { raw, projectId } = await seedToken("forged", "read_write");
    const experiment = await seedExperiment(projectId, "forged");
    // An intent from ANOTHER project: the retry echoes its id, but the
    // server re-checks project ownership against live auth, not the echo.
    const other = await seedProject("forged-other");
    const foreign = await drizzle.copilotIntentRepo.createIntent(drizzle.db, {
      projectId: other.id,
      userId: "someone-else",
      threadId: "",
      messageId: "",
      toolName: "action_experiments_stop",
      payload: { experimentId: experiment.id, reason: "" },
      preview: { title: "trap", fields: [] },
      requiresRole: "ADMIN",
    });
    const res = await callTool(
      raw,
      "stop_experiment",
      { experimentId: experiment.id },
      {
        inputResponses: {
          confirm: { action: "accept", content: { confirm: true } },
        },
        requestState: foreign.id,
      },
    );
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/not found in this project/i);
    expect(await getExperimentStatus(experiment.id, projectId)).toBe("DRAFT");
  });
});

describe("MCP catalog create tools", () => {
  it("create_product proposes, then creates on confirmation", async () => {
    const { raw, projectId } = await seedToken("prod", "read_write");
    const args = {
      identifier: `mcp_prod_${RUN_ID}`,
      type: "SUBSCRIPTION",
      displayName: "MCP Product",
    };

    const proposal = await callTool(raw, "create_product", args);
    expect(proposal.isError).toBe(false);
    // The first call must NOT have created anything.
    expect(
      await drizzle.productRepo.findProductByIdentifier(
        drizzle.db,
        projectId,
        args.identifier,
      ),
    ).toBeNull();
    expect(proposal.rawResult.resultType).toBe("input_required");
    expect(proposal.rawResult.inputRequests).toHaveProperty("confirm");

    const confirmed = await callTool(raw, "create_product", args, {
      inputResponses: {
        confirm: { action: "accept", content: { confirm: true } },
      },
      requestState: proposal.rawResult.requestState as string,
    });
    expect(confirmed.isError).toBe(false);
    const row = await drizzle.productRepo.findProductByIdentifier(
      drizzle.db,
      projectId,
      args.identifier,
    );
    expect(row?.displayName).toBe("MCP Product");
    expect(row?.type).toBe("SUBSCRIPTION");
  });

  it("create_product writes an audit row naming the token's owner", async () => {
    const { raw, projectId, userId } = await seedToken("prodaudit", "read_write");
    const args = {
      identifier: `mcp_prod_audit_${RUN_ID}`,
      type: "CONSUMABLE",
      displayName: "MCP Audited Product",
    };
    const proposal = await callTool(raw, "create_product", args);
    const confirmed = await callTool(raw, "create_product", args, {
      inputResponses: {
        confirm: { action: "accept", content: { confirm: true } },
      },
      requestState: proposal.rawResult.requestState as string,
    });
    expect(confirmed.isError).toBe(false);

    const row = await latestAuditRow(projectId);
    expect(row?.userId).toBe(userId);
    expect(row?.action).toBe("product.created");
    expect(row?.resource).toBe("product");
  });

  it("create_product refuses a duplicate identifier without creating", async () => {
    const { raw } = await seedToken("proddup", "read_write");
    const args = {
      identifier: `mcp_prod_dup_${RUN_ID}`,
      type: "SUBSCRIPTION",
      displayName: "MCP Dup Product",
    };
    const first = await callTool(raw, "create_product", args);
    const firstConfirmed = await callTool(raw, "create_product", args, {
      inputResponses: {
        confirm: { action: "accept", content: { confirm: true } },
      },
      requestState: first.rawResult.requestState as string,
    });
    expect(firstConfirmed.isError).toBe(false);

    const second = await callTool(raw, "create_product", args);
    const secondConfirmed = await callTool(raw, "create_product", args, {
      inputResponses: {
        confirm: { action: "accept", content: { confirm: true } },
      },
      requestState: second.rawResult.requestState as string,
    });
    expect(secondConfirmed.isError).toBe(true);
    expect(secondConfirmed.text).toMatch(/already in use/i);
  });

  it("create_offering proposes, then creates on confirmation", async () => {
    const { raw, projectId } = await seedToken("off", "read_write");
    const product = await drizzle.productRepo.createProduct(drizzle.db, {
      projectId,
      identifier: `mcp_off_prod_${RUN_ID}`,
      type: "SUBSCRIPTION",
      displayName: "Offering Product",
      storeIds: {},
    });
    const args = {
      identifier: `mcp_off_${RUN_ID}`,
      packages: [
        { identifier: "standard", productId: product.id, order: 0 },
      ],
    };

    const proposal = await callTool(raw, "create_offering", args);
    expect(proposal.isError).toBe(false);
    expect(
      await drizzle.offeringRepo.findOfferingByIdentifier(
        drizzle.db,
        projectId,
        args.identifier,
      ),
    ).toBeNull();

    const confirmed = await callTool(raw, "create_offering", args, {
      inputResponses: {
        confirm: { action: "accept", content: { confirm: true } },
      },
      requestState: proposal.rawResult.requestState as string,
    });
    expect(confirmed.isError).toBe(false);
    const row = await drizzle.offeringRepo.findOfferingByIdentifier(
      drizzle.db,
      projectId,
      args.identifier,
    );
    expect(row?.identifier).toBe(args.identifier);
  });

  it("create_offering declines cleanly when the user refuses", async () => {
    const { raw, projectId } = await seedToken("offdecline", "read_write");
    const args = { identifier: `mcp_off_dec_${RUN_ID}` };
    const proposal = await callTool(raw, "create_offering", args);
    const declined = await callTool(raw, "create_offering", args, {
      inputResponses: { confirm: { action: "decline" } },
      requestState: proposal.rawResult.requestState as string,
    });
    expect(declined.isError).toBe(true);
    expect(
      await drizzle.offeringRepo.findOfferingByIdentifier(
        drizzle.db,
        projectId,
        args.identifier,
      ),
    ).toBeNull();
  });

  it("create_entitlement proposes, then creates on confirmation", async () => {
    const { raw, projectId } = await seedToken("ent", "read_write");
    const args = {
      identifier: `ent_${RUN_ID}`,
      displayName: "MCP Entitlement",
    };

    const proposal = await callTool(raw, "create_entitlement", args);
    expect(proposal.isError).toBe(false);
    expect(
      await drizzle.accessCatalogRepo.findByIdentifier(
        drizzle.db,
        projectId,
        args.identifier,
      ),
    ).toBeNull();

    const confirmed = await callTool(raw, "create_entitlement", args, {
      inputResponses: {
        confirm: { action: "accept", content: { confirm: true } },
      },
      requestState: proposal.rawResult.requestState as string,
    });
    expect(confirmed.isError).toBe(false);
    const row = await drizzle.accessCatalogRepo.findByIdentifier(
      drizzle.db,
      projectId,
      args.identifier,
    );
    expect(row?.displayName).toBe("MCP Entitlement");
  });

  it("a confirmation echoing different args fails closed", async () => {
    const { raw, projectId } = await seedToken("entswap", "read_write");
    const proposed = {
      identifier: `ent_swap_a_${RUN_ID}`,
      displayName: "Swap A",
    };
    const proposal = await callTool(raw, "create_entitlement", proposed);
    const swapped = await callTool(
      raw,
      "create_entitlement",
      { identifier: `ent_swap_b_${RUN_ID}`, displayName: "Swap B" },
      {
        inputResponses: {
          confirm: { action: "accept", content: { confirm: true } },
        },
        requestState: proposal.rawResult.requestState as string,
      },
    );
    expect(swapped.isError).toBe(true);
    expect(swapped.text).toMatch(/does not match/i);
    expect(
      await drizzle.accessCatalogRepo.findByIdentifier(
        drizzle.db,
        projectId,
        `ent_swap_b_${RUN_ID}`,
      ),
    ).toBeNull();
  });

  it("a read token cannot propose a create: protocol refusal, no intent row", async () => {
    const before = await countIntents();
    const { raw } = await seedToken("creadgate", "read");
    const res = await callTool(raw, "create_product", {
      identifier: "whatever",
      type: "SUBSCRIPTION",
      displayName: "Whatever",
    });
    expect(res.isError).toBe(true);
    expect(await countIntents()).toBe(before);
  });
});

describe("MCP placement and audience create tools", () => {
  it("create_placement proposes, then creates on confirmation", async () => {
    const { raw, projectId } = await seedToken("place", "read_write");
    const args = {
      identifier: `mcp_place_${RUN_ID}`,
      name: "MCP Placement",
    };

    const proposal = await callTool(raw, "create_placement", args);
    expect(proposal.isError).toBe(false);
    // The first call must NOT have created anything.
    expect(
      await drizzle.placementRepo.findPlacementByIdentifier(
        drizzle.db,
        projectId,
        args.identifier,
      ),
    ).toBeNull();
    expect(proposal.rawResult.resultType).toBe("input_required");
    expect(proposal.rawResult.inputRequests).toHaveProperty("confirm");

    const confirmed = await callTool(raw, "create_placement", args, {
      inputResponses: {
        confirm: { action: "accept", content: { confirm: true } },
      },
      requestState: proposal.rawResult.requestState as string,
    });
    expect(confirmed.isError).toBe(false);
    const row = await drizzle.placementRepo.findPlacementByIdentifier(
      drizzle.db,
      projectId,
      args.identifier,
    );
    expect(row?.name).toBe("MCP Placement");
  });

  it("create_placement declines cleanly when the user refuses", async () => {
    const { raw, projectId } = await seedToken("placedec", "read_write");
    const args = {
      identifier: `mcp_place_dec_${RUN_ID}`,
      name: "MCP Declined Placement",
    };
    const proposal = await callTool(raw, "create_placement", args);
    const declined = await callTool(raw, "create_placement", args, {
      inputResponses: { confirm: { action: "decline" } },
      requestState: proposal.rawResult.requestState as string,
    });
    expect(declined.isError).toBe(true);
    expect(
      await drizzle.placementRepo.findPlacementByIdentifier(
        drizzle.db,
        projectId,
        args.identifier,
      ),
    ).toBeNull();
  });

  it("create_placement refuses a duplicate identifier without creating", async () => {
    const { raw } = await seedToken("placedup", "read_write");
    const args = {
      identifier: `mcp_place_dup_${RUN_ID}`,
      name: "MCP Dup Placement",
    };
    const first = await callTool(raw, "create_placement", args);
    const firstConfirmed = await callTool(raw, "create_placement", args, {
      inputResponses: {
        confirm: { action: "accept", content: { confirm: true } },
      },
      requestState: first.rawResult.requestState as string,
    });
    expect(firstConfirmed.isError).toBe(false);

    const second = await callTool(raw, "create_placement", args);
    const secondConfirmed = await callTool(raw, "create_placement", args, {
      inputResponses: {
        confirm: { action: "accept", content: { confirm: true } },
      },
      requestState: second.rawResult.requestState as string,
    });
    expect(secondConfirmed.isError).toBe(true);
    expect(secondConfirmed.text).toMatch(/already in use/i);
  });

  it("create_audience proposes, then creates on confirmation", async () => {
    const { raw, projectId } = await seedToken("aud", "read_write");
    const args = {
      name: `MCP Audience ${RUN_ID}`,
      rules: {},
    };

    const proposal = await callTool(raw, "create_audience", args);
    expect(proposal.isError).toBe(false);
    // The first call must NOT have created anything.
    const before = await drizzle.audienceRepo.listAudiences(
      drizzle.db,
      projectId,
    );
    expect(before.some((a) => a.name === args.name)).toBe(false);
    expect(proposal.rawResult.resultType).toBe("input_required");
    expect(proposal.rawResult.inputRequests).toHaveProperty("confirm");

    const confirmed = await callTool(raw, "create_audience", args, {
      inputResponses: {
        confirm: { action: "accept", content: { confirm: true } },
      },
      requestState: proposal.rawResult.requestState as string,
    });
    expect(confirmed.isError).toBe(false);
    const after = await drizzle.audienceRepo.listAudiences(
      drizzle.db,
      projectId,
    );
    expect(after.some((a) => a.name === args.name)).toBe(true);
  });

  it("a read token cannot propose a placement create: protocol refusal, no intent row", async () => {
    const before = await countIntents();
    const { raw } = await seedToken("preadgate", "read");
    const res = await callTool(raw, "create_placement", {
      identifier: "whatever",
      name: "Whatever",
    });
    expect(res.isError).toBe(true);
    expect(await countIntents()).toBe(before);
  });
});

describe("MCP asset delete tool", () => {
  async function seedAsset(projectId: string, suffix: string) {
    const assetId = createId();
    return drizzle.assetRepo.createAsset(drizzle.db, {
      id: assetId,
      projectId,
      kind: "image",
      name: `MCP Asset ${suffix}`,
      storageKey: buildStorageKey(projectId, assetId, "image"),
      contentHash: `mcp_hash_${RUN_ID}_${suffix}`,
      contentType: "image/webp",
      byteSize: 100,
      width: null,
      height: null,
      sourceFormat: null,
      sourceWidth: null,
      sourceHeight: null,
      policyVersion: 0,
    });
  }

  // Pins the asset behind a CURRENT published version's usage index
  // (the env-independent half of the in-use guard — the draft walk
  // needs ASSET_PUBLIC_BASE_URL, which the test env never sets, so
  // parseAssetUrl degrades to "no references" here by design).
  async function seedPublishedUsage(
    projectId: string,
    assetId: string,
    suffix: string,
  ) {
    const db = getDb();
    const [offering] = await db
      .insert(drizzle.schema.offerings)
      .values({ projectId, identifier: `off_mcpasset_${RUN_ID}_${suffix}` })
      .returning();
    const [paywall] = await db
      .insert(drizzle.schema.paywalls)
      .values({
        projectId,
        identifier: `pw_mcpasset_${RUN_ID}_${suffix}`,
        name: `MCP Asset Paywall ${suffix}`,
        offeringId: offering!.id,
        remoteConfig: { defaultLocale: "en" },
        builderConfig: null,
      })
      .returning();
    const [version] = await db
      .insert(drizzle.schema.paywallVersions)
      .values({
        paywallId: paywall!.id,
        versionNo: 1,
        remoteConfig: { defaultLocale: "en" },
        offeringId: offering!.id,
      })
      .returning();
    await db
      .update(drizzle.schema.paywalls)
      .set({ publishedVersionId: version!.id })
      .where(eq(drizzle.schema.paywalls.id, paywall!.id));
    await db.insert(drizzle.schema.paywallAssetUsages).values({
      assetId,
      paywallId: paywall!.id,
      versionId: version!.id,
    });
    return paywall!;
  }

  async function liveAsset(projectId: string, assetId: string) {
    return drizzle.assetRepo.findAssetById(drizzle.db, projectId, assetId);
  }

  it("delete_asset proposes, then deletes on confirmation", async () => {
    const { raw, projectId } = await seedToken("assetdel", "read_write");
    const asset = await seedAsset(projectId, "del");
    const args = { id: asset.id };

    const proposal = await callTool(raw, "delete_asset", args);
    expect(proposal.isError).toBe(false);
    // The first call must NOT have deleted anything.
    expect(await liveAsset(projectId, asset.id)).not.toBeNull();
    expect(proposal.rawResult.resultType).toBe("input_required");
    expect(proposal.rawResult.inputRequests).toHaveProperty("confirm");

    const confirmed = await callTool(raw, "delete_asset", args, {
      inputResponses: {
        confirm: { action: "accept", content: { confirm: true } },
      },
      requestState: proposal.rawResult.requestState as string,
    });
    expect(confirmed.isError).toBe(false);
    expect(await liveAsset(projectId, asset.id)).toBeNull();
  });

  it("delete_asset writes an audit row naming the token's owner", async () => {
    const { raw, projectId, userId } = await seedToken(
      "assetaudit",
      "read_write",
    );
    const asset = await seedAsset(projectId, "audit");
    const args = { id: asset.id };
    const proposal = await callTool(raw, "delete_asset", args);
    const confirmed = await callTool(raw, "delete_asset", args, {
      inputResponses: {
        confirm: { action: "accept", content: { confirm: true } },
      },
      requestState: proposal.rawResult.requestState as string,
    });
    expect(confirmed.isError).toBe(false);

    const row = await latestAuditRow(projectId);
    expect(row?.userId).toBe(userId);
    expect(row?.action).toBe("asset.deleted");
    expect(row?.resource).toBe("paywall_asset");
  });

  it("delete_asset declines cleanly when the user refuses", async () => {
    const { raw, projectId } = await seedToken("assetdec", "read_write");
    const asset = await seedAsset(projectId, "dec");
    const args = { id: asset.id };
    const proposal = await callTool(raw, "delete_asset", args);
    const declined = await callTool(raw, "delete_asset", args, {
      inputResponses: { confirm: { action: "decline" } },
      requestState: proposal.rawResult.requestState as string,
    });
    expect(declined.isError).toBe(true);
    expect(await liveAsset(projectId, asset.id)).not.toBeNull();
  });

  it("refuses an in-use asset without force", async () => {
    const { raw, projectId } = await seedToken("assetuse", "read_write");
    const asset = await seedAsset(projectId, "use");
    await seedPublishedUsage(projectId, asset.id, "use");
    const args = { id: asset.id };

    const proposal = await callTool(raw, "delete_asset", args);
    expect(proposal.isError).toBe(false);
    const refused = await callTool(raw, "delete_asset", args, {
      inputResponses: {
        confirm: { action: "accept", content: { confirm: true } },
      },
      requestState: proposal.rawResult.requestState as string,
    });
    expect(refused.isError).toBe(true);
    expect(refused.text).toMatch(/referenced by/i);
    expect(await liveAsset(projectId, asset.id)).not.toBeNull();
  });

  it("force deletes an in-use asset", async () => {
    const { raw, projectId } = await seedToken("assetforce", "read_write");
    const asset = await seedAsset(projectId, "force");
    await seedPublishedUsage(projectId, asset.id, "force");
    const args = { id: asset.id, force: "true" };

    const proposal = await callTool(raw, "delete_asset", args);
    expect(proposal.isError).toBe(false);
    const confirmed = await callTool(raw, "delete_asset", args, {
      inputResponses: {
        confirm: { action: "accept", content: { confirm: true } },
      },
      requestState: proposal.rawResult.requestState as string,
    });
    expect(confirmed.isError).toBe(false);
    expect(await liveAsset(projectId, asset.id)).toBeNull();
  });

  it("fails closed on an unknown asset id", async () => {
    const { raw, projectId } = await seedToken("assetmiss", "read_write");
    const args = { id: "as_missing" };
    const proposal = await callTool(raw, "delete_asset", args);
    expect(proposal.isError).toBe(false);
    const res = await callTool(raw, "delete_asset", args, {
      inputResponses: {
        confirm: { action: "accept", content: { confirm: true } },
      },
      requestState: proposal.rawResult.requestState as string,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/not found/i);
    expect(await liveAsset(projectId, "as_missing")).toBeNull();
  });

  it("a confirmation echoing a different id fails closed", async () => {
    const { raw, projectId } = await seedToken("assetswap", "read_write");
    const kept = await seedAsset(projectId, "swap-kept");
    const other = await seedAsset(projectId, "swap-other");
    const proposal = await callTool(raw, "delete_asset", { id: kept.id });
    const swapped = await callTool(
      raw,
      "delete_asset",
      { id: other.id },
      {
        inputResponses: {
          confirm: { action: "accept", content: { confirm: true } },
        },
        requestState: proposal.rawResult.requestState as string,
      },
    );
    expect(swapped.isError).toBe(true);
    expect(swapped.text).toMatch(/does not match/i);
    expect(await liveAsset(projectId, kept.id)).not.toBeNull();
    expect(await liveAsset(projectId, other.id)).not.toBeNull();
  });

  it("a read token cannot propose a delete: protocol refusal, no intent row", async () => {
    const before = await countIntents();
    const { raw } = await seedToken("areadgate", "read");
    const res = await callTool(raw, "delete_asset", { id: "whatever" });
    expect(res.isError).toBe(true);
    expect(await countIntents()).toBe(before);
  });
});

describe("MCP virtual currency create tool", () => {
  it("create_virtual_currency proposes, then creates on confirmation", async () => {
    const { raw, projectId } = await seedToken("vcur", "read_write");
    const args = { code: `GEM${RUN_ID % 100000}`, name: "MCP Gems" };

    const proposal = await callTool(raw, "create_virtual_currency", args);
    expect(proposal.isError).toBe(false);
    // The first call must NOT have created anything.
    expect(
      await drizzle.virtualCurrencyRepo.findVirtualCurrencyByCode(
        drizzle.db,
        projectId,
        args.code,
      ),
    ).toBeNull();
    expect(proposal.rawResult.resultType).toBe("input_required");
    expect(proposal.rawResult.inputRequests).toHaveProperty("confirm");

    const confirmed = await callTool(raw, "create_virtual_currency", args, {
      inputResponses: {
        confirm: { action: "accept", content: { confirm: true } },
      },
      requestState: proposal.rawResult.requestState as string,
    });
    expect(confirmed.isError).toBe(false);
    const row =
      await drizzle.virtualCurrencyRepo.findVirtualCurrencyByCode(
        drizzle.db,
        projectId,
        args.code,
      );
    expect(row?.name).toBe("MCP Gems");
  });

  it("create_virtual_currency writes an audit row naming the token's owner", async () => {
    const { raw, projectId, userId } = await seedToken("vcuraudit", "read_write");
    const args = { code: `AUD${RUN_ID % 100000}`, name: "MCP Audited Gems" };
    const proposal = await callTool(raw, "create_virtual_currency", args);
    const confirmed = await callTool(raw, "create_virtual_currency", args, {
      inputResponses: {
        confirm: { action: "accept", content: { confirm: true } },
      },
      requestState: proposal.rawResult.requestState as string,
    });
    expect(confirmed.isError).toBe(false);

    const row = await latestAuditRow(projectId);
    expect(row?.userId).toBe(userId);
    expect(row?.action).toBe("virtual_currency.created");
    expect(row?.resource).toBe("virtual_currency");
  });

  it("create_virtual_currency declines cleanly when the user refuses", async () => {
    const { raw, projectId } = await seedToken("vcurdec", "read_write");
    const args = { code: `DEC${RUN_ID % 100000}`, name: "MCP Declined Gems" };
    const proposal = await callTool(raw, "create_virtual_currency", args);
    const declined = await callTool(raw, "create_virtual_currency", args, {
      inputResponses: { confirm: { action: "decline" } },
      requestState: proposal.rawResult.requestState as string,
    });
    expect(declined.isError).toBe(true);
    expect(
      await drizzle.virtualCurrencyRepo.findVirtualCurrencyByCode(
        drizzle.db,
        projectId,
        args.code,
      ),
    ).toBeNull();
  });

  it("create_virtual_currency refuses a duplicate code without creating", async () => {
    const { raw } = await seedToken("vcurdup", "read_write");
    const args = { code: `DUP${RUN_ID % 100000}`, name: "MCP Dup Gems" };
    const first = await callTool(raw, "create_virtual_currency", args);
    const firstConfirmed = await callTool(raw, "create_virtual_currency", args, {
      inputResponses: {
        confirm: { action: "accept", content: { confirm: true } },
      },
      requestState: first.rawResult.requestState as string,
    });
    expect(firstConfirmed.isError).toBe(false);

    const second = await callTool(raw, "create_virtual_currency", args);
    const secondConfirmed = await callTool(
      raw,
      "create_virtual_currency",
      args,
      {
        inputResponses: {
          confirm: { action: "accept", content: { confirm: true } },
        },
        requestState: second.rawResult.requestState as string,
      },
    );
    expect(secondConfirmed.isError).toBe(true);
    expect(secondConfirmed.text).toMatch(/already in use/i);
  });

  it("a read token cannot propose a currency create: protocol refusal, no intent row", async () => {
    const before = await countIntents();
    const { raw } = await seedToken("vcreadgate", "read");
    const res = await callTool(raw, "create_virtual_currency", {
      code: "GEMS",
      name: "Whatever",
    });
    expect(res.isError).toBe(true);
    expect(await countIntents()).toBe(before);
  });
});

describe("MCP funnel create and edit tools", () => {
  it("create_funnel proposes, then creates on confirmation", async () => {
    const { raw, projectId, userId } = await seedToken("funnel", "read_write");
    const args = { name: `MCP Funnel ${RUN_ID}` };

    const proposal = await callTool(raw, "create_funnel", args);
    expect(proposal.isError).toBe(false);
    // The first call must NOT have created anything.
    expect(
      (await drizzle.funnelRepo.listByProject(drizzle.db, projectId)).some(
        (f) => f.name === args.name,
      ),
    ).toBe(false);
    expect(proposal.rawResult.resultType).toBe("input_required");
    expect(proposal.rawResult.inputRequests).toHaveProperty("confirm");

    const confirmed = await callTool(raw, "create_funnel", args, {
      inputResponses: {
        confirm: { action: "accept", content: { confirm: true } },
      },
      requestState: proposal.rawResult.requestState as string,
    });
    expect(confirmed.isError).toBe(false);
    const rows = await drizzle.funnelRepo.listByProject(
      drizzle.db,
      projectId,
    );
    const row = rows.find((f) => f.name === args.name);
    expect(row?.createdBy).toBe(userId);
    expect(row?.slug).toMatch(/mcp-funnel/);
  });

  it("create_funnel writes an audit row naming the token's owner", async () => {
    const { raw, projectId, userId } = await seedToken(
      "funnelaudit",
      "read_write",
    );
    const args = { name: `MCP Audited Funnel ${RUN_ID}` };
    const proposal = await callTool(raw, "create_funnel", args);
    const confirmed = await callTool(raw, "create_funnel", args, {
      inputResponses: {
        confirm: { action: "accept", content: { confirm: true } },
      },
      requestState: proposal.rawResult.requestState as string,
    });
    expect(confirmed.isError).toBe(false);

    const row = await latestAuditRow(projectId);
    expect(row?.userId).toBe(userId);
    expect(row?.action).toBe("funnel.created");
    expect(row?.resource).toBe("funnel");
  });

  it("create_funnel declines cleanly when the user refuses", async () => {
    const { raw, projectId } = await seedToken("funneldec", "read_write");
    const args = { name: `MCP Declined Funnel ${RUN_ID}` };
    const proposal = await callTool(raw, "create_funnel", args);
    const declined = await callTool(raw, "create_funnel", args, {
      inputResponses: { confirm: { action: "decline" } },
      requestState: proposal.rawResult.requestState as string,
    });
    expect(declined.isError).toBe(true);
    expect(
      (await drizzle.funnelRepo.listByProject(drizzle.db, projectId)).some(
        (f) => f.name === args.name,
      ),
    ).toBe(false);
  });

  it("update_funnel proposes, then renames the draft on confirmation", async () => {
    const { raw, projectId, userId } = await seedToken(
      "funneledit",
      "read_write",
    );
    const funnel = await drizzle.funnelRepo.insert(drizzle.db, {
      projectId,
      slug: `mcp-edit-${RUN_ID}`,
      name: `MCP Edit Funnel ${RUN_ID}`,
      createdBy: userId,
    });
    const args = { funnelId: funnel.id, name: `MCP Renamed ${RUN_ID}` };

    const proposal = await callTool(raw, "update_funnel", args);
    expect(proposal.isError).toBe(false);
    // The first call must NOT have changed anything.
    expect(
      (await drizzle.funnelRepo.findById(drizzle.db, funnel.id))?.name,
    ).toBe(`MCP Edit Funnel ${RUN_ID}`);
    expect(proposal.rawResult.resultType).toBe("input_required");
    expect(proposal.rawResult.inputRequests).toHaveProperty("confirm");

    const confirmed = await callTool(raw, "update_funnel", args, {
      inputResponses: {
        confirm: { action: "accept", content: { confirm: true } },
      },
      requestState: proposal.rawResult.requestState as string,
    });
    expect(confirmed.isError).toBe(false);
    const updated = await drizzle.funnelRepo.findById(
      drizzle.db,
      funnel.id,
    );
    expect(updated?.name).toBe(`MCP Renamed ${RUN_ID}`);
    // Draft-only edit: the funnel is still unpublished.
    expect(updated?.status).toBe("draft");

    const row = await latestAuditRow(projectId);
    expect(row?.userId).toBe(userId);
    expect(row?.action).toBe("funnel.updated");
    expect(row?.resource).toBe("funnel");
  });

  it("update_funnel fails closed on an unknown funnel id", async () => {
    const { raw } = await seedToken("funnelmis", "read_write");
    const args = { funnelId: "fn_missing", name: "Renamed" };
    const proposal = await callTool(raw, "update_funnel", args);
    expect(proposal.isError).toBe(false);
    const res = await callTool(raw, "update_funnel", args, {
      inputResponses: {
        confirm: { action: "accept", content: { confirm: true } },
      },
      requestState: proposal.rawResult.requestState as string,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/not found/i);
    expect(
      await drizzle.funnelRepo.findById(drizzle.db, "fn_missing"),
    ).toBeNull();
  });

  it("a confirmation echoing different args fails closed", async () => {
    const { raw, projectId, userId } = await seedToken(
      "funnelswap",
      "read_write",
    );
    const funnel = await drizzle.funnelRepo.insert(drizzle.db, {
      projectId,
      slug: `mcp-swap-${RUN_ID}`,
      name: `MCP Swap Funnel ${RUN_ID}`,
      createdBy: userId,
    });
    const proposal = await callTool(raw, "update_funnel", {
      funnelId: funnel.id,
      name: `MCP Swap A ${RUN_ID}`,
    });
    const swapped = await callTool(
      raw,
      "update_funnel",
      { funnelId: funnel.id, name: `MCP Swap B ${RUN_ID}` },
      {
        inputResponses: {
          confirm: { action: "accept", content: { confirm: true } },
        },
        requestState: proposal.rawResult.requestState as string,
      },
    );
    expect(swapped.isError).toBe(true);
    expect(swapped.text).toMatch(/does not match/i);
    expect(
      (await drizzle.funnelRepo.findById(drizzle.db, funnel.id))?.name,
    ).toBe(`MCP Swap Funnel ${RUN_ID}`);
  });

  it("a read token cannot propose a funnel create: protocol refusal, no intent row", async () => {
    const before = await countIntents();
    const { raw } = await seedToken("freadgate", "read");
    const res = await callTool(raw, "create_funnel", { name: "Whatever" });
    expect(res.isError).toBe(true);
    expect(await countIntents()).toBe(before);
  });

  it("a read token cannot propose a funnel edit: protocol refusal, no intent row", async () => {
    const before = await countIntents();
    const { raw } = await seedToken("fereadgate", "read");
    const res = await callTool(raw, "update_funnel", {
      funnelId: "whatever",
      name: "Whatever",
    });
    expect(res.isError).toBe(true);
    expect(await countIntents()).toBe(before);
  });
});

describe("MCP paywall create and edit tools", () => {
  function createArgs(offeringId: string, suffix: string) {
    return {
      identifier: `mcp-pw-${RUN_ID}-${suffix}`.toLowerCase(),
      name: `MCP Paywall ${suffix}`,
      offeringId,
      remoteConfig: { defaultLocale: "en", locales: { en: {} } },
    };
  }

  it("create_paywall proposes, then creates on confirmation", async () => {
    const { raw, projectId } = await seedToken("paywall", "read_write");
    const offering = await seedOffering(projectId, "create");
    const args = createArgs(offering.id, "create");

    const proposal = await callTool(raw, "create_paywall", args);
    expect(proposal.isError).toBe(false);
    // The first call must NOT have created anything.
    expect(
      await drizzle.paywallRepo.findPaywallByIdentifier(
        drizzle.db,
        projectId,
        args.identifier,
      ),
    ).toBeNull();
    expect(proposal.rawResult.resultType).toBe("input_required");
    expect(proposal.rawResult.inputRequests).toHaveProperty("confirm");

    const confirmed = await callTool(raw, "create_paywall", args, {
      inputResponses: {
        confirm: { action: "accept", content: { confirm: true } },
      },
      requestState: proposal.rawResult.requestState as string,
    });
    expect(confirmed.isError).toBe(false);
    const row = await drizzle.paywallRepo.findPaywallByIdentifier(
      drizzle.db,
      projectId,
      args.identifier,
    );
    expect(row?.name).toBe(args.name);
    expect(row?.offeringId).toBe(offering.id);
  });

  it("create_paywall writes an audit row naming the token's owner", async () => {
    const { raw, projectId, userId } = await seedToken(
      "paywallaudit",
      "read_write",
    );
    const offering = await seedOffering(projectId, "audit");
    const args = createArgs(offering.id, "audit");
    const proposal = await callTool(raw, "create_paywall", args);
    const confirmed = await callTool(raw, "create_paywall", args, {
      inputResponses: {
        confirm: { action: "accept", content: { confirm: true } },
      },
      requestState: proposal.rawResult.requestState as string,
    });
    expect(confirmed.isError).toBe(false);

    const row = await latestAuditRow(projectId);
    expect(row?.userId).toBe(userId);
    expect(row?.action).toBe("create");
    expect(row?.resource).toBe("paywall");
  });

  it("create_paywall declines cleanly when the user refuses", async () => {
    const { raw, projectId } = await seedToken("paywalldec", "read_write");
    const offering = await seedOffering(projectId, "decline");
    const args = createArgs(offering.id, "decline");
    const proposal = await callTool(raw, "create_paywall", args);
    const declined = await callTool(raw, "create_paywall", args, {
      inputResponses: { confirm: { action: "decline" } },
      requestState: proposal.rawResult.requestState as string,
    });
    expect(declined.isError).toBe(true);
    expect(
      await drizzle.paywallRepo.findPaywallByIdentifier(
        drizzle.db,
        projectId,
        args.identifier,
      ),
    ).toBeNull();
  });

  it("create_paywall refuses a duplicate identifier without creating", async () => {
    const { raw, projectId } = await seedToken("paywalldup", "read_write");
    const offering = await seedOffering(projectId, "dup");
    const args = createArgs(offering.id, "dup");
    const first = await callTool(raw, "create_paywall", args);
    const firstConfirmed = await callTool(raw, "create_paywall", args, {
      inputResponses: {
        confirm: { action: "accept", content: { confirm: true } },
      },
      requestState: first.rawResult.requestState as string,
    });
    expect(firstConfirmed.isError).toBe(false);

    const second = await callTool(raw, "create_paywall", args);
    const secondConfirmed = await callTool(raw, "create_paywall", args, {
      inputResponses: {
        confirm: { action: "accept", content: { confirm: true } },
      },
      requestState: second.rawResult.requestState as string,
    });
    expect(secondConfirmed.isError).toBe(true);
    expect(secondConfirmed.text).toMatch(/already in use/i);
  });

  it("create_paywall fails closed on an unknown offering", async () => {
    const { raw } = await seedToken("paywalloff", "read_write");
    const args = {
      identifier: `mcp-pw-${RUN_ID}-badoff`.toLowerCase(),
      name: "MCP Bad Offering Paywall",
      offeringId: "off_missing",
      remoteConfig: { defaultLocale: "en", locales: { en: {} } },
    };
    const proposal = await callTool(raw, "create_paywall", args);
    expect(proposal.isError).toBe(false);
    const res = await callTool(raw, "create_paywall", args, {
      inputResponses: {
        confirm: { action: "accept", content: { confirm: true } },
      },
      requestState: proposal.rawResult.requestState as string,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/unknown offering/i);
  });

  it("update_paywall proposes, then renames on confirmation", async () => {
    const { raw, projectId, userId } = await seedToken(
      "paywalledit",
      "read_write",
    );
    const offering = await seedOffering(projectId, "edit");
    const paywall = await seedPaywall(projectId, offering.id, "edit");
    const args = { paywallId: paywall.id, name: `MCP Renamed ${RUN_ID}` };

    const proposal = await callTool(raw, "update_paywall", args);
    expect(proposal.isError).toBe(false);
    // The first call must NOT have changed anything.
    expect(
      (await drizzle.paywallRepo.findPaywallById(
        drizzle.db,
        projectId,
        paywall.id,
      ))?.name,
    ).toBe(`MCP Paywall edit`);
    expect(proposal.rawResult.resultType).toBe("input_required");
    expect(proposal.rawResult.inputRequests).toHaveProperty("confirm");

    const confirmed = await callTool(raw, "update_paywall", args, {
      inputResponses: {
        confirm: { action: "accept", content: { confirm: true } },
      },
      requestState: proposal.rawResult.requestState as string,
    });
    expect(confirmed.isError).toBe(false);
    const updated = await drizzle.paywallRepo.findPaywallById(
      drizzle.db,
      projectId,
      paywall.id,
    );
    expect(updated?.name).toBe(`MCP Renamed ${RUN_ID}`);

    const row = await latestAuditRow(projectId);
    expect(row?.userId).toBe(userId);
    expect(row?.action).toBe("update");
    expect(row?.resource).toBe("paywall");
  });

  it("update_paywall fails closed on an unknown paywall id", async () => {
    const { raw } = await seedToken("paywallmis", "read_write");
    const args = { paywallId: "pw_missing", name: "Renamed" };
    const proposal = await callTool(raw, "update_paywall", args);
    expect(proposal.isError).toBe(false);
    const res = await callTool(raw, "update_paywall", args, {
      inputResponses: {
        confirm: { action: "accept", content: { confirm: true } },
      },
      requestState: proposal.rawResult.requestState as string,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/not found/i);
  });

  it("update_paywall refuses an identifier change (immutable)", async () => {
    const { raw, projectId } = await seedToken("paywallimm", "read_write");
    const offering = await seedOffering(projectId, "imm");
    const paywall = await seedPaywall(projectId, offering.id, "imm");
    const args = { paywallId: paywall.id, identifier: "different-id" };
    const proposal = await callTool(raw, "update_paywall", args);
    expect(proposal.isError).toBe(false);
    const res = await callTool(raw, "update_paywall", args, {
      inputResponses: {
        confirm: { action: "accept", content: { confirm: true } },
      },
      requestState: proposal.rawResult.requestState as string,
    });
    expect(res.isError).toBe(true);
    expect(res.text).toMatch(/immutable/i);
    expect(
      (await drizzle.paywallRepo.findPaywallById(
        drizzle.db,
        projectId,
        paywall.id,
      ))?.identifier,
    ).toBe(paywall.identifier);
  });

  it("a confirmation echoing different args fails closed", async () => {
    const { raw, projectId } = await seedToken("paywallswap", "read_write");
    const offering = await seedOffering(projectId, "swap");
    const paywall = await seedPaywall(projectId, offering.id, "swap");
    const proposal = await callTool(raw, "update_paywall", {
      paywallId: paywall.id,
      name: `MCP Swap A ${RUN_ID}`,
    });
    const swapped = await callTool(
      raw,
      "update_paywall",
      { paywallId: paywall.id, name: `MCP Swap B ${RUN_ID}` },
      {
        inputResponses: {
          confirm: { action: "accept", content: { confirm: true } },
        },
        requestState: proposal.rawResult.requestState as string,
      },
    );
    expect(swapped.isError).toBe(true);
    expect(swapped.text).toMatch(/does not match/i);
    expect(
      (await drizzle.paywallRepo.findPaywallById(
        drizzle.db,
        projectId,
        paywall.id,
      ))?.name,
    ).toBe(`MCP Paywall swap`);
  });

  it("a read token cannot propose a paywall create: protocol refusal, no intent row", async () => {
    const before = await countIntents();
    const { raw, projectId } = await seedToken("preadgate", "read");
    const offering = await seedOffering(projectId, "readgate");
    const res = await callTool(raw, "create_paywall", createArgs(offering.id, "readgate"));
    expect(res.isError).toBe(true);
    expect(await countIntents()).toBe(before);
  });

  it("a read token cannot propose a paywall edit: protocol refusal, no intent row", async () => {
    const before = await countIntents();
    const { raw } = await seedToken("pereadgate", "read");
    const res = await callTool(raw, "update_paywall", {
      paywallId: "whatever",
      name: "Whatever",
    });
    expect(res.isError).toBe(true);
    expect(await countIntents()).toBe(before);
  });
});
