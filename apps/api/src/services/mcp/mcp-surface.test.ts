// =============================================================
// MCP surface guard (plan Task 11).
//
// Structural: fails on a change made months from now by someone who
// never read the plan. Prompts are deliberately out of A (spec D4a) —
// a server advertising `prompts` makes clients call prompts/list and
// get a protocol error.
//
// DB-free by construction: the guard drives a per-request server over
// linked in-memory transports with a stub authInfo (auth is the HTTP
// layer's job, covered by the auth tests). Registration is pure — no
// tool body runs here, so no database is touched.
//
// The `initialize` handshake below is SDK transport setup, not an
// HTTP-era claim: the public endpoint serves `server/discover` and
// rejects the retired `initialize` (covered by the discovery tests).
// What this guard pins is OUR registrations (tools/resources/prompts)
// as the SDK serves them from the same factory the handler uses.
// =============================================================

import { describe, expect, it } from "vitest";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { buildMcpServer } from "./server";
import {
  MCP_SCOPE_READ,
  assertToolAllowed,
} from "./authorize";

/** Task 9 established this name from the specification schema. */
const DESTRUCTIVE_ANNOTATION = "destructiveHint";

const WRITE_TOOLS = new Set([
  "start_experiment",
  "stop_experiment",
  "create_product",
  "create_offering",
  "create_entitlement",
  "create_placement",
  "create_audience",
  "delete_asset",
  "create_virtual_currency",
]);

const EXPECTED_TOOLS = [
  "find_subscribers",
  "list_subscriptions",
  "list_catalog",
  "list_audiences",
  "list_feature_flags",
  "list_experiments",
  "find_funnels",
  "get_paywall",
  "start_experiment",
  "stop_experiment",
  "create_product",
  "create_offering",
  "create_entitlement",
  "create_placement",
  "create_audience",
  "delete_asset",
  "create_virtual_currency",
];

const EXPECTED_RESOURCES = [
  "rovenue://catalog/products",
  "rovenue://experiments",
];

const EXPECTED_TEMPLATES = ["rovenue://paywall/{id}"];

interface LocalServer {
  call: (method: string, params: unknown) => Promise<{
    result?: Record<string, unknown>;
    error?: { code?: number; message?: string };
  }>;
  close: () => Promise<void>;
}

async function serveLocally(): Promise<LocalServer> {
  const server = buildMcpServer({
    authInfo: {
      token: "surface-guard",
      clientId: "surface-guard-user",
      scopes: [MCP_SCOPE_READ],
      extra: { projectId: "surface-guard-project", role: "ADMIN" },
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
  const call: LocalServer["call"] = (method, params) =>
    new Promise((resolve, reject) => {
      nextId += 1;
      const id = nextId;
      const timer = setTimeout(
        () => reject(new Error(`no response for ${method}`)),
        5000,
      );
      pending.set(id, (m) => {
        clearTimeout(timer);
        pending.delete(id);
        resolve(
          m as {
            result?: Record<string, unknown>;
            error?: { code?: number; message?: string };
          },
        );
      });
      void mine.send({ jsonrpc: "2.0", id, method, params } as never);
    });
  const init = await call("initialize", {
    protocolVersion: "2026-07-28",
    capabilities: {},
    clientInfo: { name: "surface-guard", version: "0.0.1" },
  });
  if (init.error) throw new Error("initialize failed in surface guard");
  return { call, close: () => server.close() };
}

describe("MCP surface guard", () => {
  it("declares no primitive it does not implement", async () => {
    const { call, close } = await serveLocally();
    try {
      const tools = await call("tools/list", {});
      const resources = await call("resources/list", {});
      const templates = await call("resources/templates/list", {});
      const prompts = await call("prompts/list", {});

      // Declared primitives list successfully and are non-degenerate.
      expect(tools.error).toBeUndefined();
      const names = (
        tools.result?.tools as Array<{ name: string }> | undefined
      )?.map((t) => t.name);
      expect(names?.sort()).toEqual([...EXPECTED_TOOLS].sort());

      expect(resources.error).toBeUndefined();
      const uris = (
        resources.result?.resources as Array<{ uri: string }> | undefined
      )?.map((r) => r.uri);
      expect(uris?.sort()).toEqual([...EXPECTED_RESOURCES].sort());

      expect(templates.error).toBeUndefined();
      const tpl = (
        templates.result?.resourceTemplates as
          | Array<{ uriTemplate: string }>
          | undefined
      )?.map((t) => t.uriTemplate);
      expect(tpl?.sort()).toEqual([...EXPECTED_TEMPLATES].sort());

      // Prompts are out of A: undeclared, so the call is a protocol
      // error rather than an empty list a client would misread.
      expect(prompts.result).toBeUndefined();
      expect(prompts.error?.code).toBe(-32601);
    } finally {
      await close();
    }
  });

  it("every write tool is scope-gated and annotated", async () => {
    const { call, close } = await serveLocally();
    try {
      const tools = await call("tools/list", {});
      const listed = (tools.result?.tools ?? []) as Array<{
        name: string;
        annotations?: Record<string, unknown>;
      }>;
      const byName = new Map(listed.map((t) => [t.name, t]));
      for (const name of WRITE_TOOLS) {
        // Served, so the gate below is about a real tool, not a typo
        // that passes by enumerating nothing.
        expect(byName.has(name)).toBe(true);
        // A read token is refused before the tool body runs (the route
        // calls the same pure gate pre-dispatch).
        expect(() =>
          assertToolAllowed(
            { tokenId: "t", projectId: "p", userId: "u", scope: MCP_SCOPE_READ },
            name,
          ),
        ).toThrow();
        // The served annotations name the destructive hint (Task 9).
        expect(byName.get(name)?.annotations).toHaveProperty(
          DESTRUCTIVE_ANNOTATION,
        );
      }
    } finally {
      await close();
    }
  });
});
