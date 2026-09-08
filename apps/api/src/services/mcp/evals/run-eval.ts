// =============================================================
// MCP tool-selection eval runner (plan Task 11, manual instrument).
//
// Drives a model against the SERVED tool list and reports which tool
// it picked per question in evals/tool-selection.md. Not a CI gate:
// model choice is not deterministic.
//
//   pnpm --filter @rovenue/api eval:mcp
//
// Requires ROVI_DEFAULT_PROVIDER + ROVI_DEFAULT_MODEL +
// ROVI_DEFAULT_API_KEY (env-source provider, no database — BYOK lookup
// is stubbed to null). The served manifest comes from a per-request
// server over linked in-memory transports, so the eval always reflects
// the code as built, with no database and no HTTP layer.
// =============================================================

import { generateText, jsonSchema, stepCountIs, tool } from "ai";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import {
  buildAiSdkModel,
  resolveProviderForProject,
} from "../../copilot/providers";
import { buildMcpServer } from "../server";
import { env } from "../../../lib/env";

const QUESTIONS: Array<{ question: string; expected: string }> = [
  { question: "Which experiment is winning?", expected: "list_experiments" },
  {
    question: "Find the subscriber with id sub_123",
    expected: "find_subscribers",
  },
  { question: "What does my paywall look like?", expected: "get_paywall" },
  { question: "How many funnels do I have?", expected: "find_funnels" },
  { question: "Stop the pricing experiment", expected: "stop_experiment" },
  { question: "Start the onboarding experiment", expected: "start_experiment" },
  { question: "What products are in the catalog?", expected: "list_catalog" },
  { question: "Which audiences exist?", expected: "list_audiences" },
  { question: "What feature flags are on?", expected: "list_feature_flags" },
  { question: "Show me active subscriptions", expected: "list_subscriptions" },
];

interface ServedTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
}

async function servedTools(): Promise<ServedTool[]> {
  const server = buildMcpServer({
    authInfo: {
      token: "eval",
      clientId: "eval-user",
      scopes: ["read"],
      extra: { projectId: "eval-project", role: "ADMIN" },
    },
  } as never);
  const [mine, theirs] = InMemoryTransport.createLinkedPair();
  await server.connect(theirs);
  const pending = new Map<number, (m: never) => void>();
  mine.onmessage = (m) => {
    const id = (m as { id?: unknown }).id;
    if (typeof id === "number") pending.get(id)?.(m as never);
  };
  await mine.start();
  let nextId = 0;
  const call = (method: string, params: unknown) =>
    new Promise<{ result?: Record<string, unknown>; error?: unknown }>(
      (resolve, reject) => {
        nextId += 1;
        const id = nextId;
        const timer = setTimeout(
          () => reject(new Error(`no response for ${method}`)),
          10000,
        );
        pending.set(id, (m) => {
          clearTimeout(timer);
          pending.delete(id);
          resolve(m as { result?: Record<string, unknown>; error?: unknown });
        });
        void mine.send({ jsonrpc: "2.0", id, method, params } as never);
      },
    );
  const init = await call("initialize", {
    protocolVersion: "2026-07-28",
    capabilities: {},
    clientInfo: { name: "mcp-eval", version: "0.0.1" },
  });
  if (init.error) throw new Error("eval: initialize failed");
  const list = await call("tools/list", {});
  await server.close();
  if (list.error || !list.result) throw new Error("eval: tools/list failed");
  return (list.result.tools ?? []) as ServedTool[];
}

async function main(): Promise<void> {
  const resolved = await resolveProviderForProject({
    projectId: "eval",
    loadCreds: async () => null,
    env: {
      ROVI_DEFAULT_PROVIDER: env.ROVI_DEFAULT_PROVIDER,
      ROVI_DEFAULT_MODEL: env.ROVI_DEFAULT_MODEL,
      ROVI_DEFAULT_API_KEY: env.ROVI_DEFAULT_API_KEY,
      ROVI_DEFAULT_BASE_URL: env.ROVI_DEFAULT_BASE_URL,
    },
  });
  const model = buildAiSdkModel(resolved);
  const manifest = await servedTools();
  // The eval measures SELECTION, never execution: every served tool is
  // re-declared with a canonical execute that touches no database.
  const tools = Object.fromEntries(
    manifest.map((t) => [
      t.name,
      tool({
        description: t.description ?? t.name,
        inputSchema: jsonSchema(
          (t.inputSchema ?? { type: "object" }) as Parameters<
            typeof jsonSchema
          >[0],
        ),
        execute: async () => ({ eval: `selected ${t.name}` }),
      }),
    ]),
  );

  let hits = 0;
  for (const { question, expected } of QUESTIONS) {
    const { toolCalls } = await generateText({
      model,
      tools,
      stopWhen: stepCountIs(1),
      prompt:
        `You are a Rovenue project assistant. Use exactly one tool. ` +
        `Question: ${question}`,
    });
    const picked = toolCalls[0]?.toolName ?? "(no tool call)";
    const ok = picked === expected;
    if (ok) hits += 1;
    console.log(`${ok ? "HIT " : "MISS"} ${picked} (expected ${expected}) — ${question}`);
  }
  console.log(`\n${hits}/${QUESTIONS.length} selections match.`);
}

void main().catch((err: unknown) => {
  console.error(
    `eval failed: ${err instanceof Error ? err.message : String(err)}`,
  );
  process.exit(1);
});
