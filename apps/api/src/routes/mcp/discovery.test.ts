import { describe, expect, it } from "vitest";
import {
  CLIENT_CAPABILITIES_META_KEY,
  CLIENT_INFO_META_KEY,
  PROTOCOL_VERSION_META_KEY,
} from "@modelcontextprotocol/server";
import { app } from "../../app";
import { MCP_PROTOCOL_REVISION } from "../../services/mcp/server";

const FORBIDDEN = 403;
const DISALLOWED_ORIGIN = "https://evil.example";

const DISCOVER_HEADERS = {
  "content-type": "application/json",
  // Without both media types the entry answers 406 before routing.
  accept: "application/json, text/event-stream",
  // Must agree with the body's method; a mismatch is rejected (-32020).
  "mcp-method": "server/discover",
};

/**
 * A modern (2026-07-28) `server/discover` probe: the per-request `_meta`
 * envelope claim is what routes past the legacy fallback. A claim-less
 * POST is 2025-era traffic and is rejected by this strict endpoint, so it
 * cannot be the discovery probe.
 */
function discoverBody(id: number): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    method: "server/discover",
    params: {
      _meta: {
        [PROTOCOL_VERSION_META_KEY]: MCP_PROTOCOL_REVISION,
        [CLIENT_INFO_META_KEY]: { name: "discovery-test", version: "0.0.1" },
        [CLIENT_CAPABILITIES_META_KEY]: {},
      },
    },
  });
}

describe("POST /mcp discovery", () => {
  it("rejects a request carrying a disallowed Origin", async () => {
    const res = await app.request("/mcp", {
      method: "POST",
      headers: {
        ...DISCOVER_HEADERS,
        origin: DISALLOWED_ORIGIN,
      },
      body: discoverBody(1),
    });
    expect(res.status).toBe(FORBIDDEN);
  });

  it("declares only the primitives it implements", async () => {
    // Prompts are deliberately out of scope (design spec, D4a). The server
    // must not advertise a primitive it does not serve — a client that sees
    // `prompts` will call `prompts/list` and get a protocol error.
    const res = await app.request("/mcp", {
      method: "POST",
      headers: DISCOVER_HEADERS,
      body: discoverBody(1),
    });
    const body = (await res.json()) as {
      result?: { capabilities?: Record<string, unknown> };
    };
    const declared = Object.keys(body.result?.capabilities ?? {});
    expect(declared).toContain("tools");
    expect(declared).toContain("resources");
    expect(declared).not.toContain("prompts");
  });
});
